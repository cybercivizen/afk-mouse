param([string]$Out = 'shot.png')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Shot {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int Left, Top, Right, Bottom; }
}
'@
$script:hit = [IntPtr]::Zero
$cb = [Shot+Cb]{ param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [Shot]::GetWindowText($h, $sb, 256) | Out-Null
  if ($sb.ToString() -eq 'Cache Warmer' -and [Shot]::IsWindowVisible($h)) { $script:hit = $h; return $false }
  return $true
}
[Shot]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($script:hit -eq [IntPtr]::Zero) { 'NOWINDOW'; exit }
$r = New-Object Shot+R
[Shot]::GetWindowRect($script:hit, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$aff = 0
[Shot]::GetWindowDisplayAffinity($script:hit, [ref]$aff) | Out-Null
'rect={0},{1} {2}x{3} affinity=0x{4:X2}' -f $r.Left, $r.Top, $w, $h, $aff
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Shot]::PrintWindow($script:hit, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
'saved ' + $Out
