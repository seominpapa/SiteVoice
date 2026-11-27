param(
  [Parameter(Mandatory = $true)][ValidateSet('open', 'shortcut', 'read', 'close')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Target
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ($Action -eq 'close') {
  $owned = Get-Process -Id ([int]$Target) -ErrorAction SilentlyContinue
  if ($owned -and $owned.ProcessName -eq 'Notepad') { Stop-Process -InputObject $owned }
  exit
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NotepadDesktop {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out int process);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll")] private static extern bool OpenProcessToken(IntPtr process, uint rights, out IntPtr token);
  [DllImport("advapi32.dll")] private static extern bool GetTokenInformation(IntPtr token, int type, IntPtr data, int bytes, out int written);
  [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

  public static int IntegrityRid(int pid) {
    IntPtr process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (process == IntPtr.Zero) return 0;
    try {
      IntPtr token;
      if (!OpenProcessToken(process, 8, out token)) return 0; // TOKEN_QUERY
      try {
        int size;
        GetTokenInformation(token, 25, IntPtr.Zero, 0, out size); // TokenIntegrityLevel
        if (size <= 0) return 0;
        IntPtr data = Marshal.AllocHGlobal(size);
        try {
          if (!GetTokenInformation(token, 25, data, size, out size)) return 0;
          IntPtr sid = Marshal.ReadIntPtr(data); // TOKEN_MANDATORY_LABEL begins with a SID pointer.
          byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
          return count == 0 ? 0 : Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
        } finally { Marshal.FreeHGlobal(data); }
      } finally { CloseHandle(token); }
    } finally { CloseHandle(process); }
  }
}
'@

function Get-ForegroundId {
  $foreground = 0
  [void][NotepadDesktop]::GetWindowThreadProcessId([NotepadDesktop]::GetForegroundWindow(), [ref]$foreground)
  $foreground
}

function Start-ProbeNotepad([string]$Document) {
  $notepad = "$env:SystemRoot\System32\notepad.exe"
  $argument = '"' + $Document + '"'
  $ownIntegrity = [NotepadDesktop]::IntegrityRid($PID)
  if (!$ownIntegrity) { throw 'Could not read the test process integrity.' }
  if ($ownIntegrity -lt 0x3000) {
    Start-Process -FilePath $notepad -ArgumentList $argument
    return
  }

  # An elevated CI task can ask its existing unelevated desktop shell to launch the editor.
  $session = (Get-Process -Id $PID).SessionId
  $explorer = Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object {
    $rid = [NotepadDesktop]::IntegrityRid($_.Id)
    $_.SessionId -eq $session -and $rid -gt 0 -and $rid -lt 0x3000
  } | Select-Object -First 1
  if (!$explorer) { throw 'No unelevated Explorer desktop is available. Run the test from an interactive standard Windows desktop.' }
  try {
    $shell = New-Object -ComObject Shell.Application
    $loc = 0
    $root = 0
    $desktopWindow = 0
    $desktop = $shell.Windows().FindWindowSW([ref]$loc, [ref]$root, 8, [ref]$desktopWindow, 1) # SWC_DESKTOP, SWFO_NEEDDISPATCH
    $desktop.Document.Application.ShellExecute($notepad, $argument, '', 'open', 1)
  } catch {
    throw "Notepad could not be launched through the unelevated desktop shell: $($_.Exception.Message)"
  }
}

if ($Action -eq 'open') {
  # Do not access any existing document. Run on a disposable Windows desktop.
  if (Get-Process -Name Notepad -ErrorAction SilentlyContinue) { throw 'Close Notepad before running this test.' }
  $leaf = [IO.Path]::GetFileNameWithoutExtension($Target)
  Start-ProbeNotepad $Target
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  do {
    $editor = Get-Process -Name Notepad -ErrorAction SilentlyContinue | Where-Object {
      $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*$leaf*"
    } | Select-Object -First 1
    if ($editor -and (Get-ForegroundId) -ne $editor.Id) {
      [void][NotepadDesktop]::SetForegroundWindow($editor.MainWindowHandle)
    }
    if ($editor -and (Get-ForegroundId) -eq $editor.Id) {
      $focus = [System.Windows.Automation.AutomationElement]::FocusedElement
      if ($focus -and $focus.Current.ProcessId -eq $editor.Id -and
          ($focus.Current.ControlType -in @([System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::Document))) {
        [System.Windows.Forms.SendKeys]::SendWait('{HOME}{RIGHT 8}')
        @{pid = $editor.Id; integrity = [NotepadDesktop]::IntegrityRid($editor.Id); className = $focus.Current.ClassName} |
          ConvertTo-Json -Compress
        exit
      }
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'The disposable Notepad document did not gain editor focus.'
}

if ((Get-ForegroundId) -ne [int]$Target) { throw 'The test Notepad window lost foreground focus.' }
if ($Action -eq 'shortcut') {
  [NotepadDesktop]::keybd_event(0x78, 0, 0, [UIntPtr]::Zero) # VK_F9 down
  [NotepadDesktop]::keybd_event(0x78, 0, 2, [UIntPtr]::Zero) # KEYEVENTF_KEYUP
  exit
}

$focus = [System.Windows.Automation.AutomationElement]::FocusedElement
if (!$focus -or $focus.Current.ProcessId -ne [int]$Target) { throw 'The test Notepad editor lost focus.' }
$pattern = $null
if ($focus.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
  $value = $pattern.DocumentRange.GetText(512)
} elseif ($focus.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
  $value = $pattern.Current.Value
} else { throw 'This Notepad version did not expose document text for verification.' }
ConvertTo-Json -InputObject ($value.TrimEnd([char[]]"`r`n")) -Compress
