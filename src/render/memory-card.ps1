param(
  [Parameter(Mandatory = $true)][string]$DataPath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [string]$AvatarPath = '',
  [string]$BackdropPath = '',
  [string]$TemplatePath = ''
)

# Dark character card. The static parts (backdrop, panel, divider) are cached in
# a template PNG; a render then only pastes the avatar and the text onto it.
# Pass an empty TemplatePath to always rebuild. ASCII only: all copy is in JSON.

Add-Type -AssemblyName System.Drawing

$data = Get-Content -LiteralPath $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json

$W = 1500
$H = 900

# Panel geometry: taller and wider than before, its top edge shared with the
# portrait so the left and right columns line up.
$bx = 500
$by = 190
$bw = 960
$bh = 680
# Share of the panel given to the upper section; the lower one gets the rest.
$splitRatio = 0.5
if ($null -ne $data.split) { $splitRatio = [double]$data.split }
if ($splitRatio -lt 0.3) { $splitRatio = 0.3 }
if ($splitRatio -gt 0.8) { $splitRatio = 0.8 }
$half = [int]($bh * $splitRatio)
$bottomHeight = $bh - $half
$noteColumns = 1
if ($null -ne $data.notesColumns) { $noteColumns = [Math]::Max(1, [int]$data.notesColumns) }

$bmp = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

# Two templates exist: the group one has no baked divider (its hourly chart is
# the separator), the personal one keeps it. Never let one serve the other.
$isGroup = ($data.template -eq 'group')
$hours = @($data.hours)
$hasChart = $isGroup -and ($hours.Count -eq 24)

$useTemplate = $false
if ($TemplatePath -ne '' -and (Test-Path -LiteralPath $TemplatePath)) {
  try {
    $tpl = [System.Drawing.Image]::FromFile($TemplatePath)
    $g.DrawImage($tpl, 0, 0, $W, $H)
    $tpl.Dispose()
    $useTemplate = $true
  } catch {
    $useTemplate = $false
  }
}

function New-RoundedPath {
  param([single]$X, [single]$Y, [single]$W, [single]$H, [single]$R)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [single]($R * 2)
  $p.AddArc($X, $Y, $d, $d, 180, 90)
  $p.AddArc(($X + $W - $d), $Y, $d, $d, 270, 90)
  $p.AddArc(($X + $W - $d), ($Y + $H - $d), $d, $d, 0, 90)
  $p.AddArc($X, ($Y + $H - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$amberColor = [System.Drawing.Color]::FromArgb(255, 240, 178, 74)

if (-not $useTemplate) {
  $black = [System.Drawing.Color]::FromArgb(255, 12, 12, 14)
  $g.Clear($black)

  if ($BackdropPath -ne '' -and (Test-Path -LiteralPath $BackdropPath)) {
    try {
      $bgImg = [System.Drawing.Image]::FromFile($BackdropPath)
      $cover = New-Object System.Drawing.Bitmap $W, $H
      $cg = [System.Drawing.Graphics]::FromImage($cover)
      $cg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $scale = [Math]::Max($W / $bgImg.Width, $H / $bgImg.Height)
      $dw = [int]($bgImg.Width * $scale)
      $dh = [int]($bgImg.Height * $scale)
      $cg.DrawImage($bgImg, [int](($W - $dw) / 2), [int](($H - $dh) / 2), $dw, $dh)
      $cg.Dispose()
      $bgImg.Dispose()

      $attrs = New-Object System.Drawing.Imaging.ImageAttributes
      $matrix = New-Object System.Drawing.Imaging.ColorMatrix
      $matrix.Matrix33 = 0.72
      $attrs.SetColorMatrix($matrix)
      $dest = New-Object System.Drawing.Rectangle 0, 0, $W, $H
      $g.DrawImage($cover, $dest, 0, 0, $W, $H, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
      $cover.Dispose()

      $veil = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 6, 6, 8))
      $g.FillRectangle($veil, 0, 0, $W, $H)
    } catch {
      # keep the plain canvas
    }
  }

  $panel = New-RoundedPath $bx $by $bw $bh 20
  $panelBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(206, 20, 19, 18))
  $g.FillPath($panelBrush, $panel)
  $panelEdge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(52, 240, 178, 74)), 1
  $g.DrawPath($panelEdge, $panel)
  # The group template leaves the split open: its hourly chart is the separator.
  if (-not $isGroup) {
    $divider = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(42, 240, 178, 74)), 1
    $g.DrawLine($divider, ($bx + 40), ($by + $half), ($bx + $bw - 40), ($by + $half))
  }

  if ($TemplatePath -ne '') {
    try {
      $bmp.Save($TemplatePath, [System.Drawing.Imaging.ImageFormat]::Png)
    } catch {
      # a read-only media directory is not fatal
    }
  }
}

