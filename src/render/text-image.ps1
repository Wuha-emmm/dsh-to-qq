param(
  [Parameter(Mandatory = $true)][string]$TextPath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [int]$Width = 1080,
  [int]$FontSize = 22,
  [string]$Style = 'light'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$text = Get-Content -Path $TextPath -Raw -Encoding UTF8
if ([string]::IsNullOrWhiteSpace($text)) { throw 'empty text' }

$font = New-Object System.Drawing.Font('Microsoft YaHei UI', $FontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$pad = [int]($FontSize * 1.4)
$maxWidth = [float]($Width - 2 * $pad)

$probe = New-Object System.Drawing.Bitmap 1, 1
$probeGraphics = [System.Drawing.Graphics]::FromImage($probe)
$measured = $probeGraphics.MeasureString($text, $font, [int]$maxWidth)
$probeGraphics.Dispose()
$probe.Dispose()

$height = [int][Math]::Ceiling($measured.Height) + 2 * $pad
if ($height -lt 160) { $height = 160 }

$bitmap = New-Object System.Drawing.Bitmap $Width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

switch ($Style) {
  'dark' {
    $background = [System.Drawing.Color]::FromArgb(30, 30, 32)
    $foreground = [System.Drawing.Color]::FromArgb(236, 236, 240)
  }
  'bubble' {
    $background = [System.Drawing.Color]::FromArgb(242, 247, 255)
    $foreground = [System.Drawing.Color]::FromArgb(20, 20, 24)
  }
  default {
    $background = [System.Drawing.Color]::White
    $foreground = [System.Drawing.Color]::FromArgb(22, 22, 26)
  }
}

$graphics.Clear($background)

if ($Style -eq 'bubble') {
  $border = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(200, 218, 245)), 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 18
  $path.AddArc($r, $r, $r, $r, 180, 90)
  $path.AddArc($Width - 2 * $r, $r, $r, $r, 270, 90)
  $path.AddArc($Width - 2 * $r, $height - 2 * $r, $r, $r, 0, 90)
  $path.AddArc($r, $height - 2 * $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $graphics.DrawPath($border, $path)
  $border.Dispose()
  $path.Dispose()
}

$brush = New-Object System.Drawing.SolidBrush $foreground
$rect = New-Object System.Drawing.RectangleF $pad, $pad, $maxWidth, ($height - 2 * $pad)
$graphics.DrawString($text, $font, $brush, $rect)
$graphics.Dispose()
$bitmap.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$brush.Dispose()
$font.Dispose()

Write-Output $OutPath
