#Requires -Version 5.1
# widget.ps1 — the face of the cache warmer.
#
# A borderless panel plus a tray icon, driven over a loopback socket by
# widget.js. Nothing here knows how warming works; it renders what it is sent.
#
# The panel has two sizes and animates between them:
#   compact   116x38   the dot and the countdown, nothing else
#   expanded  196x160  status, countdown, caption and the shortcut list

param(
  [int]$Port = 0,
  [string]$Token = '',
  [int]$X = -10000,      # -10000 = no saved position, park it bottom-right
  [int]$Y = -10000,
  [int]$Pin = 1,
  [int]$HideFromCapture = 1,
  [int]$Expanded = 0,
  [int]$PanelShown = 1
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# Rounded corners (Windows 11), an explicit show — the host may have started us
# with a hidden show-state that the first window would inherit — capture
# exclusion, and icon cleanup for the tray.
try {
  Add-Type -Namespace Native -Name Win -MemberDefinition @'
[DllImport("dwmapi.dll")]
public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);
[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hwnd, int cmd);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(IntPtr handle);
'@
} catch { }

# ───────────────────────── Palette ─────────────────────────
$C = @{
  bg    = [System.Drawing.Color]::FromArgb(23, 24, 28)
  edge  = [System.Drawing.Color]::FromArgb(48, 51, 58)
  rule  = [System.Drawing.Color]::FromArgb(38, 40, 46)
  text  = [System.Drawing.Color]::FromArgb(233, 235, 240)
  dim   = [System.Drawing.Color]::FromArgb(126, 131, 142)
  faint = [System.Drawing.Color]::FromArgb(92, 96, 106)
  on    = [System.Drawing.Color]::FromArgb(74, 222, 128)
  hold  = [System.Drawing.Color]::FromArgb(251, 191, 36)
  off   = [System.Drawing.Color]::FromArgb(110, 114, 124)
  hot   = [System.Drawing.Color]::FromArgb(248, 113, 113)
}

$fStatus = New-Object System.Drawing.Font('Segoe UI Semibold', 9.5)
$fBig    = New-Object System.Drawing.Font('Segoe UI', 27)
$fMid    = New-Object System.Drawing.Font('Segoe UI', 13.5)
$fTiny   = New-Object System.Drawing.Font('Segoe UI', 7.5)
$fDot    = New-Object System.Drawing.Font('Segoe UI', 8)
$fClose  = New-Object System.Drawing.Font('Segoe UI', 11)

$SZ_COMPACT  = New-Object System.Drawing.Size(128, 38)
$SZ_EXPANDED = New-Object System.Drawing.Size(196, 160)

# ───────────────────────── Link ─────────────────────────
$script:client     = $null
$script:stream     = $null
$script:writer     = $null
$script:buf        = New-Object byte[] 4096
$script:rx         = ''

$script:pinned     = ($Pin -ne 0)
$script:capWanted  = ($HideFromCapture -ne 0)
$script:capActual  = $false
$script:expanded   = ($Expanded -ne 0)
$script:panelShown = ($PanelShown -ne 0)
$script:animating  = $false
$script:paused     = $false

try {
  $script:client = New-Object System.Net.Sockets.TcpClient
  $script:client.NoDelay = $true
  $script:client.Connect([System.Net.IPAddress]::Loopback, $Port)
  $script:stream = $script:client.GetStream()
  $script:writer = New-Object System.IO.StreamWriter($script:stream)
  $script:writer.AutoFlush = $true
  $script:writer.WriteLine('HELLO|' + $Token)
} catch {
  exit 1
}

function Send-Line([string]$line) {
  try {
    if ($script:client -ne $null -and $script:client.Connected) {
      $script:writer.WriteLine($line)
    }
  } catch { }
}

function Send-Rect {
  # A hidden panel shields nothing, so report an empty rectangle.
  if (-not $script:panelShown) { Send-Line 'RECT|0|0|0|0'; return }
  Send-Line ('RECT|{0}|{1}|{2}|{3}' -f $form.Left, $form.Top, $form.Width, $form.Height)
}

function Send-Flag([string]$name, [bool]$v) {
  if ($v) { Send-Line ($name + '|1') } else { Send-Line ($name + '|0') }
}