$fontName = 'Microsoft YaHei UI'
$fTitle = New-Object System.Drawing.Font $fontName, 44, ([System.Drawing.FontStyle]::Bold)
$fSub = New-Object System.Drawing.Font $fontName, 19
$fHead = New-Object System.Drawing.Font $fontName, 23, ([System.Drawing.FontStyle]::Bold)
$fBody = New-Object System.Drawing.Font $fontName, 18
$fFoot = New-Object System.Drawing.Font $fontName, 14

$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 244, 244, 246))
$soft = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 220, 218, 214))
$dim = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 146, 144, 140))
$amber = New-Object System.Drawing.SolidBrush $amberColor

# Trim text to a width, ending with an ellipsis. Used for titles and names that
# can be arbitrarily long in QQ.
function Trim-ToWidth {
  param([string]$Text, [System.Drawing.Font]$Font, [single]$MaxWidth)
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  if ($g.MeasureString($Text, $Font).Width -le $MaxWidth) { return $Text }
  $ellipsis = [string][char]0x2026
  $chars = $Text.ToCharArray()
  $low = 0
  $high = $chars.Length
  while ($low -lt $high) {
    $mid = [int][Math]::Floor(($low + $high + 1) / 2)
    $candidate = (-join $chars[0..($mid - 1)]) + $ellipsis
    if ($g.MeasureString($candidate, $Font).Width -le $MaxWidth) { $low = $mid } else { $high = $mid - 1 }
  }
  if ($low -le 0) { return $ellipsis }
  return (-join $chars[0..($low - 1)]) + $ellipsis
}

# Scene pill, top right: where this card was asked for (group name, or nothing).
$sceneLabel = [string]$data.sceneLabel
$pillLeft = $W - 48
if ($sceneLabel.Trim() -ne '') {
  $fScene = New-Object System.Drawing.Font $fontName, 16
  $sceneLabel = Trim-ToWidth -Text $sceneLabel -Font $fScene -MaxWidth 300
  $size = $g.MeasureString($sceneLabel, $fScene)
  $pillW = [single]($size.Width + 44)
  $pillH = [single]44
  $pillX = $W - 48 - $pillW
  $pillLeft = $pillX - 24
  $pillPath = New-RoundedPath $pillX 54 $pillW $pillH 22
  $pillFill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 20, 19, 18))
  $g.FillPath($pillFill, $pillPath)
  $pillPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 240, 178, 74)), 1.5
  $g.DrawPath($pillPen, $pillPath)
  $g.DrawString($sceneLabel, $fScene, $amber, ($pillX + 22), (54 + [int](($pillH - $size.Height) / 2)))
}

# Title: shrink once before truncating, because a slightly smaller name reads
# better than a clipped one.
$titleText = [string]$data.title
$titleWidth = $pillLeft - 48
$fTitleSmall = New-Object System.Drawing.Font $fontName, 36, ([System.Drawing.FontStyle]::Bold)
if ($g.MeasureString($titleText, $fTitle).Width -gt $titleWidth) {
  if ($g.MeasureString($titleText, $fTitleSmall).Width -le $titleWidth) {
    $g.DrawString($titleText, $fTitleSmall, $white, 48, 46)
  } else {
    $g.DrawString((Trim-ToWidth -Text $titleText -Font $fTitleSmall -MaxWidth $titleWidth), $fTitleSmall, $white, 48, 46)
  }
} else {
  $g.DrawString($titleText, $fTitle, $white, 48, 40)
}
$g.DrawString([string]$data.subtitle, $fSub, $amber, 50, 110)

