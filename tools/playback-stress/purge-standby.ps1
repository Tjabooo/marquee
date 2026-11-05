# Empties Windows' standby list (the file cache) so a test run reads from disk, not RAM. Needs admin.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class Purge {
  [DllImport("ntdll.dll")] static extern int NtSetSystemInformation(int cls, ref int info, int len);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr h, int acc, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool LookupPrivilegeValue(string s, string n, out long luid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr t, bool d, ref TP n, int l, IntPtr p, IntPtr r);
  [StructLayout(LayoutKind.Sequential, Pack=1)] struct TP { public int Count; public long Luid; public int Attr; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static int Run() {
    IntPtr tok; OpenProcessToken(GetCurrentProcess(), 0x28, out tok);
    TP tp = new TP { Count = 1, Attr = 2 }; LookupPrivilegeValue(null, "SeProfileSingleProcessPrivilege", out tp.Luid);
    AdjustTokenPrivileges(tok, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
    int cmd = 4; // MemoryPurgeStandbyList
    return NtSetSystemInformation(80, ref cmd, 4);
  }
}
'@
$r = [Purge]::Run()
if ($r -ne 0) { Write-Error ("NtSetSystemInformation failed: 0x{0:X}" -f $r) } else { 'standby list purged' }
