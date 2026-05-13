<#
.SYNOPSIS
  Batch-export every slide of every PowerPoint in a folder tree to JPEG.

.DESCRIPTION
  Walks the source folder recursively, finds every .pptx (and .ppt) file,
  and uses Microsoft PowerPoint's COM automation to export each slide
  as a JPEG image.

  For each presentation it creates an output folder and writes:
    Slide1.JPG, Slide2.JPG, ... (one JPEG per slide)
    metadata.json              (source path, hash, slide count, etc.)

  The output folder name comes from the source filename's stem (the
  filename minus its extension), placed under a single _exports root.
  If two source files have the same stem, the second one gets a "-2",
  "-3", etc. suffix so nothing is overwritten.

  IDEMPOTENT: a second run skips presentations whose source file size
  AND last-modified time match the recorded metadata. Pass -Force to
  re-export everything regardless. Pass -DryRun to list what would be
  done without doing it.

.PARAMETER SourceFolder
  Folder to walk (recursively). All .pptx / .ppt files anywhere
  beneath it will be processed.

.PARAMETER OutputFolder
  Where to write the _exports root. Defaults to "_exports" inside the
  current directory.

.PARAMETER Width
  JPEG width in pixels. Default 1280.

.PARAMETER Height
  JPEG height in pixels. Default 720.

.PARAMETER Force
  Re-export even if metadata.json says the source hasn't changed.

.PARAMETER DryRun
  List what would be exported without launching PowerPoint.

.EXAMPLE
  .\Convert-PptToJpegs.ps1 -SourceFolder "C:\Users\noren\Sermons"

  Walks C:\Users\noren\Sermons recursively and writes JPEGs to
  .\_exports\<source-stem>\Slide1.JPG (etc.) under the current dir.

.EXAMPLE
  .\Convert-PptToJpegs.ps1 -SourceFolder "D:\Sermons" `
                           -OutputFolder "D:\SermonExports" `
                           -Width 1920 -Height 1080

  Higher-resolution export to a custom location.

.EXAMPLE
  .\Convert-PptToJpegs.ps1 -SourceFolder "D:\Sermons" -DryRun

  See what would be exported without actually opening PowerPoint.

.NOTES
  Requires Microsoft PowerPoint to be installed locally (this script
  uses COM automation, not a headless converter).

  Built for Pastor Todd's WFUMC Sermon Archive - Phase B of the
  manuscript+slides batch importer pipeline.

  IMPORTANT: keep this script ASCII-only (no fancy unicode) so Windows
  PowerShell 5.1 parses it correctly even without a UTF-8 BOM.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true, Position=0)]
  [string]$SourceFolder,

  [Parameter(Position=1)]
  [string]$OutputFolder = (Join-Path (Get-Location) '_exports'),

  [int]$Width  = 1280,
  [int]$Height = 720,

  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ScriptVersion = '1.0.1'

# ----------------------------------------------------------------------
# Setup + sanity checks
# ----------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $SourceFolder -PathType Container)) {
  Write-Host "[ERROR] Source folder not found: $SourceFolder" -ForegroundColor Red
  exit 1
}
$SourceFolder = (Resolve-Path -LiteralPath $SourceFolder).Path

if (-not (Test-Path -LiteralPath $OutputFolder)) {
  if ($DryRun) {
    Write-Host "(dry-run) would create output folder: $OutputFolder" -ForegroundColor DarkGray
  } else {
    New-Item -ItemType Directory -Path $OutputFolder -Force | Out-Null
  }
}
if (Test-Path -LiteralPath $OutputFolder) {
  $OutputFolder = (Resolve-Path -LiteralPath $OutputFolder).Path
}

Write-Host ""
Write-Host "PowerPoint -> JPEG batch exporter" -ForegroundColor Cyan
Write-Host "---------------------------------" -ForegroundColor Cyan
Write-Host "  Source : $SourceFolder"
Write-Host "  Output : $OutputFolder"
Write-Host "  Size   : ${Width}x${Height}"
if ($Force)  { Write-Host "  Force  : YES (will re-export everything)" -ForegroundColor Yellow }
if ($DryRun) { Write-Host "  Mode   : DRY-RUN (no exports will run)" -ForegroundColor Yellow }
Write-Host ""

# ----------------------------------------------------------------------
# Find every .pptx / .ppt under the source folder
# ----------------------------------------------------------------------

