<#
.SYNOPSIS
  Creates (or with -Remove deletes) the Start Menu shortcut "Agent Meter".

.DESCRIPTION
  The app runs unpackaged, so the shortcut starts Electron with the app folder
  as its first argument:
    <app>\node_modules\electron\dist\electron.exe "<app>"
  electron.exe is a GUI program, so no console window opens. Launching the
  shortcut while Agent Meter is already running opens its panel instead
  (single-instance hand-over).

  Start with Windows is NOT set here: that is the tray menu's "Start with
  Windows" checkbox (HKCU\...\Run, written by the app itself).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1 -Remove
#>
[CmdletBinding()]
param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$AppDir   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Electron = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
$Icon     = Join-Path $AppDir 'assets\icon.ico'
$Programs = [Environment]::GetFolderPath('Programs')  # %APPDATA%\Microsoft\Windows\Start Menu\Programs
$Lnk      = Join-Path $Programs 'Agent Meter.lnk'

if ($Remove) {
  if (Test-Path -LiteralPath $Lnk) {
    Remove-Item -LiteralPath $Lnk -Force
    Write-Output "Removed $Lnk"
  } else {
    Write-Output "Nothing to remove: $Lnk does not exist"
  }
  return
}

if (-not (Test-Path -LiteralPath $Electron)) {
  throw "Electron not found at $Electron. Run 'npm install' in $AppDir first."
}
if (-not (Test-Path -LiteralPath $Icon)) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { & $node.Source (Join-Path $AppDir 'scripts\make-icons.js') | Out-Null }
}

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($Lnk)
$link.TargetPath = $Electron
$link.Arguments = '"' + $AppDir + '"'
$link.WorkingDirectory = $AppDir
if (Test-Path -LiteralPath $Icon) { $link.IconLocation = "$Icon,0" }
$link.Description = 'Agent Meter: coding-agent limits, tokens and cost'
$link.WindowStyle = 1
$link.Save()

Write-Output "Created $Lnk"
Write-Output "  target: $Electron `"$AppDir`""
Write-Output "  icon:   $Icon"
