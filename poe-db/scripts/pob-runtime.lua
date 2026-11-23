-- Missing native services used by PoB's public headless wrapper. Read-only file
-- metadata is implemented only for the installed Timeless dataset directory.
local ffi=require('ffi')
ffi.cdef[[
int uncompress(unsigned char *dest, unsigned long *destLen, const unsigned char *source, unsigned long sourceLen);
typedef struct { unsigned int low; unsigned int high; } POE_FILETIME;
typedef struct { unsigned int attributes; POE_FILETIME creation,access,modified; unsigned int sizeHigh,sizeLow,reserved0,reserved1; char name[260];char alternate[14]; } POE_FIND_DATA;
void* FindFirstFileA(const char *pattern, POE_FIND_DATA *data);
int FindNextFileA(void *handle, POE_FIND_DATA *data);
int FindClose(void *handle);
]]
local zlib=ffi.load('../runtime/zlib1.dll')
function Inflate(data)
  assert(type(data)=='string','Inflate requires bytes')
  local capacity=math.max(1048576,math.min(#data*4,16777216))
  while capacity<=536870912 do
    local buffer=ffi.new('unsigned char[?]',capacity)
    local length=ffi.new('unsigned long[1]',capacity)
    local status=zlib.uncompress(buffer,length,data,#data)
    if status==0 then return ffi.string(buffer,tonumber(length[0])) end
    assert(status==-5,'zlib inflate failed with code '..status)
    buffer=nil;collectgarbage('collect');capacity=capacity*2
  end
  error('Timeless inflate exceeds the 512 MiB resource limit')
end
local oldSearch=NewFileSearch
local kernel=ffi.load('kernel32')
local invalid=ffi.cast('void*',-1)
function NewFileSearch(pattern,...)
  if not pattern:gsub('\\','/'):find('Data/TimelessJewelData/',1,true) then return oldSearch(pattern,...) end
  local data=ffi.new('POE_FIND_DATA[1]')
  local handle=kernel.FindFirstFileA(pattern,data)
  if handle==invalid then return nil end
  local name=ffi.string(data[0].name)
  local newest=0
  repeat
    newest=math.max(newest,tonumber(data[0].modified.high)*4294967296+tonumber(data[0].modified.low))
  until kernel.FindNextFileA(handle,data)==0
  kernel.FindClose(handle)
  return {GetFileName=function()return name end,GetFileModifiedTime=function()return newest end}
end
