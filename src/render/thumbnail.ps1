param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Target,
  [int]$Size = 160
)

Add-Type -AssemblyName System.Drawing

$image = [System.Drawing.Image]::FromFile($Source)
try {
  $ratio = [Math]::Min($Size / $image.Width, $Size / $image.Height)
  if ($ratio -gt 1) { $ratio = 1 }
  $width = [Math]::Max(1, [int][Math]::Round($image.Width * $ratio))
  $height = [Math]::Max(1, [int][Math]::Round($image.Height * $ratio))

  $canvas = New-Object System.Drawing.Bitmap $width, $height
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.DrawImage($image, 0, 0, $width, $height)
    } finally {
      $graphics.Dispose()
    }
    $canvas.Save($Target, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $canvas.Dispose()
  }
} finally {
  $image.Dispose()
}
