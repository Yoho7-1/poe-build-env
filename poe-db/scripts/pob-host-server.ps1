param([Parameter(Mandatory=$true)][string]$RuntimeDirectory, [Parameter(Mandatory=$true)][string]$HostDirectory, [int]$IdleSeconds = 600)
$ErrorActionPreference = 'Stop'
# Persistent PoB host (pob-pool.mjs). Same pinned LuaJIT runtime and Lua C API as pob-host.ps1, but the Lua state
# lives for many calculations: launch.lua in HostDirectory loads PoB once and defines AGENT_SERVE/AGENT_RESET
# (pob-worker.lua, persistent mode). Protocol, all files in HostDirectory (relative to the PoB source directory):
#   heartbeat  touched every second by a timer thread, also while Lua is calculating (liveness for clients)
#   ready      written once PoB is loaded: "<pid>"
#   lock       held by the client that owns the host for one request (the host only creates it to retire)
#   request    "<id>\n<request.json path>" written by the client (atomic rename)
#   response   "<id>\nOK" or "<id>\nERROR\n<Lua error>" written by the host (atomic rename)
#   failed     reason the host stopped (start-up or reset failure)
#   stop       asks the host to exit when idle
# After every response the host calls AGENT_RESET; a failed reset ends the process. The host exits after
# IdleSeconds without requests and deletes HostDirectory.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class PoeLuaServer {
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetDllDirectory(string path);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibrary(string path);
  [DllImport("winmm")] static extern uint timeBeginPeriod(uint period);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern IntPtr luaL_newstate();
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern void luaL_openlibs(IntPtr L);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern int luaL_loadbuffer(IntPtr L, byte[] data, UIntPtr size, string name);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern int lua_pcall(IntPtr L, int args, int results, int handler);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern IntPtr lua_tolstring(IntPtr L, int index, out UIntPtr length);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern void lua_getfield(IntPtr L, int index, string key);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern void lua_pushlstring(IntPtr L, byte[] s, UIntPtr length);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern void lua_settop(IntPtr L, int index);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern void lua_close(IntPtr L);
  const int LUA_GLOBALSINDEX = -10002;
  static string Utf8(IntPtr p, UIntPtr n) {
    if (p == IntPtr.Zero) return "(non-string Lua error)";
    int length = checked((int)n.ToUInt64());
    byte[] buffer = new byte[length];
    Marshal.Copy(p, buffer, 0, length);
    return Encoding.UTF8.GetString(buffer);
  }
  static string PopError(IntPtr L) { UIntPtr n; IntPtr p = lua_tolstring(L, -1, out n); string s = Utf8(p, n); lua_settop(L, 0); return s; }
  // Calls global function `name` with an optional string argument; returns null or the Lua error.
  static string Call(IntPtr L, string name, string arg) {
    lua_getfield(L, LUA_GLOBALSINDEX, name);
    int args = 0;
    if (arg != null) { byte[] b = Encoding.UTF8.GetBytes(arg); lua_pushlstring(L, b, (UIntPtr)b.Length); args = 1; }
    int error = lua_pcall(L, args, 0, 0);
    if (error != 0) return PopError(L);
    lua_settop(L, 0);
    return null;
  }
  static void WriteAtomic(string dir, string name, string text) {
    string tmp = Path.Combine(dir, name + ".tmp");
    File.WriteAllText(tmp, text, new UTF8Encoding(false));
    string target = Path.Combine(dir, name);
    if (File.Exists(target)) File.Delete(target);
    File.Move(tmp, target);
  }
  // True when the host could take the lock itself, i.e. no client owns it and none can claim it any more.
  static bool Retire(string dir) {
    try { using (new FileStream(Path.Combine(dir, "lock"), FileMode.CreateNew, FileAccess.Write)) { } return true; }
    catch (IOException) { return false; }
  }
  public static int Serve(string runtime, string dir, int idleSeconds) {
    string heartbeat = Path.Combine(dir, "heartbeat");
    File.WriteAllText(heartbeat, "");
    Timer timer = new Timer(_ => { try { File.SetLastWriteTimeUtc(heartbeat, DateTime.UtcNow); } catch { } }, null, 0, 1000);
    timeBeginPeriod(1);
    SetDllDirectory(runtime);
    if (LoadLibrary(Path.Combine(runtime, "lua51.dll")) == IntPtr.Zero) throw new Exception("Cannot load pinned Lua runtime: " + Marshal.GetLastWin32Error());
    IntPtr L = luaL_newstate();
    if (L == IntPtr.Zero) throw new Exception("Lua state allocation failed");
    try {
      luaL_openlibs(L);
      byte[] bytes = File.ReadAllBytes(Path.Combine(dir, "launch.lua"));
      int error = luaL_loadbuffer(L, bytes, (UIntPtr)bytes.Length, "@poe-agent");
      if (error == 0) error = lua_pcall(L, 0, 0, 0);
      if (error != 0) { WriteAtomic(dir, "failed", "start-up: " + PopError(L)); return 2; }
      WriteAtomic(dir, "ready", Process.GetCurrentProcess().Id.ToString());
      string requestFile = Path.Combine(dir, "request"), stopFile = Path.Combine(dir, "stop");
      DateTime last = DateTime.UtcNow;
      while (true) {
        if (File.Exists(requestFile)) {
          string text = File.ReadAllText(requestFile, Encoding.UTF8);
          File.Delete(requestFile);
          int cut = text.IndexOf('\n');
          string id = cut < 0 ? "" : text.Substring(0, cut), path = cut < 0 ? text : text.Substring(cut + 1);
          string err = Call(L, "AGENT_SERVE", path.Trim());
          WriteAtomic(dir, "response", id + "\n" + (err == null ? "OK" : "ERROR\n" + err));
          string reset = Call(L, "AGENT_RESET", null);
          if (reset != null) { WriteAtomic(dir, "failed", "reset: " + reset); return 3; }
          last = DateTime.UtcNow;
          continue;
        }
        double idle = (DateTime.UtcNow - last).TotalSeconds;
        if (!Directory.Exists(dir)) return 0;
        if ((idle > idleSeconds || File.Exists(stopFile)) && Retire(dir)) return 0;
        Thread.Sleep(idle < 5 ? 1 : 10);
      }
    } finally {
      lua_close(L);
      timer.Dispose();
    }
  }
}
'@
$dir = [IO.Path]::GetFullPath($HostDirectory)
$code = 1
try { $code = [PoeLuaServer]::Serve([IO.Path]::GetFullPath($RuntimeDirectory), $dir, $IdleSeconds) }
catch {
  $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
  [Console]::Error.WriteLine('Lua host error: ' + $e.Message)
  try { [IO.File]::WriteAllText([IO.Path]::Combine($dir, 'failed'), 'host: ' + $e.Message) } catch {}
}
# A retired or failed host removes its directory; a client that still sees it treats it as dead.
if ($code -eq 0) { try { [IO.Directory]::Delete($dir, $true) } catch {} }
exit $code