# ───────────────────────── Shell ─────────────────────────
function New-Lbl($text, $font, $color, $x, $y, $w, $h, $align) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text      = $text
  $l.Font      = $font
  $l.ForeColor = $color
  $l.BackColor = [System.Drawing.Color]::Transparent
  $l.AutoSize  = $false
  $l.Location  = New-Object System.Drawing.Point($x, $y)
  $l.Size      = New-Object System.Drawing.Size($w, $h)
  $l.TextAlign = $align
  return $l
}

# Chevrons and state icons are drawn rather than typed: at 12 pixels a font
# glyph is a grey smudge, while a stroked path keeps its weight.
function New-Glyph($x, $y, $w, $h, $painter) {
  $panel = New-Object System.Windows.Forms.Panel
  $panel.SetBounds($x, $y, $w, $h)
  $panel.BackColor = $C.bg
  $panel.Add_Paint($painter)
  return $panel
}

function New-Stroke($color, [single]$width) {
  $pen = New-Object System.Drawing.Pen($color, $width)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  return $pen
}

function Point2($x, $y) { return (New-Object System.Drawing.PointF([single]$x, [single]$y)) }

$ML = [System.Drawing.ContentAlignment]::MiddleLeft
$MR = [System.Drawing.ContentAlignment]::MiddleRight
$MC = [System.Drawing.ContentAlignment]::MiddleCenter
$TL = [System.Drawing.ContentAlignment]::TopLeft

$form = New-Object System.Windows.Forms.Form
$form.Text            = 'Cache Warmer'
$form.FormBorderStyle = 'None'
$form.StartPosition   = 'Manual'
$form.BackColor       = $C.bg
$form.TopMost         = $script:pinned
$form.ShowInTaskbar   = $false     # the tray icon is the panel's handle now
$form.MinimizeBox     = $false
$form.MaximizeBox     = $false
$form.KeyPreview      = $true
if ($script:expanded) { $form.ClientSize = $SZ_EXPANDED } else { $form.ClientSize = $SZ_COMPACT }

# Resizing a panel of absolutely positioned labels flickers without this.
# ResizeRedraw matters just as much: growing a window only invalidates the
# strip that was uncovered, so the border this form paints itself would be
# left behind at every size the animation passed through — a nest of little
# rectangles inside the panel. Shrinking clips them away, which is why only
# the expand looked wrong.
try {
  $flags = [System.Reflection.BindingFlags]'Instance,NonPublic'
  $form.GetType().GetProperty('DoubleBuffered', $flags).SetValue($form, $true, $null)
  $form.GetType().GetMethod('SetStyle', $flags).Invoke(
    $form, @([System.Windows.Forms.ControlStyles]::ResizeRedraw, $true))
} catch { }

# Place it: saved spot, else bottom-right above the tray.
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
if ($X -le -10000 -or $Y -le -10000) {
  $X = $wa.Right - $form.Width - 24
  $Y = $wa.Bottom - $form.Height - 24
}
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($X -lt $vs.Left) { $X = $vs.Left }
if ($Y -lt $vs.Top)  { $Y = $vs.Top }
if ($X -gt ($vs.Right - $form.Width))   { $X = $vs.Right - $form.Width }
if ($Y -gt ($vs.Bottom - $form.Height)) { $Y = $vs.Bottom - $form.Height }
$form.Location = New-Object System.Drawing.Point($X, $Y)

$GLYPH_DOT  = [string][char]0x25CF
$GLYPH_X    = [string][char]0x00D7
$GLYPH_WORK = [string][char]0x2022 + [string][char]0x2022 + [string][char]0x2022

$script:chevTint = $C.faint

# A chevron: down when there is more to see, up when there is less.
$paintChev = {
  param($sender, $e)
  $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $pen = New-Stroke $script:chevTint 1.9
  $cx = $sender.Width / 2.0
  $cy = $sender.Height / 2.0
  if ($script:expanded) {
    $pts = [System.Drawing.PointF[]]@((Point2 ($cx - 4.2) ($cy + 2.1)), (Point2 $cx ($cy - 2.3)), (Point2 ($cx + 4.2) ($cy + 2.1)))
  } else {
    $pts = [System.Drawing.PointF[]]@((Point2 ($cx - 4.2) ($cy - 2.1)), (Point2 $cx ($cy + 2.3)), (Point2 ($cx + 4.2) ($cy - 2.1)))
  }
  $e.Graphics.DrawLines($pen, $pts)
  $pen.Dispose()
}