# --- portrait: framed, its frame's top edge on the panel's top edge ----------
$inset = 9
$px = 48
$py = $by + $inset
$pw = 396
$ph = 520
if ($AvatarPath -ne '' -and (Test-Path -LiteralPath $AvatarPath)) {
  try {
    $src = [System.Drawing.Image]::FromFile($AvatarPath)
    $scale = [Math]::Max($pw / $src.Width, $ph / $src.Height)
    $dw = [int]($src.Width * $scale)
    $dh = [int]($src.Height * $scale)
    $state = $g.Save()
    $rect = New-Object System.Drawing.Rectangle $px, $py, $pw, $ph
    $g.SetClip($rect)
    $g.DrawImage($src, ($px + [int](($pw - $dw) / 2)), ($py + [int](($ph - $dh) / 2)), $dw, $dh)
    $g.Restore($state)
    $src.Dispose()
  } catch {
    # skip the portrait
  }
}

# Decorative double frame with corner ticks.
$framePen = New-Object System.Drawing.Pen $amberColor, 2
$innerPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(110, 240, 178, 74)), 1
$g.DrawRectangle($framePen, ($px - 9), ($py - 9), ($pw + 18), ($ph + 18))
$g.DrawRectangle($innerPen, ($px - 3), ($py - 3), ($pw + 6), ($ph + 6))
$tick = New-Object System.Drawing.Pen $amberColor, 4
$t = 16
$g.DrawLine($tick, ($px - 9), ($py - 9), ($px - 9 + $t), ($py - 9))
$g.DrawLine($tick, ($px - 9), ($py - 9), ($px - 9), ($py - 9 + $t))
$g.DrawLine($tick, ($px + $pw + 9), ($py - 9), ($px + $pw + 9 - $t), ($py - 9))
$g.DrawLine($tick, ($px + $pw + 9), ($py - 9), ($px + $pw + 9), ($py - 9 + $t))
$g.DrawLine($tick, ($px - 9), ($py + $ph + 9), ($px - 9 + $t), ($py + $ph + 9))
$g.DrawLine($tick, ($px - 9), ($py + $ph + 9), ($px - 9), ($py + $ph + 9 - $t))
$g.DrawLine($tick, ($px + $pw + 9), ($py + $ph + 9), ($px + $pw + 9 - $t), ($py + $ph + 9))
$g.DrawLine($tick, ($px + $pw + 9), ($py + $ph + 9), ($px + $pw + 9), ($py + $ph + 9 - $t))

function Wrap-Text {
  param([string]$Text, [System.Drawing.Font]$Font, [single]$MaxWidth)
  $lines = New-Object System.Collections.Generic.List[string]
  if ($null -eq $Text) { return , $lines }
  $current = ''
  foreach ($char in $Text.ToCharArray()) {
    if ($char -eq "`n") {
      $lines.Add($current)
      $current = ''
      continue
    }
    $candidate = $current + $char
    $size = $script:g.MeasureString($candidate, $Font)
    if ($size.Width -gt $MaxWidth -and $current -ne '') {
      $lines.Add($current)
      $current = [string]$char
    } else {
      $current = $candidate
    }
  }
  if ($current -ne '') { $lines.Add($current) }
  return , $lines
}

$innerX = $bx + 46
$innerW = $bw - 92

# Upper half: how I should talk to this person.
$g.DrawString([string]$data.personaLabel, $fHead, $amber, $innerX, ($by + 34))
$persona = [string]$data.persona
if ($persona.Trim() -eq '') { $persona = [string]$data.emptyPersona }
$topState = $g.Save()
$topClip = New-Object System.Drawing.RectangleF $innerX, ($by + 82), $innerW, ($half - 106)
$g.SetClip($topClip)
$ty = $by + 82
foreach ($line in (Wrap-Text -Text $persona -Font $fBody -MaxWidth ($innerW - 12))) {
  if ($ty + 30 -gt ($by + $half - 24)) { break }
  $g.DrawString($line, $fBody, $soft, $innerX, $ty)
  $ty += 32
}
$g.Restore($topState)

