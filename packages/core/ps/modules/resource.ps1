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
# ---------------------------------------------------------------------------
# CL-014: declarative tuning catalog + snapshot / one-click rollback
# ---------------------------------------------------------------------------
# Catalog is hard-coded on purpose: a user-editable catalog file would be an
# arbitrary-write primitive reachable from the LLM. Only these keys exist.

$script:TuneRoot = Join-Path $env:LOCALAPPDATA 'win-mcp\tune-snapshots'

$script:TuneCatalog = @{
    'explorer.show-file-extensions' = @{
        kind          = 'registry'
        path          = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/Advanced'
        name          = 'HideFileExt'
        type          = 'DWord'
        target        = 0
        requiresAdmin = $false
        description   = 'Show known file extensions in Explorer (HideFileExt=0)'
    }
    'explorer.menu-delay' = @{
        kind          = 'registry'
        path          = 'HKCU:/Control Panel\Desktop'
        name          = 'MenuShowDelay'
        type          = 'String'
        target        = '0'
        requiresAdmin = $false
        description   = 'Remove the menu show delay (MenuShowDelay=0)'
    }
    'explorer.visual-effects' = @{
        kind          = 'registry'
        path          = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Explorer/VisualEffects'
        name          = 'VisualFXSetting'
        type          = 'DWord'
        target        = 2
        requiresAdmin = $false
        description   = 'Favour performance for visual effects (VisualFXSetting=2)'
    }
    'power.high-performance' = @{
        kind          = 'power'
        scheme        = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
        requiresAdmin = $false
        description   = 'Switch the active power plan to High performance'
    }
    'service.diagtrack-manual' = @{
        kind          = 'service'
        name          = 'DiagTrack'
        startMode     = 'Manual'
        requiresAdmin = $true
        description   = 'Set DiagTrack (Connected User Experiences and Telemetry) startup to Manual'
    }
    'system.network-throttling' = @{
        kind          = 'registry'
        path          = 'HKLM:/SOFTWARE/Microsoft/Windows NT\CurrentVersion\Multimedia\SystemProfile'
        name          = 'NetworkThrottlingIndex'
        type          = 'DWord'
        target        = 4294967295
        requiresAdmin = $true
        description   = 'Disable multimedia network throttling (NetworkThrottlingIndex=0xFFFFFFFF)'
    }
}

function Get-TuneRegistryValue {
    param([string]$Path, [string]$Name)

    if (-not (Test-Path -LiteralPath $Path)) {
        return [ordered]@{ existed = $false; value = $null; type = $null; keyExisted = $false }
    }
    $keyItem = Get-Item -LiteralPath $Path
    $nameExists = ($keyItem.GetValueNames() -contains $Name)
    if (-not $nameExists) {
        return [ordered]@{ existed = $false; value = $null; type = $null; keyExisted = $true }
    }
    $valueType = 'String'
    try { $valueType = [string]$keyItem.GetValueKind($Name) } catch { }
    $raw = $keyItem.GetValue($Name)
    $plain = ''
    if ($null -ne $raw) {
        if ($raw -is [array]) { $plain = ($raw | ForEach-Object { [string]$_ }) -join "`n" }
        else { $plain = [string]$raw }
    }
    return [ordered]@{ existed = $true; value = $plain; type = $valueType; keyExisted = $true }
}

function Set-TuneRegistryValue {
    param([string]$Path, [string]$Name, $Value, [string]$Type)

    if (-not (Test-Path -LiteralPath $Path)) { New-Item -Path $Path -Force | Out-Null }
    if ($Type -eq 'DWord' -or $Type -eq 'QWord') {
        Set-ItemProperty -LiteralPath $Path -Name $Name -Value ([int64]$Value) -Type $Type
        return
    }
    if ($Type -eq 'MultiString') {
        $parts = @(([string]$Value) -split "`n" | Where-Object { $_.Length -gt 0 })
        Set-ItemProperty -LiteralPath $Path -Name $Name -Value $parts -Type $Type
        return
    }
    Set-ItemProperty -LiteralPath $Path -Name $Name -Value ([string]$Value) -Type $Type
}

function Get-ActivePowerScheme {
    $output = ''
    try { $output = [string](& powercfg /getactivescheme 2>&1 | Out-String) } catch { return '' }
    if ($output -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') {
        return $Matches[1].ToLowerInvariant()
    }
    return ''
}

function Get-TuneServiceState {
    param([string]$Name)

    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $svc) { return [ordered]@{ existed = $false; startMode = $null; status = $null } }
    $startMode = ''
    try {
        $wmi = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $Name) -ErrorAction Stop
        $startMode = [string]$wmi.StartMode
    } catch { $startMode = '' }
    return [ordered]@{ existed = $true; startMode = $startMode; status = [string]$svc.Status }
}