# An arrow into a ceiling: lit while the panel stays above other windows.
$paintPin = {
  param($sender, $e)
  $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  if ($script:pinned) { $tint = $C.on } else { $tint = $C.faint }
  $pen = New-Stroke $tint 1.4
  $e.Graphics.DrawLine($pen, 1.6, 2.2, 10.4, 2.2)
  $e.Graphics.DrawLine($pen, 6.0, 10.4, 6.0, 5.2)
  $pts = [System.Drawing.PointF[]]@((Point2 3.5 7.7), (Point2 6.0 5.2), (Point2 8.5 7.7))
  $e.Graphics.DrawLines($pen, $pts)
  $pen.Dispose()
}

# An eye, struck through while the panel is out of screen shares. Left open
# and amber when it is not, because that is the state worth noticing.
$paintEye = {
  param($sender, $e)
  $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  if ($script:capActual) { $tint = $C.dim } else { $tint = $C.hold }
  $pen = New-Stroke $tint 1.25
  # An almond rather than a circle: two arcs meeting at the corners read as
  # an eye at this size, where an ellipse just reads as a ring.
  $e.Graphics.DrawBezier($pen, (Point2 0.8 6.0), (Point2 3.0 1.9), (Point2 9.0 1.9), (Point2 11.2 6.0))
  $e.Graphics.DrawBezier($pen, (Point2 0.8 6.0), (Point2 3.0 10.1), (Point2 9.0 10.1), (Point2 11.2 6.0))
  $pupil = New-Object System.Drawing.SolidBrush $tint
  $e.Graphics.FillEllipse($pupil, 4.7, 4.7, 2.6, 2.6)
  $pupil.Dispose()
  if ($script:capActual) {
    $gap = New-Stroke $C.bg 2.6
    $e.Graphics.DrawLine($gap, 1.3, 10.5, 10.7, 1.5)
    $gap.Dispose()
    $e.Graphics.DrawLine($pen, 1.3, 10.5, 10.7, 1.5)
  }
  $pen.Dispose()
}

$dot   = New-Lbl $GLYPH_DOT $fDot   $C.on    12 10 12 18 $ML
$stat  = New-Lbl 'ON'       $fStatus $C.text  26  9 56 18 $ML
$pinL  = New-Lbl 'PIN'      $fTiny  $C.faint  92 11 50 14 $MR
$close = New-Lbl $GLYPH_X   $fClose $C.faint 166  5 22 22 $MC

$chev   = New-Glyph 146 11 16 16 $paintChev
$icoPin = New-Glyph  76 13 12 12 $paintPin
$icoEye = New-Glyph  92 13 12 12 $paintEye

$big   = New-Lbl '--' $fBig  $C.text 0 28 196 44 $MC
$cap   = New-Lbl ''   $fTiny $C.dim  0 74 196 14 $MC

# The shortcut list. Each action carries its own colour, so the list doubles
# as the read-out: whatever is lit is what is true right now, and the pause
# row lights the half the key would actually do.
function Measure-Tiny([string]$text) {
  return [System.Windows.Forms.TextRenderer]::MeasureText(
    $text, $fTiny, (New-Object System.Drawing.Size(0, 0)),
    [System.Windows.Forms.TextFormatFlags]::NoPadding).Width
}

$ROW_Y = 100
$ROW_H = 14
$ACT_X = 84

$keyLbls = @()
$keyTexts = @('Ctrl+Alt+P', 'Ctrl+Alt+T', 'Ctrl+Alt+H', 'Ctrl+Alt+Q')
for ($i = 0; $i -lt $keyTexts.Count; $i++) {
  $keyLbls += (New-Lbl $keyTexts[$i] $fTiny $C.dim 16 ($ROW_Y + $i * $ROW_H) 64 $ROW_H $TL)
}