# Optional 24-hour activity bars, standing on the split line as its separator.
if ($hasChart) {
  $maxHour = 0
  foreach ($value in $hours) { if ([int]$value -gt $maxHour) { $maxHour = [int]$value } }
  if ($maxHour -gt 0) {
    # The axis sits exactly on the split, so the bars replace the divider rule.
    $chartBottom = $by + $half
    $chartHeight = 64
    $slot = $innerW / 24
    $barWidth = [single]([Math]::Max(6, $slot - 6))
    for ($h = 0; $h -lt 24; $h++) {
      $value = [int]$hours[$h]
      $barH = [single]([Math]::Max(3, ($value / $maxHour) * $chartHeight))
      $barX = [single]($innerX + ($h * $slot))
      $barY = [single]($chartBottom - $barH)
      $shade = 90 + [int](120 * ($value / $maxHour))
      $barBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($shade, 240, 178, 74))
      $g.FillRectangle($barBrush, $barX, $barY, $barWidth, $barH)
      $barBrush.Dispose()
    }
    $axis = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(70, 240, 178, 74)), 1
    $g.DrawLine($axis, $innerX, $chartBottom, ($innerX + $innerW), $chartBottom)
    $fTiny = New-Object System.Drawing.Font $fontName, 11
    $g.DrawString('0', $fTiny, $dim, $innerX, ($chartBottom + 2))
    $g.DrawString('12', $fTiny, $dim, ($innerX + $innerW / 2 - 8), ($chartBottom + 2))
    $g.DrawString('23', $fTiny, $dim, ($innerX + $innerW - 18), ($chartBottom + 2))
  }
}

# Lower section: notes (memory card) or the ranking (digest), optionally in
# several columns so a short area still fits every row.
$notesTop = $by + $half
$g.DrawString([string]$data.notesLabel, $fHead, $amber, $innerX, ($notesTop + 34))
$notes = @($data.notes)
if ($notes.Count -eq 0) {
  $g.DrawString([string]$data.emptyNotes, $fBody, $dim, $innerX, ($notesTop + 72))
} else {
  $rows = [int][Math]::Ceiling($notes.Count / $noteColumns)
  $columnWidth = [int]($innerW / $noteColumns)
  $lineHeight = 30
  $botState = $g.Save()
  $botClip = New-Object System.Drawing.RectangleF $innerX, ($notesTop + 72), $innerW, ($bottomHeight - 96)
  $g.SetClip($botClip)
  for ($i = 0; $i -lt $notes.Count; $i++) {
    $col = [int][Math]::Floor($i / $rows)
    $row = $i % $rows
    $cx = $innerX + ($col * $columnWidth)
    $cy = $notesTop + 72 + ($row * $lineHeight)
    if ($cy + $lineHeight -gt ($notesTop + $bottomHeight - 20)) { break }
    # A trailing count is drawn right-aligned inside the column, so the name can
    # be truncated on its own and the numbers still line up.
    $count = $null
    if ($null -ne $notes[$i].count) { $count = [string]$notes[$i].count }
    $nameMax = $columnWidth - 48
    if ($null -ne $count -and $count -ne '') {
      $countWidth = $g.MeasureString($count, $fBody).Width
      $nameMax = $columnWidth - 56 - $countWidth
    }
    $text = Trim-ToWidth -Text ([string]$notes[$i].text) -Font $fBody -MaxWidth $nameMax
    $g.FillEllipse($amber, $cx, ($cy + 11), 6, 6)
    $g.DrawString($text, $fBody, $soft, ($cx + 20), $cy)
    if ($null -ne $count -and $count -ne '') {
      $g.DrawString($count, $fBody, $dim, ($cx + $columnWidth - 16 - $countWidth), $cy)
    }
  }
  $g.Restore($botState)
}

# --- usage note under the portrait, introduced by a short amber rule --------
$frameBottom = $py + $ph + $inset
$ruleY = $frameBottom + 34
$rulePen = New-Object System.Drawing.Pen $amberColor, 2
$g.DrawLine($rulePen, $px, $ruleY, ($px + 58), $ruleY)

$fy = $ruleY + 18
$footerWidth = $pw + 18
foreach ($line in (Wrap-Text -Text ([string]$data.footer) -Font $fFoot -MaxWidth $footerWidth)) {
  $g.DrawString($line, $fFoot, $dim, $px, $fy)
  $fy += 21
}

$g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"OK"


