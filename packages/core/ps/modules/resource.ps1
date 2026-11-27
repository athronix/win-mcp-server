# resource.ps1 -- win-resource capability module
# ASCII only (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

Set-StrictMode -Version 1
$ErrorActionPreference = 'Stop'

function Get-ResourceMetrics {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem

    $cpuPercent = 0
    try {
        $cpuCounters = @(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -ErrorAction Stop |
            Where-Object { $_.Name -eq '_Total' })
        if ($cpuCounters.Count -gt 0) { $cpuPercent = [int]$cpuCounters[0].PercentProcessorTime }
    }
    catch { }

    $gpuName = ''
    $gpuDriver = ''
    try {
        $gpus = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop | Select-Object -First 1)
        if ($gpus.Count -gt 0) {
            $gpuName = [string]$gpus[0].Name
            $gpuDriver = [string]$gpus[0].DriverVersion
        }
    }
    catch { }

    $processCount = 0
    try { $processCount = @(Get-Process).Count } catch { }

    $memoryTotalMB = [math]::Round(($os.TotalVisibleMemorySize / 1KB), 0)
    $memoryFreeMB = [math]::Round(($os.FreePhysicalMemory / 1KB), 0)
    $memoryUsedPercent = 0
    if ($memoryTotalMB -gt 0) {
        $memoryUsedPercent = [int][math]::Round((($memoryTotalMB - $memoryFreeMB) / $memoryTotalMB) * 100, 0)
    }

    [ordered]@{
        cpuPercent        = $cpuPercent
        memoryTotalMB     = $memoryTotalMB
        memoryFreeMB      = $memoryFreeMB
        memoryUsedPercent = $memoryUsedPercent
        processCount      = $processCount
        gpuName           = $gpuName
        gpuDriverVersion  = $gpuDriver
        capturedAt        = (Get-Date).ToString('o')
    }
}

function Get-VolumeSpace {
    $items = @()
    $volumes = @(Get-Volume -ErrorAction SilentlyContinue)
    foreach ($volume in $volumes) {
        $letter = ''
        try { $letter = [string]$volume.DriveLetter } catch { }
        if ([string]::IsNullOrWhiteSpace($letter)) { continue }

        $sizeGB = [math]::Round(($volume.Size / 1GB), 2)
        $freeGB = [math]::Round(($volume.SizeRemaining / 1GB), 2)
        $usedPercent = 0
        if ($volume.Size -gt 0) {
            $usedPercent = [int][math]::Round((($volume.Size - $volume.SizeRemaining) / $volume.Size) * 100, 0)
        }
        $items += [ordered]@{
            drive       = "${letter}:"
            label       = [string]$volume.FileSystemLabel
            fileSystem  = [string]$volume.FileSystem
            sizeGB      = $sizeGB
            freeGB      = $freeGB
            usedPercent = $usedPercent
            health      = [string]$volume.HealthStatus
        }
    }
    [ordered]@{ items = $items; count = $items.Count }
}

function Get-DirectorySizeMB {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return 0 }
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    try {
        $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
        if ($null -eq $sum) { return 0 }
        return [math]::Round(([double]$sum / 1MB), 1)
    }
    catch { return 0 }
}

function Get-CleanupAnalysis {
    $targets = @(
        [ordered]@{ name = 'user-temp'; path = $env:TEMP; note = 'current user temp folder' },
        [ordered]@{ name = 'windows-temp'; path = (Join-Path $env:SystemRoot 'Temp'); note = 'system temp folder (may need admin)' }
    )

    $items = @()
    $totalMB = 0
    foreach ($target in $targets) {
        $sizeMB = Get-DirectorySizeMB -Path $target.path
        $fileCount = 0
        try {
            if (Test-Path -LiteralPath $target.path) {
                $fileCount = @(Get-ChildItem -LiteralPath $target.path -Recurse -File -Force -ErrorAction SilentlyContinue).Count
            }
        }
        catch { }
        $totalMB += $sizeMB
        $items += [ordered]@{
            name      = $target.name
            path      = $target.path
            sizeMB    = $sizeMB
            fileCount = $fileCount
            note      = $target.note
        }
    }
    [ordered]@{ items = $items; count = $items.Count; totalMB = [math]::Round($totalMB, 1) }
}

function Clear-UserTempFiles {
    param([int]$OlderThanMinutes = 0, [int]$MaxDelete = 2000)

    $targetPath = $env:TEMP
    if ([string]::IsNullOrWhiteSpace($targetPath)) { throw 'INVALID_ENV: TEMP is not set' }
    if (-not (Test-Path -LiteralPath $targetPath)) { return [ordered]@{ deleted = 0; freedMB = 0; path = $targetPath } }

    $cutoff = (Get-Date).AddMinutes(-1 * [math]::Abs($OlderThanMinutes))
    $deleted = 0
    $freedBytes = 0
    $failed = 0

    $files = @(Get-ChildItem -LiteralPath $targetPath -File -Force -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -First $MaxDelete)

    foreach ($file in $files) {
        if ($OlderThanMinutes -gt 0 -and $file.LastWriteTime -gt $cutoff) { continue }
        $size = 0
        try { $size = [int64]$file.Length } catch { }
        try {
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
            $deleted += 1
            $freedBytes += $size
        }
        catch {
            $failed += 1
        }
    }

    [ordered]@{
        path       = $targetPath
        deleted    = $deleted
        failed     = $failed
        freedMB    = [math]::Round(([double]$freedBytes / 1MB), 1)
        olderThanMinutes = $OlderThanMinutes
    }
}