function Test-TuneAdmin {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return [bool]$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-TuningCatalog {
    $isAdmin = Test-TuneAdmin
    $items = New-Object System.Collections.ArrayList
    foreach ($key in ($script:TuneCatalog.Keys | Sort-Object)) {
        $entry = $script:TuneCatalog[$key]
        $current = ''
        if ($entry.kind -eq 'registry') {
            $snapshot = Get-TuneRegistryValue -Path $entry.path -Name $entry.name
            $current = if ($snapshot.existed) { [string]$snapshot.value } else { '(not set)' }
        }
        elseif ($entry.kind -eq 'power') {
            $current = Get-ActivePowerScheme
        }
        elseif ($entry.kind -eq 'service') {
            $state = Get-TuneServiceState -Name $entry.name
            $current = if ([bool]$state.existed) { [string]$state.startMode } else { '(service missing)' }
        }
        [void]$items.Add([ordered]@{
            key           = $key
            kind          = $entry.kind
            description   = $entry.description
            requiresAdmin = [bool]$entry.requiresAdmin
            target        = if ($entry.kind -eq 'registry') { [string]$entry.target }
                            elseif ($entry.kind -eq 'service') { [string]$entry.startMode }
                            else { [string]$entry.scheme }
            currentValue  = $current
            applicable    = (-not $entry.requiresAdmin) -or $isAdmin
        })
    }
    [ordered]@{ items = @($items.ToArray()); count = $items.Count; elevated = $isAdmin; root = $script:TuneRoot }
}

function Get-TuneSnapshotFile {
    param([Parameter(Mandatory)][string]$SnapshotId)

    if ($SnapshotId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
        throw "INVALID_PARAMS: snapshotId 必须是 GUID（收到 '$SnapshotId'）；不接受文件路径"
    }
    return (Join-Path $script:TuneRoot "$SnapshotId.json")
}

function New-TuningSnapshot {
    param([string]$Operation = 'tune.apply', [string]$TweakKeysJson = '[]')

    $keys = @()
    if (-not [string]::IsNullOrWhiteSpace($TweakKeysJson)) { $keys = @($TweakKeysJson | ConvertFrom-Json) }
    if ($keys.Count -eq 0) { throw 'INVALID_PARAMS: 至少给一个 tweak key' }

    foreach ($key in $keys) {
        if (-not $script:TuneCatalog.ContainsKey([string]$key)) {
            throw "INVALID_PARAMS: 未知 tweak '$key'（只能用 resource.tune.catalog 列出的 key）"
        }
    }

    if (-not (Test-Path -LiteralPath $script:TuneRoot)) {
        New-Item -ItemType Directory -Path $script:TuneRoot -Force | Out-Null
    }

    $entries = New-Object System.Collections.ArrayList
    foreach ($key in $keys) {
        $entry = $script:TuneCatalog[[string]$key]
        if ($entry.kind -eq 'registry') {
            $before = Get-TuneRegistryValue -Path $entry.path -Name $entry.name
            [void]$entries.Add([ordered]@{
                key      = [string]$key
                kind     = 'registry'
                path     = $entry.path
                name     = $entry.name
                type     = $entry.type
                existed  = [bool]$before.existed
                value    = $before.value
                valueType = $before.type
            })
        }
        elseif ($entry.kind -eq 'power') {
            [void]$entries.Add([ordered]@{
                key            = [string]$key
                kind           = 'power'
                previousScheme = Get-ActivePowerScheme
                target         = $entry.scheme
            })
        }
        elseif ($entry.kind -eq 'service') {
            $state = Get-TuneServiceState -Name $entry.name
            [void]$entries.Add([ordered]@{
                key           = [string]$key
                kind          = 'service'
                name          = [string]$entry.name
                existed       = [bool]$state.existed
                previousMode  = [string]$state.startMode
                previousStatus = [string]$state.status
                target        = [string]$entry.startMode
            })
        }
    }

    $snapshotId = [guid]::NewGuid().ToString()
    $file = Join-Path $script:TuneRoot "$snapshotId.json"
    $payload = [ordered]@{
        schema     = 1
        snapshotId = $snapshotId
        operation  = $Operation
        machine    = $env:COMPUTERNAME
        user       = $env:USERNAME
        createdAt  = (Get-Date).ToString('o')
        elevated   = (Test-TuneAdmin)
        entries    = @($entries.ToArray())
    }
    ($payload | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $file -Encoding UTF8

    # only-first-baseline：latest 只写一次，保证"优化前"的基线不被后续快照覆盖
    $latestFile = Join-Path $script:TuneRoot 'latest-snapshot.json'
    if (-not (Test-Path -LiteralPath $latestFile)) {
        try { Copy-Item -LiteralPath $file -Destination $latestFile -Force } catch { }
    }

    [ordered]@{
        snapshotId = $snapshotId
        path       = $file
        latestPath = $latestFile
        operation  = $Operation
        entryCount = $entries.Count
        entries    = @($entries.ToArray())
    }
}

function Invoke-TuningApply {
    param([Parameter(Mandatory)][string]$SnapshotId, [string]$TweakKeysJson = '[]')

    $file = Get-TuneSnapshotFile -SnapshotId $SnapshotId
    if (-not (Test-Path -LiteralPath $file)) { throw "BACKUP_NOT_FOUND: 快照 $SnapshotId 不存在（$file）" }

    $data = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    $snapshotKeys = @($data.entries | ForEach-Object { [string]$_.key })

    $keys = @()
    if (-not [string]::IsNullOrWhiteSpace($TweakKeysJson)) { $keys = @($TweakKeysJson | ConvertFrom-Json) }
    if ($keys.Count -eq 0) { $keys = $snapshotKeys }

    $isAdmin = Test-TuneAdmin
    $applied = New-Object System.Collections.ArrayList
    $failed = New-Object System.Collections.ArrayList

    foreach ($key in $keys) {
        $keyName = [string]$key
        if (-not ($snapshotKeys -contains $keyName)) {
            [void]$failed.Add([ordered]@{ key = $keyName; code = 'INVALID_PARAMS'; message = '该 key 不在快照里，拒绝执行（快照必须覆盖将要修改的每一项）' })
            continue
        }
        $entry = $script:TuneCatalog[$keyName]
        if ($null -eq $entry) {
            [void]$failed.Add([ordered]@{ key = $keyName; code = 'INVALID_PARAMS'; message = '目录中已不存在该 key' })
            continue
        }
        if ($entry.requiresAdmin -and -not $isAdmin) {
            [void]$failed.Add([ordered]@{ key = $keyName; code = 'ADMIN_REQUIRED'; message = '该项需要管理员权限；当前会话未提权，已跳过' })
            continue
        }
        try {
            if ($entry.kind -eq 'registry') {
                Set-TuneRegistryValue -Path $entry.path -Name $entry.name -Value $entry.target -Type $entry.type
                $after = Get-TuneRegistryValue -Path $entry.path -Name $entry.name
                [void]$applied.Add([ordered]@{
                    key = $keyName; kind = 'registry'
                    previousValue = $null
                    after = [string]$after.value
                    verified = [bool]$after.existed
                })
            }
            elseif ($entry.kind -eq 'service') {
                $previous = Get-TuneServiceState -Name $entry.name
                Set-Service -Name $entry.name -StartupType $entry.startMode -ErrorAction Stop
                $after = Get-TuneServiceState -Name $entry.name
                [void]$applied.Add([ordered]@{
                    key = $keyName; kind = 'service'
                    previousValue = [string]$previous.startMode
                    after = [string]$after.startMode
                    verified = ([string]$after.startMode -eq [string]$entry.startMode)
                })
            }
            elseif ($entry.kind -eq 'power') {
                $previous = Get-ActivePowerScheme
                & powercfg /setactive $entry.scheme | Out-Null
                $after = Get-ActivePowerScheme
                [void]$applied.Add([ordered]@{
                    key = $keyName; kind = 'power'
                    previousValue = $previous
                    after = $after
                    verified = ($after -eq ([string]$entry.scheme).ToLowerInvariant())
                })
            }
        }
        catch {
            [void]$failed.Add([ordered]@{ key = $keyName; code = 'INTERNAL'; message = $_.Exception.Message })
        }
    }

    # 从快照里回填 before 值，便于调用方对比
    $byKey = @{}
    foreach ($item in $applied) { $byKey[[string]$item.key] = $item }
    foreach ($entry in @($data.entries)) {
        $keyName = [string]$entry.key
        if ($byKey.ContainsKey($keyName)) {
            $byKey[$keyName].previousValue = if ([string]$entry.kind -eq 'registry') {
                if ([bool]$entry.existed) { [string]$entry.value } else { '(not set)' }
            }
            elseif ([string]$entry.kind -eq 'service') { [string]$entry.previousMode }
            else { [string]$entry.previousScheme }
        }
    }

    [ordered]@{
        snapshotId   = $SnapshotId
        appliedCount = $applied.Count
        failedCount  = $failed.Count
        applied      = @($applied.ToArray())
        failures     = @($failed.ToArray())
        elevated     = $isAdmin
    }
}

function Restore-TuningSnapshot {
    param([Parameter(Mandatory)][string]$SnapshotId)

    $file = Get-TuneSnapshotFile -SnapshotId $SnapshotId
    if (-not (Test-Path -LiteralPath $file)) { throw "BACKUP_NOT_FOUND: 快照 $SnapshotId 不存在（$file）" }

    $data = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ([string]$data.machine -ne $env:COMPUTERNAME) {
        throw "INVALID_PARAMS: 快照来自机器 '$($data.machine)'，当前是 '$env:COMPUTERNAME'"
    }

    $entries = @($data.entries)
    $restored = New-Object System.Collections.ArrayList
    $failed = New-Object System.Collections.ArrayList

    for ($index = $entries.Count - 1; $index -ge 0; $index--) {
        $entry = $entries[$index]
        try {
            if ([string]$entry.kind -eq 'registry') {
                if ([bool]$entry.existed) {
                    $valueType = [string]$entry.valueType
                    if ([string]::IsNullOrWhiteSpace($valueType)) { $valueType = [string]$entry.type }
                    Set-TuneRegistryValue -Path ([string]$entry.path) -Name ([string]$entry.name) -Value $entry.value -Type $valueType
                    [void]$restored.Add([ordered]@{ key = [string]$entry.key; action = 'restored-value'; value = [string]$entry.value })
                }
                else {
                    if (Test-Path -LiteralPath ([string]$entry.path)) {
                        Remove-ItemProperty -LiteralPath ([string]$entry.path) -Name ([string]$entry.name) -ErrorAction SilentlyContinue
                    }
                    [void]$restored.Add([ordered]@{ key = [string]$entry.key; action = 'removed-value' })
                }
            }
            elseif ([string]$entry.kind -eq 'service') {
                $name = [string]$entry.name
                if (-not [bool]$entry.existed) {
                    [void]$restored.Add([ordered]@{ key = [string]$entry.key; action = 'skipped-service-missing' })
                    continue
                }
                $previousMode = [string]$entry.previousMode
                if (-not [string]::IsNullOrWhiteSpace($previousMode)) {
                    Set-Service -Name $name -StartupType $previousMode -ErrorAction Stop
                }
                if ([string]$entry.previousStatus -eq 'Running') {
                    Start-Service -Name $name -ErrorAction SilentlyContinue
                }
                [void]$restored.Add([ordered]@{ key = [string]$entry.key; action = 'restored-service'; startMode = $previousMode })
            }
            elseif ([string]$entry.kind -eq 'power') {
                $previous = [string]$entry.previousScheme
                if (-not [string]::IsNullOrWhiteSpace($previous)) {
                    & powercfg /setactive $previous | Out-Null
                    [void]$restored.Add([ordered]@{ key = [string]$entry.key; action = 'restored-power-scheme'; scheme = $previous })
                }
                else {
                    [void]$restored.Add([ordered]@{ key = [string]$entry.key; action = 'skipped-power-unknown' })
                }
            }
        }
        catch {
            [void]$failed.Add([ordered]@{ key = [string]$entry.key; message = $_.Exception.Message })
        }
    }

    [ordered]@{
        snapshotId    = $SnapshotId
        operation     = [string]$data.operation
        capturedAt    = [string]$data.createdAt
        restoredCount = $restored.Count
        failedCount   = $failed.Count
        restored      = @($restored.ToArray())
        failures      = @($failed.ToArray())
    }
}

function Get-TuningSnapshots {
    param([int]$MaxItems = 20)

    if (-not (Test-Path -LiteralPath $script:TuneRoot)) {
        return [ordered]@{ items = @(); count = 0; root = $script:TuneRoot; latest = $null }
    }

    $items = New-Object System.Collections.ArrayList
    $files = Get-ChildItem -LiteralPath $script:TuneRoot -Filter '*.json' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne 'latest-snapshot.json' } |
        Sort-Object -Property LastWriteTime -Descending |
        Select-Object -First $MaxItems

    foreach ($file in $files) {
        $meta = [ordered]@{ snapshotId = $file.BaseName; path = $file.FullName; modifiedAt = $file.LastWriteTime.ToString('o') }
        try {
            $parsed = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            $meta.operation = [string]$parsed.operation
            $meta.createdAt = [string]$parsed.createdAt
            $meta.entryCount = @($parsed.entries).Count
            $meta.elevated = [bool]$parsed.elevated
        } catch {
            $meta.parseError = '无法解析（可能写入中断）'
        }
        [void]$items.Add($meta)
    }

    $latestFile = Join-Path $script:TuneRoot 'latest-snapshot.json'
    $latest = $null
    if (Test-Path -LiteralPath $latestFile) {
        try {
            $parsedLatest = Get-Content -LiteralPath $latestFile -Raw | ConvertFrom-Json
            $latest = [ordered]@{ snapshotId = [string]$parsedLatest.snapshotId; createdAt = [string]$parsedLatest.createdAt }
        } catch { $latest = $null }
    }

    [ordered]@{ items = @($items.ToArray()); count = $items.Count; root = $script:TuneRoot; latest = $latest }
}
