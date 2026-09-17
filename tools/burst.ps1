param([string]$Dir = '.', [int]$Frames = 16, [int]$Every = 45, [int]$Wait = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Burst {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int Left, Top, Right, Bottom; }
}
'@

function Find-Panel {
  $script:hit = [IntPtr]::Zero
  $cb = [Burst+Cb]{ param($h, $l)
    $sb = New-Object System.Text.StringBuilder 256
    [Burst]::GetWindowText($h, $sb, 256) | Out-Null
    if ($sb.ToString() -eq 'Cache Warmer' -and [Burst]::IsWindowVisible($h)) { $script:hit = $h; return $false }
    return $true
  }
  [Burst]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:hit
}

if ($Wait -gt 0) { Start-Sleep -Milliseconds $Wait }
$hwnd = Find-Panel
if ($hwnd -eq [IntPtr]::Zero) { 'NOWINDOW'; exit }

'READY'
[Console]::Out.Flush()
$sw = [System.Diagnostics.Stopwatch]::StartNew()
for ($i = 1; $i -le $Frames; $i++) {
  $r = New-Object Burst+R
  [Burst]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  if ($w -gt 0 -and $h -gt 0) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    [Burst]::PrintWindow($hwnd, $hdc, 2) | Out-Null
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    $bmp.Save((Join-Path $Dir ('f{0:D2}.png' -f $i)), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    '{0,2}  {1,4}ms  {2}x{3}' -f $i, $sw.ElapsedMilliseconds, $w, $h
  }
  Start-Sleep -Milliseconds $Every
}