$wPause = Measure-Tiny 'pause'
$wSlash = Measure-Tiny '/'
$actPause  = New-Lbl 'pause'  $fTiny $C.on     $ACT_X                        $ROW_Y $wPause $ROW_H $TL
$actSlash  = New-Lbl '/'      $fTiny $C.faint ($ACT_X + $wPause + 4)         $ROW_Y $wSlash $ROW_H $TL
$actResume = New-Lbl 'resume' $fTiny $C.faint ($ACT_X + $wPause + $wSlash + 8) $ROW_Y 60 $ROW_H $TL

$actTop  = New-Lbl 'stay on top'    $fTiny $C.faint $ACT_X ($ROW_Y + $ROW_H)       96 $ROW_H $TL
$actHide = New-Lbl 'hide in shares' $fTiny $C.faint $ACT_X ($ROW_Y + 2 * $ROW_H)   96 $ROW_H $TL
$actQuit = New-Lbl 'quit'           $fTiny $C.faint $ACT_X ($ROW_Y + 3 * $ROW_H)   96 $ROW_H $TL

$actLbls = @($actPause, $actSlash, $actResume, $actTop, $actHide, $actQuit)

$panelOnly = @($stat, $pinL, $close, $cap) + $keyLbls + $actLbls
$form.Controls.AddRange(@($dot, $chev, $icoPin, $icoEye, $big) + $panelOnly)

$form.Add_Paint({
  param($sender, $e)
  $pen = New-Object System.Drawing.Pen($C.edge, 1)
  $e.Graphics.DrawRectangle($pen, 0, 0, ($form.ClientSize.Width - 1), ($form.ClientSize.Height - 1))
  $pen.Dispose()
  if ($script:expanded -and -not $script:animating) {
    $rule = New-Object System.Drawing.Pen($C.rule, 1)
    $e.Graphics.DrawLine($rule, 16, 92, ($form.ClientSize.Width - 17), 92)
    $rule.Dispose()
  }
})

# ───────────────────────── Tray ─────────────────────────
$script:trayHicon = [IntPtr]::Zero
$script:trayTint  = ''
$script:trayTip   = ''

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Text    = 'Cache Warmer'
$tray.Visible = $true

$menu    = New-Object System.Windows.Forms.ContextMenuStrip
$miShow  = $menu.Items.Add('Show panel')
$miExp   = $menu.Items.Add('Expand')
$miPause = $menu.Items.Add('Pause')
$miPin   = $menu.Items.Add('Keep on top')
$miCap   = $menu.Items.Add('Hide from screen capture')
$menu.Items.Add('-') | Out-Null
$miQuit  = $menu.Items.Add('Quit')
$tray.ContextMenuStrip = $menu

function Set-TrayIcon([string]$tint, $color) {
  if ($tint -eq $script:trayTint) { return }
  $script:trayTint = $tint
  try {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $brush = New-Object System.Drawing.SolidBrush $color
    $g.FillEllipse($brush, 2, 2, 12, 12)
    $brush.Dispose(); $g.Dispose()

    $old = $script:trayHicon
    $script:trayHicon = $bmp.GetHicon()
    $tray.Icon = [System.Drawing.Icon]::FromHandle($script:trayHicon)
    $bmp.Dispose()
    if ($old -ne [IntPtr]::Zero) { [Native.Win]::DestroyIcon($old) | Out-Null }
  } catch { }
}

function Set-TrayTip([string]$text) {
  if ($text -eq $script:trayTip) { return }
  $script:trayTip = $text
  # NotifyIcon.Text throws above 63 characters.
  if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
  try { $tray.Text = $text } catch { }
}

function Sync-Menu {
  if ($script:panelShown) { $miShow.Text = 'Hide panel' } else { $miShow.Text = 'Show panel' }
  if ($script:expanded)   { $miExp.Text  = 'Collapse' }    else { $miExp.Text  = 'Expand' }
  $miPin.Checked = $script:pinned
  $miCap.Checked = $script:capActual
}

