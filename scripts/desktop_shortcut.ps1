# Write the shortcut to the review folder by default so Explorer can pin it to the taskbar.
param(
  [Parameter(Mandatory)][string]$Root,
  [string]$Lnk = (Join-Path $Root 'Asset Review.lnk'),
  [string]$AppId = 'Chrome.127.0.0.1_/'
)
$installRoot = Split-Path $PSScriptRoot
$py = (Get-Command python.exe).Source
$pyw = Join-Path (Split-Path $py) 'pythonw.exe'
if ($Lnk -like "$env:APPDATA*" -or $Lnk -like "$env:LOCALAPPDATA*") { Write-Warning 'A packaged host may write AppData shortcuts into storage that Explorer cannot see.' }
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class ReviewLnk {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink {}
  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int n, IntPtr fd, uint fl); void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n); void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n); void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n); void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetHotkey(out short k); void SetHotkey(short k); void GetShowCmd(out int c); void SetShowCmd(int c);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n, out int i); void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string s, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string s, uint r); void Resolve(IntPtr h, uint f); void SetPath([MarshalAs(UnmanagedType.LPWStr)] string s);
  }
  [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPersistFile { void GetClassID(out Guid g); [PreserveSig] int IsDirty(); void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint m);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string f, bool r); void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f); void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f); }
  [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public IntPtr p2; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { void GetCount(out uint c); void GetAt(uint i, out PROPERTYKEY k); void GetValue(ref PROPERTYKEY k, out PROPVARIANT v); void SetValue(ref PROPERTYKEY k, ref PROPVARIANT v); void Commit(); }
  public static void Create(string lnk, string target, string args, string icon, string appId, string workdir) {
    var sl = (IShellLinkW)new ShellLink();
    sl.SetPath(target); sl.SetArguments(args); sl.SetIconLocation(icon, 0); sl.SetDescription("Asset review"); sl.SetWorkingDirectory(workdir);
    var key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };  // System.AppUserModel.ID
    var v = new PROPVARIANT { vt = 31, p = Marshal.StringToCoTaskMemUni(appId) };
    var ps = (IPropertyStore)sl; ps.SetValue(ref key, ref v); ps.Commit(); Marshal.FreeCoTaskMem(v.p);
    ((IPersistFile)sl).Save(lnk, true);
  }
}
'@
$app = Join-Path $PSScriptRoot 'desktop_app.pyw'
[ReviewLnk]::Create($Lnk, $pyw, ('"{0}" --root "{1}"' -f $app, $Root), (Join-Path $installRoot 'assets\viewer\favicon.ico'), $AppId, $PSScriptRoot)
"SHORTCUT $Lnk"

