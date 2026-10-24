<#
.SYNOPSIS
  Flash a blank AG32VF303 board through CMSIS-DAP SWD.

.DESCRIPTION
  A blank AG32 has no CPLD logic yet, so a normal firmware-only upload is
  not enough. This script builds PlatformIO's official batch image, which
  contains:
    - option bytes
    - compressed CPLD logic
    - MCU firmware

  The complete batch image is written in one SWD session. Afterward the
  script issues reset run so the new logic and firmware start normally.

.PARAMETER Environment
  PlatformIO environment. Default is logic_analyzer.

.PARAMETER AdapterSpeed
  CMSIS-DAP SWD clock in kHz. Default is 5000.

.PARAMETER AdapterSerial
  Optional CMSIS-DAP serial number when multiple probes are connected.

.PARAMETER BatchFile
  Use an existing *_batch.bin instead of building a new one.

.PARAMETER SkipBuild
  Use the newest *_batch.bin in the repository.

.PARAMETER UseSrst
  Connect under reset using the target's nRST line.

.PARAMETER SkipResetAfter
  Do not run reset run after programming.

.PARAMETER DryRun
  Print the commands without building or writing the chip.

.PARAMETER NoPause
  Do not wait for the wiring confirmation prompt.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\flash_blank_swd.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\flash_blank_swd.ps1 -AdapterSpeed 2500 -UseSrst

.NOTES
  DAPLink SWD wiring:
    SWDIO  ->  AG32 PIN_24 / JTMS
    SWCLK  ->  AG32 PIN_25 / JTCK
    GND    <-> GND
    3V3    ->  target VDD

  Keep BOOT0 low for normal SWD boot. Enable DAPLink J3V if the target is
  powered from the probe.

  If 5 MHz produces flash timeouts, retry with -AdapterSpeed 2500.
#>
[CmdletBinding()]
param(
    [string]$Environment = "logic_analyzer",

    [ValidateRange(1000, 10000)]
    [int]$AdapterSpeed = 5000,

    [string]$AdapterSerial,
    [string]$BatchFile,
    [switch]$SkipBuild,
    [switch]$UseSrst,
    [switch]$SkipResetAfter,
    [switch]$DryRun,
    [switch]$NoPause,
    [string]$PioPath,
    [string]$PythonPath,
    [string]$OoPath,
    [string]$OpenOcdCmdPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$platformIni = Join-Path $repoRoot "platformio.ini"
$toolRoot = Join-Path $env:USERPROFILE ".platformio"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    Write-Host ""
    Write-Host "==> $Description" -ForegroundColor Cyan
    Write-Host ("    {0} {1}" -f $FilePath, ($Arguments -join " "))

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Resolve-ExistingFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $candidate = if ([System.IO.Path]::IsPathRooted($Path)) {
        $Path
    }
    else {
        Join-Path $repoRoot $Path
    }

    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "$Label not found: $candidate"
    }

    return (Resolve-Path -LiteralPath $candidate).Path
}

if (-not (Test-Path -LiteralPath $platformIni -PathType Leaf)) {
    throw "platformio.ini not found. Expected repository root at $repoRoot."
}

if (-not $PioPath) {
    $PioPath = Join-Path $toolRoot "penv\Scripts\pio.exe"
}
if (-not $PythonPath) {
    $PythonPath = Join-Path $toolRoot "penv\Scripts\python.exe"
}
if (-not $OoPath) {
    $OoPath = Join-Path $toolRoot "platforms\AgRV\etc\oo"
}
if (-not $OpenOcdCmdPath) {
    $OpenOcdCmdPath = Join-Path $toolRoot "packages\tool-agrv_openocd\bin\openocd_cmd.bat"
}

$PioPath = Resolve-ExistingFile -Path $PioPath -Label "PlatformIO executable"
$PythonPath = Resolve-ExistingFile -Path $PythonPath -Label "PlatformIO Python executable"
$OoPath = Resolve-ExistingFile -Path $OoPath -Label "AG32 OpenOCD wrapper"
$OpenOcdCmdPath = Resolve-ExistingFile -Path $OpenOcdCmdPath -Label "AG32 OpenOCD command"

$iniText = Get-Content -LiteralPath $platformIni -Raw
if ($iniText -notmatch "(?m)^\s*logic_compress\s*=\s*true\s*$") {
    Write-Warning "logic_compress is not true in platformio.ini. Blank-chip option bytes may use the wrong logic layout."
}

Push-Location $repoRoot