# ───────────────────────── Rendering ─────────────────────────
function Sync-Rows {
  if ($script:paused) {
    $actPause.ForeColor  = $C.faint
    $actResume.ForeColor = $C.on
  } else {
    $actPause.ForeColor  = $C.on
    $actResume.ForeColor = $C.faint
  }
  if ($script:pinned)    { $actTop.ForeColor  = $C.on } else { $actTop.ForeColor  = $C.faint }
  if ($script:capActual) { $actHide.ForeColor = $C.on } else { $actHide.ForeColor = $C.faint }
  $icoPin.Invalidate()
  $icoEye.Invalidate()
}

function Set-Phase([string]$phase, [int]$secs) {
  $wasPaused = $script:paused
  $script:paused = ($phase -eq 'off')
  if ($wasPaused -ne $script:paused) { Sync-Rows }

  if ($phase -eq 'off') {
    $dot.ForeColor  = $C.off
    $stat.Text      = 'OFF'
    $stat.ForeColor = $C.dim
    $big.Text       = 'OFF'
    $big.ForeColor  = $C.off
    $cap.Text       = 'paused'
    $miPause.Text   = 'Resume'
    Set-TrayIcon 'off' $C.off
    Set-TrayTip 'Cache Warmer — paused'
  } elseif ($phase -eq 'move') {
    $dot.ForeColor  = $C.on
    $stat.Text      = 'ON'
    $stat.ForeColor = $C.text
    $big.Text       = $GLYPH_WORK
    $big.ForeColor  = $C.on
    $cap.Text       = 'refreshing'
    $miPause.Text   = 'Pause'
    Set-TrayIcon 'on' $C.on
    Set-TrayTip 'Cache Warmer — refreshing'
  } elseif ($phase -eq 'hold') {
    $dot.ForeColor  = $C.hold
    $stat.Text      = 'ON'
    $stat.ForeColor = $C.text
    $big.Text       = ('{0}s' -f $secs)
    $big.ForeColor  = $C.hold
    $cap.Text       = 'you are active'
    $miPause.Text   = 'Pause'
    Set-TrayIcon 'hold' $C.hold
    Set-TrayTip ('Cache Warmer — holding, {0}s' -f $secs)
  } else {
    $dot.ForeColor  = $C.on
    $stat.Text      = 'ON'
    $stat.ForeColor = $C.text
    $big.Text       = ('{0}s' -f $secs)
    $big.ForeColor  = $C.text
    $cap.Text       = 'next refresh'
    $miPause.Text   = 'Pause'
    Set-TrayIcon 'on' $C.on
    Set-TrayTip ('Cache Warmer — next refresh {0}s' -f $secs)
  }
}

# Keep the panel out of screen shares, Teams/Zoom/Meet, the Snipping Tool and
# PrintScreen. WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+) drops the window from
# every capture path — sharers see straight through to what is behind it.
# Older builds only have WDA_MONITOR, which leaves a black rectangle instead.
function Set-Capture([bool]$v, [bool]$echo) {
  $WDA_NONE               = 0x00
  $WDA_MONITOR            = 0x01
  $WDA_EXCLUDEFROMCAPTURE = 0x11

  $script:capWanted = $v
  $got = $false
  try {
    if ($v) {
      $got = [Native.Win]::SetWindowDisplayAffinity($form.Handle, $WDA_EXCLUDEFROMCAPTURE)
      if (-not $got) { $got = [Native.Win]::SetWindowDisplayAffinity($form.Handle, $WDA_MONITOR) }
    } else {
      [Native.Win]::SetWindowDisplayAffinity($form.Handle, $WDA_NONE) | Out-Null
    }
  } catch { }

  $script:capActual = $got
  Sync-Rows
  Sync-Menu
  if ($echo) { Send-Flag 'CAP' $got }
}

function Set-Pin([bool]$v, [bool]$echo) {
  $script:pinned = $v
  $form.TopMost = $v
  Set-Capture $script:capWanted $false   # TopMost can rebuild the handle, dropping the affinity
  if ($v) {
    $pinL.Text = 'ON TOP'
    $pinL.ForeColor = $C.on
  } else {
    $pinL.Text = 'PIN'
    $pinL.ForeColor = $C.faint
  }
  Sync-Rows
  Sync-Menu
  if ($echo) { Send-Flag 'PIN' $v }
}

