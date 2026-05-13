# Sermon Archive helper scripts

PowerShell utilities that run on your Windows machine (not in the
deployed web app) to prepare batch data for the importers.

## Convert-PptToJpegs.ps1

Walks a folder tree, finds every `.pptx` / `.ppt`, and exports each
slide as a JPEG image using Microsoft PowerPoint's COM automation.
Output is organized so the in-app **slide-deck batch importer**
(Phase C, coming next) can pick it up directly.

### Requirements

- Windows
- Microsoft PowerPoint installed (any version with COM support — i.e.
  not the web-only or Microsoft Store sandboxed version)
- PowerShell 5.1+ (ships with Windows) or PowerShell 7+

### Quick start

```powershell
# Dry-run first to see what it would do (no PowerPoint launched)
.\Convert-PptToJpegs.ps1 -SourceFolder "C:\Users\noren\Sermons" -DryRun

# Real run: outputs to .\_exports\<sermon-stem>\Slide1.JPG (etc.)
.\Convert-PptToJpegs.ps1 -SourceFolder "C:\Users\noren\Sermons"

# Custom output location and higher resolution
.\Convert-PptToJpegs.ps1 `
  -SourceFolder "D:\Sermons" `
  -OutputFolder "D:\SermonExports" `
  -Width 1920 -Height 1080
```

### Output shape

Each presentation lands in its own subfolder under `_exports/`:

```
_exports/
├── Don't Shoot the Messenger - Matthew 24 36-44/
│   ├── Slide1.JPG
│   ├── Slide2.JPG
│   ├── Slide3.JPG
│   └── metadata.json
├── I'm Coming - Matthew 24 36-44 - Advent 1/
│   ├── Slide1.JPG
│   └── metadata.json
└── run-20260513-180022.json     ← log of this run's results
```

`metadata.json` records the source path, file size + mtime, slide
count, and resolution. The script uses this on subsequent runs to
**skip presentations that haven't changed** since the last export.

### Idempotency

Re-running the script is safe and fast:

- **Unchanged sources** are skipped (matched by file size + mtime).
- **Modified sources** get re-exported (old slides deleted first so
  stale slides don't linger if the source now has fewer).
- Pass `-Force` to re-export everything regardless.

### Troubleshooting

- **"Could not launch PowerPoint via COM"** — install desktop
  PowerPoint, or check that you're not running the Microsoft Store
  (sandboxed) version, which doesn't expose COM.
- **PowerPoint pops up windows during the run** — the script tries to
  minimize it (`WindowState = 2`), but some installs ignore this. Just
  let it run; it'll close when done.
- **Script blocked by execution policy** — run once with
  `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`
  or invoke via `powershell -ExecutionPolicy Bypass -File .\Convert-PptToJpegs.ps1 ...`.
- **Office lock files** (`~$Filename.pptx`) are auto-skipped — they're
  artifacts of having the file open in another program.

### Performance notes

PowerPoint COM is sequential — one presentation at a time. Rough
budget: ~3-8 seconds per slide on a typical laptop, so 200 sermons ×
~10 slides ≈ 30-90 minutes for the first full run. Subsequent runs
that only touch new/changed presentations finish in seconds.