if ($BatchFile) {
    $BatchFile = Resolve-ExistingFile -Path $BatchFile -Label "Batch image"
}
elseif (-not $SkipBuild) {
    $buildArgs = @("run", "-e", $Environment, "-t", "buildbatch")
    if ($DryRun) {
        Write-Host ""
        Write-Host "==> Build batch image" -ForegroundColor Cyan
        Write-Host ("    {0} {1}" -f $PioPath, ($buildArgs -join " "))
    }
    else {
        Invoke-Checked -FilePath $PioPath -Arguments $buildArgs -Description "Build official AG32 batch image"
    }
}

if (-not $BatchFile) {
    $batch = Get-ChildItem -LiteralPath $repoRoot -Filter "*_batch.bin" -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if ($batch) {
        $BatchFile = $batch.FullName
    }
    elseif ($DryRun) {
        $BatchFile = "<generated>_batch.bin"
    }
    else {
        throw "No *_batch.bin was generated. Build the CPLD logic and MCU first, then retry."
    }
}

if ($BatchFile -ne "<generated>_batch.bin") {
    if ($BatchFile -notmatch "_batch\.bin$") {
        throw "The selected image is not a batch image: $BatchFile"
    }
    if ((Get-Item -LiteralPath $BatchFile).Length -le 0) {
        throw "Batch image is empty: $BatchFile"
    }
}

Write-Host ""
Write-Host "Blank-chip SWD flash" -ForegroundColor Yellow
Write-Host "  Adapter   : CMSIS-DAP SWD"
Write-Host "  Speed     : $AdapterSpeed kHz"
Write-Host "  Batch     : $BatchFile"
Write-Host "  Wiring    : SWDIO/PIN_24, SWCLK/PIN_25, GND, 3V3"
Write-Host "  BOOT0     : low"
Write-Host ""

if (-not $NoPause -and -not $DryRun) {
    Write-Warning "Connect SWDIO, SWCLK, GND and 3V3. Keep BOOT0 low, then power the target."
    $answer = Read-Host "Type SWD to start"
    if ($answer -cne "SWD") {
        throw "Cancelled before programming."
    }
}

$openOcdDir = Join-Path $toolRoot "packages\tool-agrv_openocd\bin"
$agrvEtcDir = Join-Path $toolRoot "platforms\AgRV\etc"

$flashArgs = @(
    $OoPath,
    "-V",
    "-d", $openOcdDir,
    "-I", "agrv2k",
    "-A", "cmsis-dap",
    "-j", "swd",
    "-s", $AdapterSpeed.ToString(),
    "-g", "1"
)

if ($AdapterSerial) {
    $flashArgs += @("-S", $AdapterSerial)
}
if ($UseSrst) {
    $flashArgs += "-R"
}

$flashArgs += @("-N", $BatchFile)

$resetArgs = @(
    "-s", $agrvEtcDir,
    "-c", "variable ADAPTER_SPEED $AdapterSpeed",
    "-c", "variable ADAPTER cmsis-dap",
    "-c", "variable TRANSPORT swd"
)
if ($AdapterSerial) {
    $resetArgs += @("-c", "variable ADAPTER_SERIAL $AdapterSerial")
}
$resetArgs += @(
    "-f", "agrv2k.cfg",
    "-c", "reset run",
    "-c", "shutdown"
)

if ($DryRun) {
    Write-Host ""
    Write-Host "==> Flash blank chip over SWD" -ForegroundColor Cyan
    Write-Host ("    {0} {1}" -f $PythonPath, ($flashArgs -join " "))

    if (-not $SkipResetAfter) {
        Write-Host ""
        Write-Host "==> Resume target" -ForegroundColor Cyan
        Write-Host ("    {0} {1}" -f $OpenOcdCmdPath, ($resetArgs -join " "))
    }

    Write-Host ""
    Write-Host "Dry run complete." -ForegroundColor Green
    Pop-Location
    exit 0
}

Invoke-Checked -FilePath $PythonPath -Arguments $flashArgs -Description "Write batch image over SWD"

if (-not $SkipResetAfter) {
    Invoke-Checked -FilePath $OpenOcdCmdPath -Arguments $resetArgs -Description "Resume target after SWD programming"
}

Pop-Location

Write-Host ""
Write-Host "Blank-chip SWD flash completed." -ForegroundColor Green
if ($SkipResetAfter) {
    Write-Host "Target was left halted. Power-cycle it or run reset run before normal use."
}
else {
    Write-Host "The target has been reset and released."
}