# ───────────────────────── Compact / expanded ─────────────────────────
function Apply-Layout {
  # Windows clamps a new window to its minimum tracking size (about 136x39),
  # which is wider than the compact panel. Re-stating the bounds through
  # SetWindowPos afterwards gets the pixels we actually asked for.
  if ($script:expanded) { $want = $SZ_EXPANDED } else { $want = $SZ_COMPACT }
  if ($form.Width -ne $want.Width -or $form.Height -ne $want.Height) {
    $form.SetBounds($form.Left, $form.Top, $want.Width, $want.Height)
  }

  $form.SuspendLayout()
  if ($script:expanded) {
    $dot.SetBounds(12, 10, 12, 18)
    $big.Font = $fBig
    $big.TextAlign = $MC
    $big.SetBounds(0, 28, $form.ClientSize.Width, 44)
    $chev.SetBounds(146, 11, 16, 16)
    $icoPin.Visible = $false
    $icoEye.Visible = $false
    foreach ($lbl in $panelOnly) { $lbl.Visible = $true }
  } else {
    $dot.SetBounds(9, 10, 12, 18)
    $big.Font = $fMid
    $big.TextAlign = $ML
    # 47px is what the longest countdown needs: a backed-off wait reaches
    # 150s, which measures 46 at this size.
    $big.SetBounds(23, 7, 47, 24)
    # The two state icons belong to the countdown, so they sit tight against
    # it and against each other, with the gap saved for the chevron.
    $icoPin.SetBounds(72, 13, 12, 12)
    $icoEye.SetBounds(86, 13, 12, 12)
    $chev.SetBounds(106, 12, 14, 14)
    $icoPin.Visible = $true
    $icoEye.Visible = $true
    foreach ($lbl in $panelOnly) { $lbl.Visible = $false }
  }
  $form.ResumeLayout()
  $chev.Invalidate()
  $form.Invalidate()
}

$script:animFrame = 0
$script:animSteps = 14
$script:animFromB = $null
$script:animToB   = $null
$script:animEcho  = $false

$anim = New-Object System.Windows.Forms.Timer
$anim.Interval = 15
$anim.Add_Tick({
  $script:animFrame++
  $t = [double]$script:animFrame / $script:animSteps
  if ($t -gt 1) { $t = 1 }
  $e = 1 - [Math]::Pow(1 - $t, 3)          # ease-out cubic

  $fromB = $script:animFromB
  $toB   = $script:animToB
  $x = [int][Math]::Round($fromB.X      + (($toB.X      - $fromB.X)      * $e))
  $y = [int][Math]::Round($fromB.Y      + (($toB.Y      - $fromB.Y)      * $e))
  $w = [int][Math]::Round($fromB.Width  + (($toB.Width  - $fromB.Width)  * $e))
  $h = [int][Math]::Round($fromB.Height + (($toB.Height - $fromB.Height) * $e))
  $form.SetBounds($x, $y, $w, $h)
  $form.Invalidate()          # repaint the whole frame, not just the new strip

  if ($t -ge 1) {
    $anim.Stop()
    $script:animating = $false
    $form.SetBounds($toB.X, $toB.Y, $toB.Width, $toB.Height)
    Apply-Layout
    Send-Rect
    if ($script:animEcho) { Send-Flag 'EXP' $script:expanded }
  }
})

