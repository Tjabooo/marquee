# Reads text out of images with Windows' built-in OCR engine (Windows.Media.Ocr, no install needed).
# stdin: a JSON array of file paths. stdout: one JSON line per file, {"i":n,"text":"..."} or {"i":n,"error":"..."}.
# Runs every OCR language installed in Windows (Settings > Time & language > Language) and keeps each line once.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Wait-Op($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(60000)
  if (-not $task.IsCompleted) { throw 'OCR timed out' }
  $task.Result
}

$engines = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($_) } | Where-Object { $_ })
if (-not $engines.Count) { [Console]::Error.WriteLine('No Windows OCR language is installed.'); exit 2 }
$max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
$parsed = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$paths = @($parsed)

for ($i = 0; $i -lt $paths.Count; $i++) {
  $stream = $null
  try {
    $file = Wait-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($paths[$i])) ([Windows.Storage.StorageFile])
    $stream = Wait-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Wait-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $w = [double]$decoder.OrientedPixelWidth; $h = [double]$decoder.OrientedPixelHeight
    # Small screenshots read better enlarged; huge photos must fit the engine's limit.
    $scale = 1.0
    if ([Math]::Max($w, $h) -lt 1200) { $scale = 2.0 }
    if ([Math]::Max($w, $h) * $scale -gt $max) { $scale = $max / [Math]::Max($w, $h) }
    $transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
    if ($scale -ne 1.0) {
      # Scaling applies before EXIF rotation, so use the stored (unrotated) size here.
      $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($decoder.PixelWidth * $scale))
      $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($decoder.PixelHeight * $scale))
      $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
    }
    $bitmap = Wait-Op ($decoder.GetSoftwareBitmapAsync(
      [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $transform,
      [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
    )) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $lines = [Collections.Generic.List[string]]::new()
    foreach ($engine in $engines) {
      $result = Wait-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      foreach ($line in $result.Lines) { $t = $line.Text.Trim(); if ($t -and $seen.Add($t)) { $lines.Add($t) } }
    }
    $bitmap.Dispose()
    [Console]::Out.WriteLine((@{ i = $i; text = ($lines -join "`n") } | ConvertTo-Json -Compress))
  } catch {
    $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
    $message = $e.Message
    [Console]::Out.WriteLine((@{ i = $i; error = [string]$message } | ConvertTo-Json -Compress))
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}
