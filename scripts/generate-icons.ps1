<#
Generates the app icon (a simple tomato/timer mark) as PNGs and a multi-size ICO
without needing any external tools, using .NET System.Drawing (available on
Windows PowerShell). Re-run this any time you want to tweak the artwork.

Once the Rust/Node toolchain is installed, `cargo tauri icon <source.png>` can
regenerate a more complete icon set from a single high-res source image if
you want to replace this placeholder later.
#>

Add-Type -AssemblyName System.Drawing

function New-PomedoroIcon {
    param([int]$Size)

    $bmp = [System.Drawing.Bitmap]::new($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $pad = $Size * 0.06
    $bodyRect = [System.Drawing.RectangleF]::new($pad, ($pad + $Size * 0.06), ($Size - 2 * $pad), ($Size - 2 * $pad - $Size * 0.06))

    $bodyBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        $bodyRect,
        [System.Drawing.Color]::FromArgb(255, 255, 138, 101),
        [System.Drawing.Color]::FromArgb(255, 230, 74, 58),
        [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
    )
    $g.FillEllipse($bodyBrush, $bodyRect)

    # leaf
    $leafBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 96, 189, 104))
    $leafW = $Size * 0.30
    $leafH = $Size * 0.20
    $leafRect1 = [System.Drawing.RectangleF]::new((($Size / 2) - $leafW * 0.9), ($Size * 0.02), $leafW, $leafH)
    $leafRect2 = [System.Drawing.RectangleF]::new((($Size / 2) - $leafW * 0.1), ($Size * 0.02), $leafW, $leafH)
    $g.FillEllipse($leafBrush, $leafRect1)
    $g.FillEllipse($leafBrush, $leafRect2)

    # stem
    $stemBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 76, 140, 82))
    $stemRect = [System.Drawing.RectangleF]::new((($Size / 2) - $Size * 0.02), ($Size * 0.02), ($Size * 0.04), ($Size * 0.10))
    $g.FillRectangle($stemBrush, $stemRect)

    # clock face (small, off-center highlight) to nod to "timer"
    $faceD = $bodyRect.Width * 0.46
    $faceRect = [System.Drawing.RectangleF]::new(($bodyRect.X + $bodyRect.Width * 0.27), ($bodyRect.Y + $bodyRect.Height * 0.27), $faceD, $faceD)
    $faceBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(235, 255, 247, 240))
    $g.FillEllipse($faceBrush, $faceRect)

    $cx = $faceRect.X + $faceRect.Width / 2
    $cy = $faceRect.Y + $faceRect.Height / 2
    $penColor = [System.Drawing.Color]::FromArgb(255, 200, 60, 45)
    $penWidth = [Math]::Max(1, $Size * 0.02)
    $pen = [System.Drawing.Pen]::new($penColor, $penWidth)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($pen, $cx, $cy, $cx, $cy - $faceRect.Height * 0.32)
    $g.DrawLine($pen, $cx, $cy, $cx + $faceRect.Width * 0.22, $cy + $faceRect.Height * 0.10)

    $g.Dispose()
    return $bmp
}

function Save-Png {
    param([System.Drawing.Bitmap]$Bitmap, [string]$Path)
    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Get-PngBytes {
    param([System.Drawing.Bitmap]$Bitmap)
    $ms = [System.IO.MemoryStream]::new()
    $Bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return $ms.ToArray()
}

function Save-MultiSizeIco {
    param([int[]]$Sizes, [string]$Path)

    $images = foreach ($s in $Sizes) {
        $bmp = New-PomedoroIcon -Size $s
        [PSCustomObject]@{ Size = $s; Bytes = Get-PngBytes -Bitmap $bmp }
    }

    $fs = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Create)
    $bw = [System.IO.BinaryWriter]::new($fs)

    # ICONDIR
    $bw.Write([UInt16]0)        # reserved
    $bw.Write([UInt16]1)        # type = icon
    $bw.Write([UInt16]$images.Count)

    $headerSize = 6 + (16 * $images.Count)
    $offset = $headerSize

    foreach ($img in $images) {
        $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
        $bw.Write([Byte]$dim)          # width
        $bw.Write([Byte]$dim)          # height
        $bw.Write([Byte]0)             # color count
        $bw.Write([Byte]0)             # reserved
        $bw.Write([UInt16]1)           # planes
        $bw.Write([UInt16]32)          # bit count
        $bw.Write([UInt32]$img.Bytes.Length)
        $bw.Write([UInt32]$offset)
        $offset += $img.Bytes.Length
    }

    foreach ($img in $images) {
        # Explicit cast: PowerShell boxes the array into Object[] when it
        # passes through the PSCustomObject property assignment above, which
        # would otherwise make BinaryWriter resolve the wrong Write() overload.
        $bw.Write([byte[]]$img.Bytes)
    }

    $bw.Flush()
    $bw.Close()
    $fs.Close()
}

$iconsDir = Join-Path $PSScriptRoot "..\src-tauri\icons"
New-Item -ItemType Directory -Force -Path $iconsDir | Out-Null

Save-Png -Bitmap (New-PomedoroIcon -Size 32)  -Path (Join-Path $iconsDir "32x32.png")
Save-Png -Bitmap (New-PomedoroIcon -Size 128) -Path (Join-Path $iconsDir "128x128.png")
Save-Png -Bitmap (New-PomedoroIcon -Size 256) -Path (Join-Path $iconsDir "128x128@2x.png")
Save-Png -Bitmap (New-PomedoroIcon -Size 512) -Path (Join-Path $iconsDir "icon.png")
Save-MultiSizeIco -Sizes @(16, 32, 48, 256) -Path (Join-Path $iconsDir "icon.ico")

Write-Output "Icons written to $iconsDir"
