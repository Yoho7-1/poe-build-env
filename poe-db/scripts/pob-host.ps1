param([Parameter(Mandatory=$true)][string]$RuntimeDirectory, [Parameter(Mandatory=$true)][string]$ScriptFile)
$ErrorActionPreference = 'Stop'
# Compatible with Windows PowerShell 5.1 (.NET Framework, C# 5) and PowerShell 7+.
# The pinned PoB runtime supplies LuaJIT's Lua 5.1 C API. No GUI or global install.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
public static class PoeLuaHost {
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetDllDirectory(string path);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibrary(string path);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern IntPtr luaL_newstate();
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern void luaL_openlibs(IntPtr L);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern int luaL_loadbuffer(IntPtr L, byte[] data, UIntPtr size, string name);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern int lua_pcall(IntPtr L, int args, int results, int handler);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern IntPtr lua_tolstring(IntPtr L, int index, out UIntPtr length);
  [DllImport("lua51", CallingConvention=CallingConvention.Cdecl)] static extern void lua_close(IntPtr L);
  static string Utf8(IntPtr p, UIntPtr n) {
    if (p == IntPtr.Zero) return "(non-string Lua error)";
    int length = checked((int)n.ToUInt64());
    byte[] buffer = new byte[length];
    Marshal.Copy(p, buffer, 0, length);
    return Encoding.UTF8.GetString(buffer);
  }
  public static void Run(string runtime, string script) {
    SetDllDirectory(runtime);
    if (LoadLibrary(Path.Combine(runtime,"lua51.dll")) == IntPtr.Zero) throw new Exception("Cannot load pinned Lua runtime: " + Marshal.GetLastWin32Error());
    IntPtr state = luaL_newstate();
    if (state == IntPtr.Zero) throw new Exception("Lua state allocation failed");
    try {
      luaL_openlibs(state);
      byte[] bytes = File.ReadAllBytes(script);
      int error = luaL_loadbuffer(state, bytes, (UIntPtr)bytes.Length, "@poe-agent");
      if (error == 0) error = lua_pcall(state, 0, 0, 0);
      if (error != 0) { UIntPtr n; IntPtr p = lua_tolstring(state, -1, out n); throw new Exception(Utf8(p, n)); }
    } finally { lua_close(state); }
  }
}
'@
try { [PoeLuaHost]::Run([IO.Path]::GetFullPath($RuntimeDirectory), [IO.Path]::GetFullPath($ScriptFile)) }
catch {
  $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
  [Console]::Error.WriteLine('Lua host error: ' + $e.Message); exit 1
}