function Set-Expanded([bool]$v, [bool]$echo) {
  if (-not $script:panelShown) { Set-PanelShown $true }
  if ($script:animating) { return }
  if ($v -eq $script:expanded) { Sync-Menu; return }

  $script:expanded  = $v
  $script:animating = $true
  $script:animEcho  = $echo
  $script:animFrame = 0

  if ($v) { $size = $SZ_EXPANDED } else { $size = $SZ_COMPACT }

  # Grow away from the nearest corner of the desktop: a panel parked bottom
  # right opens up and to the left, one parked top left opens down and right.
  # Anchoring the same corner both ways means it never drifts across a cycle.
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $midX = ($screen.Left + $screen.Right) / 2
  $midY = ($screen.Top + $screen.Bottom) / 2

  if (($form.Left + ($form.Width / 2)) -gt $midX) {
    $nx = ($form.Left + $form.Width) - $size.Width
  } else {
    $nx = $form.Left
  }
  if (($form.Top + ($form.Height / 2)) -gt $midY) {
    $ny = ($form.Top + $form.Height) - $size.Height
  } else {
    $ny = $form.Top
  }

  if (($nx + $size.Width)  -gt $screen.Right)  { $nx = $screen.Right  - $size.Width }
  if (($ny + $size.Height) -gt $screen.Bottom) { $ny = $screen.Bottom - $size.Height }
  if ($nx -lt $screen.Left) { $nx = $screen.Left }
  if ($ny -lt $screen.Top)  { $ny = $screen.Top }

  $script:animFromB = New-Object System.Drawing.Rectangle($form.Left, $form.Top, $form.Width, $form.Height)
  $script:animToB   = New-Object System.Drawing.Rectangle($nx, $ny, $size.Width, $size.Height)

  # Nothing but the dot and the countdown survives the in-between sizes.
  foreach ($lbl in $panelOnly) { $lbl.Visible = $false }
  $icoPin.Visible = $false
  $icoEye.Visible = $false
  if (-not $v) {
    $big.Font = $fMid
    $big.TextAlign = $ML
  }
  $chev.Invalidate()
  Sync-Menu
  $anim.Start()
}

function Set-PanelShown([bool]$v) {
  $script:panelShown = $v
  if ($v) {
    $form.Show()
    $form.Visible = $true
    Apply-Layout
    Set-Capture $script:capWanted $false
    Set-Pin $script:pinned $false
  } else {
    $form.Hide()
  }
  Send-Rect
  Send-Flag 'VIS' $v
  Sync-Menu
}

# ───────────────────────── Dragging ─────────────────────────
$script:dragging = $false
$script:grabAt   = New-Object System.Drawing.Point(0, 0)
$script:grabFrom = New-Object System.Drawing.Point(0, 0)

$onDown = {
  param($sender, $e)
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  if ($script:animating) { return }
  $script:dragging = $true
  $script:grabAt   = [System.Windows.Forms.Cursor]::Position
  $script:grabFrom = $form.Location
  Send-Line 'DRAG|1'
}
$onMove = {
  param($sender, $e)
  if (-not $script:dragging) { return }
  $p = [System.Windows.Forms.Cursor]::Position
  $nx = $script:grabFrom.X + ($p.X - $script:grabAt.X)
  $ny = $script:grabFrom.Y + ($p.Y - $script:grabAt.Y)
  $form.Location = New-Object System.Drawing.Point($nx, $ny)
}
$onUp = {
  param($sender, $e)
  if (-not $script:dragging) { return }
  $script:dragging = $false
  Send-Rect
  Send-Line 'DRAG|0'
}

# Drag from anywhere that is not a control of its own. The state icons say
# things, they do not do things, so they drag with the rest of the body.
foreach ($ctl in @($form, $big, $cap, $icoPin, $icoEye) + $keyLbls + $actLbls) {
  $ctl.Add_MouseDown($onDown)
  $ctl.Add_MouseMove($onMove)
  $ctl.Add_MouseUp($onUp)
}

# ───────────────────────── Buttons ─────────────────────────
$flip = { Set-Expanded (-not $script:expanded) $true }
foreach ($ctl in @($form, $big, $cap, $icoPin, $icoEye)) { $ctl.Add_DoubleClick($flip) }

$toggle = { Send-Line 'TOGGLE' }
foreach ($ctl in @($dot, $stat)) {
  $ctl.Cursor = [System.Windows.Forms.Cursors]::Hand
  $ctl.Add_Click($toggle)
}

$chev.Cursor = [System.Windows.Forms.Cursors]::Hand
$chev.Add_Click($flip)
$chev.Add_MouseEnter({ $script:chevTint = $C.text;  $chev.Invalidate() })
$chev.Add_MouseLeave({ $script:chevTint = $C.faint; $chev.Invalidate() })

$pinL.Cursor = [System.Windows.Forms.Cursors]::Hand
$pinL.Add_Click({ Set-Pin (-not $script:pinned) $true })

