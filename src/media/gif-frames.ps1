param(
  [Parameter(Mandatory = $true)][string]$InPath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [int]$Max = 9,
  [int]$Cell = 256
)

# Draw up to $Max frames of an animated image into one contact sheet, so a
# model sees how the picture moves instead of only its first frame.

Add-Type -AssemblyName System.Drawing

$image = [System.Drawing.Image]::FromFile($InPath)
try {
  $dimension = New-Object System.Drawing.Imaging.FrameDimension $image.FrameDimensionsList[0]
  $total = $image.GetFrameCount($dimension)
  $frames = [Math]::Min($Max, $total)
  if ($frames -le 0) { throw 'no frames' }

  $columns = [Math]::Min(3, $frames)
  $rows = [Math]::Ceiling($frames / $columns)
  $sheet = New-Object System.Drawing.Bitmap ($columns * $Cell), ($rows * $Cell)
  $graphics = [System.Drawing.Graphics]::FromImage($sheet)
  try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    for ($index = 0; $index -lt $frames; $index++) {
      [void]$image.SelectActiveFrame($dimension, $index)
      $scale = [Math]::Min($Cell / $image.Width, $Cell / $image.Height)
      $width = [int]($image.Width * $scale)
      $height = [int]($image.Height * $scale)
      $left = ($index % $columns) * $Cell + [int](($Cell - $width) / 2)
      $top = [Math]::Floor($index / $columns) * $Cell + [int](($Cell - $height) / 2)
      $graphics.DrawImage($image, $left, $top, $width, $height)
    }
  } finally {
    $graphics.Dispose()
  }

  $sheet.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $sheet.Dispose()
  Write-Output "$frames/$total"
} finally {
  $image.Dispose()
}
