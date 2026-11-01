param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Target,
  [int]$Quality = 88,
  [int]$MaxEdge = 0
)

# Re-encode a screenshot as JPEG so the QQ upload is small. PNG stays the local
# original: the model reads that one when the detail matters.

Add-Type -AssemblyName System.Drawing

$image = [System.Drawing.Image]::FromFile($Source)
try {
  $width = $image.Width
  $height = $image.Height
  if ($MaxEdge -gt 0) {
    $ratio = [Math]::Min($MaxEdge / $width, $MaxEdge / $height)
    if ($ratio -lt 1) {
      $width = [Math]::Max(1, [int][Math]::Round($width * $ratio))
      $height = [Math]::Max(1, [int][Math]::Round($height * $ratio))
    }
  }

  $canvas = New-Object System.Drawing.Bitmap $width, $height
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    try {
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.DrawImage($image, 0, 0, $width, $height)
    } finally {
      $graphics.Dispose()
    }

    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
      Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    if ($null -eq $codec) { throw 'no jpeg encoder available' }
    $parameters = New-Object System.Drawing.Imaging.EncoderParameters 1
    $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
      [System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
    try {
      $canvas.Save($Target, $codec, $parameters)
    } finally {
      $parameters.Dispose()
    }
  } finally {
    $canvas.Dispose()
  }
} finally {
  $image.Dispose()
}