$close.Cursor = [System.Windows.Forms.Cursors]::Hand
$close.Add_MouseEnter({ $close.ForeColor = $C.hot })
$close.Add_MouseLeave({ $close.ForeColor = $C.faint })
$close.Add_Click({ Send-Line 'QUIT'; $form.Close() })

$miShow.Add_Click({ Set-PanelShown (-not $script:panelShown) })
$miExp.Add_Click({ Set-Expanded (-not $script:expanded) $true })
$miPause.Add_Click({ Send-Line 'TOGGLE' })
$miPin.Add_Click({ Set-Pin (-not $script:pinned) $true })
$miCap.Add_Click({ Set-Capture (-not $script:capWanted) $true })
$miQuit.Add_Click({ Send-Line 'QUIT'; $form.Close() })

# Left-click the tray icon: bring the panel back, or flip its size if it is
# already on screen. Right-click opens the menu on its own.
$tray.Add_MouseClick({
  param($sender, $e)
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  if (-not $script:panelShown) { Set-PanelShown $true }
  else { Set-Expanded (-not $script:expanded) $true }
})

$form.Add_KeyDown({
  param($sender, $e)
  if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { Set-Expanded $false $true }
})

$form.Add_Move({ if (-not $script:dragging -and -not $script:animating) { Send-Rect } })

# ───────────────────────── Pump ─────────────────────────
function Read-Link {
  try {
    if ($script:client -eq $null -or -not $script:client.Connected) { $form.Close(); return }
    $ns = $script:stream
    while ($ns.DataAvailable) {
      $n = $ns.Read($script:buf, 0, $script:buf.Length)
      if ($n -le 0) { $form.Close(); return }
      $script:rx += [System.Text.Encoding]::UTF8.GetString($script:buf, 0, $n)
    }
    while ($true) {
      $i = $script:rx.IndexOf("`n")
      if ($i -lt 0) { break }
      $line = $script:rx.Substring(0, $i).TrimEnd([char]13)
      $script:rx = $script:rx.Substring($i + 1)
      $p = $line.Split('|')
      if ($p[0] -eq 'S') {
        Set-Phase $p[2] ([int]$p[3])
      } elseif ($p[0] -eq 'PIN') {
        Set-Pin ($p[1] -eq '1') $false
      } elseif ($p[0] -eq 'CAP') {
        Set-Capture ($p[1] -eq '1') $true
      } elseif ($p[0] -eq 'EXP') {
        Set-Expanded ($p[1] -eq '1') $true
      } elseif ($p[0] -eq 'VIS') {
        Set-PanelShown ($p[1] -eq '1')
      } elseif ($p[0] -eq 'BYE') {
        $form.Close(); return
      }
    }
    # Readable with nothing available means the other end hung up.
    if ($script:client.Client.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and $script:client.Client.Available -eq 0) {
      $form.Close()
    }
  } catch {
    [Console]::Error.WriteLine('link: ' + $_.Exception.Message)
    try { $form.Close() } catch { }
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 80
$timer.Add_Tick({ Read-Link })

$form.Add_Shown({
  try {
    [Native.Win]::ShowWindow($form.Handle, 5) | Out-Null           # SW_SHOW
    $round = 2                                                     # DWMWCP_ROUND
    [Native.Win]::DwmSetWindowAttribute($form.Handle, 33, [ref]$round, 4) | Out-Null
  } catch { }
  try {
    Set-TrayIcon 'on' $C.on
    Set-Capture $script:capWanted $true
    Set-Pin $script:pinned $false
    Apply-Layout
    Send-Flag 'EXP' $script:expanded
    if (-not $script:panelShown) { Set-PanelShown $false } else { Send-Rect }
    Sync-Menu
    $timer.Start()
  } catch {
    [Console]::Error.WriteLine('shown: ' + $_.Exception.Message)
    $form.Close()
  }
})

$form.Add_FormClosing({
  $timer.Stop()
  $anim.Stop()
  Send-Line 'QUIT'
  try { $tray.Visible = $false; $tray.Dispose() } catch { }
  try { if ($script:trayHicon -ne [IntPtr]::Zero) { [Native.Win]::DestroyIcon($script:trayHicon) | Out-Null } } catch { }
  try { $script:client.Close() } catch { }
})

[System.Windows.Forms.Application]::Run($form)