# NOTE: `Get-ChildItem -Include` is broken when used with `-LiteralPath`
# pointed at a directory (it returns everything instead of filtering).
# So we get every file and filter by extension ourselves.
$presentations = Get-ChildItem -LiteralPath $SourceFolder -Recurse -File `
                   -ErrorAction SilentlyContinue |
                 Where-Object {
                   $_.Extension -match '^\.pptx?$' -and
                   $_.Name -notmatch '^~\$'   # skip Office lock files
                 }

if (-not $presentations -or $presentations.Count -eq 0) {
  Write-Host "No .pptx or .ppt files found under $SourceFolder" -ForegroundColor Yellow
  exit 0
}

Write-Host "Found $($presentations.Count) presentation(s)." -ForegroundColor Green
Write-Host ""

# ----------------------------------------------------------------------
# Output-folder naming: use the file stem; on collision, append -2, -3
# ----------------------------------------------------------------------

$usedNames = @{}
function Resolve-OutputFolder {
  param([System.IO.FileInfo]$File)
  $stem = [System.IO.Path]::GetFileNameWithoutExtension($File.Name)
  # Strip characters that are illegal in folder names.
  $stem = ($stem -replace '[<>:"/\\|?*]', '_').Trim()
  if (-not $stem) { $stem = 'untitled' }
  $candidate = $stem
  $n = 2
  while ($usedNames.ContainsKey($candidate)) {
    $candidate = "$stem-$n"
    $n++
  }
  $usedNames[$candidate] = $true
  return Join-Path $OutputFolder $candidate
}

# ----------------------------------------------------------------------
# Idempotency: read metadata.json from a prior run, if any
# ----------------------------------------------------------------------

function Get-PriorMetadata {
  param([string]$FolderPath)
  $metaPath = Join-Path $FolderPath 'metadata.json'
  if (-not (Test-Path -LiteralPath $metaPath)) { return $null }
  try {
    return Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-SourceUnchanged {
  param(
    [System.IO.FileInfo]$File,
    [object]$PriorMeta
  )
  if (-not $PriorMeta) { return $false }
  if ($PriorMeta.sourceSize -ne $File.Length) { return $false }
  # Compare mtime to nearest second to avoid float drift.
  $priorTime = [datetime]::Parse($PriorMeta.sourceMtime).ToUniversalTime()
  $currTime  = $File.LastWriteTimeUtc
  $deltaSec  = [Math]::Abs(($priorTime - $currTime).TotalSeconds)
  return ($deltaSec -lt 2)
}

# ----------------------------------------------------------------------
# Plan first - print what we are about to do
# ----------------------------------------------------------------------

$plan = @()
foreach ($pres in $presentations) {
  $outFolder = Resolve-OutputFolder -File $pres
  $prior     = Get-PriorMetadata -FolderPath $outFolder
  $skip      = (-not $Force) -and (Test-SourceUnchanged -File $pres -PriorMeta $prior)
  $plan += [pscustomobject]@{
    Source     = $pres
    OutFolder  = $outFolder
    PriorMeta  = $prior
    Skip       = $skip
  }
}

$toExport = @($plan | Where-Object { -not $_.Skip })
$toSkip   = @($plan | Where-Object {     $_.Skip })

Write-Host "Plan:" -ForegroundColor Cyan
Write-Host "  $($toExport.Count) to export"
Write-Host "  $($toSkip.Count) up-to-date (will skip)"
Write-Host ""

if ($DryRun) {
  Write-Host "Dry-run breakdown:" -ForegroundColor Yellow
  foreach ($p in $plan) {
    $marker = if ($p.Skip) { '[skip]' } else { '[do  ]' }
    $color  = if ($p.Skip) { 'DarkGray' } else { 'White' }
    Write-Host ("  {0} {1}  ->  {2}" -f $marker, $p.Source.Name, (Split-Path -Leaf $p.OutFolder)) -ForegroundColor $color
  }
  Write-Host ""
  Write-Host "Dry-run complete. Re-run without -DryRun to perform the exports." -ForegroundColor Yellow
  exit 0
}

if ($toExport.Count -eq 0) {
  Write-Host "Nothing to do - every presentation is already up-to-date." -ForegroundColor Green
  exit 0
}

# ----------------------------------------------------------------------
# Launch PowerPoint
# ----------------------------------------------------------------------

Write-Host "Launching PowerPoint..." -ForegroundColor Cyan
try {
  $ppt = New-Object -ComObject PowerPoint.Application
} catch {
  Write-Host "[ERROR] Could not launch PowerPoint via COM. Is Microsoft PowerPoint installed?" -ForegroundColor Red
  Write-Host "  $_" -ForegroundColor Red
  exit 1
}

# Some PowerPoint installs require Visible during automation; mark as
# minimized so it does not grab focus repeatedly. (PpWindowState: 2 = min)
try { $ppt.WindowState = 2 } catch { }

$results = @{ exported = 0; skipped = $toSkip.Count; failed = 0; errors = @() }

# ----------------------------------------------------------------------
# Per-file export loop
# ----------------------------------------------------------------------

$counter = 0
foreach ($p in $toExport) {
  $counter++
  $relName = $p.Source.FullName.Substring($SourceFolder.Length).TrimStart('\','/')
  Write-Host ("[{0}/{1}] {2}" -f $counter, $toExport.Count, $relName) -ForegroundColor White

  $pres = $null
  try {
    # Remove any prior export folder to avoid stale slides hanging around
    # (e.g. if the source now has fewer slides than last time).
    if (Test-Path -LiteralPath $p.OutFolder) {
      Remove-Item -LiteralPath $p.OutFolder -Recurse -Force
    }
    New-Item -ItemType Directory -Path $p.OutFolder -Force | Out-Null

    # Open read-only, no window.
    # Open(FileName, ReadOnly, Untitled, WithWindow)
    #   msoTrue  =  -1
    #   msoFalse =   0
    $pres = $ppt.Presentations.Open($p.Source.FullName, $true, $false, $false)
    $slideCount = $pres.Slides.Count

    for ($i = 1; $i -le $slideCount; $i++) {
      $slide = $pres.Slides.Item($i)
      $outFile = Join-Path $p.OutFolder ("Slide{0}.JPG" -f $i)
      $slide.Export($outFile, 'JPG', $Width, $Height) | Out-Null
    }

    # Sidecar metadata for the importer (Phase C) and for our own
    # idempotency check on the next run.
    $meta = [ordered]@{
      schemaVersion = 1
      scriptVersion = $ScriptVersion
      sourcePath    = $p.Source.FullName
      sourceName    = $p.Source.Name
      sourceSize    = $p.Source.Length
      sourceMtime   = $p.Source.LastWriteTimeUtc.ToString('o')
      slideCount    = $slideCount
      width         = $Width
      height        = $Height
      exportedAt    = (Get-Date).ToUniversalTime().ToString('o')
    }
    $metaPath = Join-Path $p.OutFolder 'metadata.json'
    $meta | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $metaPath -Encoding UTF8

    Write-Host ("  [OK] exported {0} slides -> {1}" -f $slideCount, (Split-Path -Leaf $p.OutFolder)) -ForegroundColor Green
    $results.exported++
  } catch {
    Write-Host ("  [FAIL] {0}" -f $_.Exception.Message) -ForegroundColor Red
    $results.failed++
    $results.errors += [pscustomobject]@{
      source = $p.Source.FullName
      error  = $_.Exception.Message
    }
  } finally {
    if ($pres) {
      try { $pres.Close() } catch { }
      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($pres) | Out-Null
      $pres = $null
    }
  }
}

# ----------------------------------------------------------------------
# Cleanup
# ----------------------------------------------------------------------

try { $ppt.Quit() } catch { }
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
[gc]::Collect()
[gc]::WaitForPendingFinalizers()

# Write a run log alongside the _exports root for debugging.
$runLog = [ordered]@{
  ranAt        = (Get-Date).ToUniversalTime().ToString('o')
  sourceFolder = $SourceFolder
  outputFolder = $OutputFolder
  width        = $Width
  height       = $Height
  exported     = $results.exported
  skipped      = $results.skipped
  failed       = $results.failed
  errors       = $results.errors
}
$runLogPath = Join-Path $OutputFolder ('run-{0}.json' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$runLog | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $runLogPath -Encoding UTF8

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------

Write-Host ""
Write-Host "---------------------------------" -ForegroundColor Cyan
Write-Host "Summary" -ForegroundColor Cyan
Write-Host "---------------------------------" -ForegroundColor Cyan
Write-Host ("  Exported : {0}" -f $results.exported) -ForegroundColor Green
Write-Host ("  Skipped  : {0}" -f $results.skipped) -ForegroundColor DarkGray
if ($results.failed -gt 0) {
  Write-Host ("  Failed   : {0}" -f $results.failed) -ForegroundColor Red
  Write-Host ""
  Write-Host "  Failures (also recorded in $runLogPath):" -ForegroundColor Red
  foreach ($e in $results.errors) {
    Write-Host ("    - {0}" -f $e.source) -ForegroundColor Red
    Write-Host ("        {0}"  -f $e.error)  -ForegroundColor DarkGray
  }
}
Write-Host ""
Write-Host "Output folder: $OutputFolder" -ForegroundColor White
Write-Host ""

if ($results.failed -gt 0) { exit 1 }
exit 0
