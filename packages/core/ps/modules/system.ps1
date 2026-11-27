# system.ps1 -- win-system capability module (loaded by ps-bridge.ps1)
#
# Contract:
#   - every public function returns an [ordered] dictionary (never raw pipeline output)
#   - list-like results use { items = @(); count = n } to avoid single-element collapse
#   - all output must be JSON-serializable (no live .NET objects)
#   - ASCII only (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI)

Set-StrictMode -Version 1
$ErrorActionPreference = 'Stop'

$script:BackupRoot = Join-Path $env:LOCALAPPDATA 'win-mcp\backups'

function ConvertTo-PlainString {
    param($Value)
    if ($null -eq $Value) { return '' }
    return [string]$Value
}

function Get-SystemOverview {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $cs = Get-CimInstance -ClassName Win32_ComputerSystem
    $cpu = @(Get-CimInstance -ClassName Win32_Processor)

    $lastBoot = $null
    try { $lastBoot = $os.LastBootUpTime } catch { }
    $uptimeHours = 0
    if ($null -ne $lastBoot) {
        $uptimeHours = [math]::Round(((Get-Date) - $lastBoot).TotalHours, 1)
    }

    $elevated = $false
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $elevated = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch { }

    [ordered]@{
        hostname     = [string]$env:COMPUTERNAME
        user         = [string]$env:USERNAME
        os           = [string]$os.Caption
        version      = [string]$os.Version
        build        = [string]$os.BuildNumber
        arch         = [string]$os.OSArchitecture
        manufacturer = [string]$cs.Manufacturer
        model        = [string]$cs.Model
        cpuName      = if ($cpu.Count -gt 0) { [string]$cpu[0].Name } else { '' }
        cpuCores     = if ($cpu.Count -gt 0) { [int]$cpu[0].NumberOfCores } else { 0 }
        cpuLogical   = if ($cpu.Count -gt 0) { [int]$cpu[0].NumberOfLogicalProcessors } else { 0 }
        memoryTotalGB = [math]::Round(($cs.TotalPhysicalMemory / 1GB), 2)
        memoryFreeGB  = [math]::Round(($os.FreePhysicalMemory / 1MB), 2)
        uptimeHours  = $uptimeHours
        elevated     = [bool]$elevated
        psVersion    = $PSVersionTable.PSVersion.ToString()
        capturedAt   = (Get-Date).ToString('o')
    }
}

function Get-ServiceList {
    param([string]$Filter = '', [int]$MaxItems = 200)

    $services = @(Get-Service)
    if (-not [string]::IsNullOrWhiteSpace($Filter)) {
        $services = @($services | Where-Object { $_.Name -like "*$Filter*" -or $_.DisplayName -like "*$Filter*" })
    }
    $items = @()
    foreach ($svc in ($services | Sort-Object Name | Select-Object -First $MaxItems)) {
        $startType = ''
        try { $startType = [string]$svc.StartType } catch { }
        $items += [ordered]@{
            name        = [string]$svc.Name
            displayName = [string]$svc.DisplayName
            status      = [string]$svc.Status
            startType   = $startType
            canStop     = [bool]$svc.CanStop
        }
    }
    [ordered]@{ items = $items; count = $items.Count; filtered = (-not [string]::IsNullOrWhiteSpace($Filter)) }
}

function Invoke-ServiceAction {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Action)

    $normalized = $Action.ToLowerInvariant()
    $svc = Get-Service -Name $Name -ErrorAction Stop

    switch ($normalized) {
        'start' { if ($svc.Status -ne 'Running') { Start-Service -Name $Name } }
        'stop' { if ($svc.Status -eq 'Running') { Stop-Service -Name $Name -Force } }
        'restart' {
            if ($svc.Status -eq 'Running') { Restart-Service -Name $Name -Force }
            else { Start-Service -Name $Name }
        }
        default { throw "UNSUPPORTED_ACTION: $Action (expect start|stop|restart)" }
    }

    Start-Sleep -Milliseconds 200
    $after = Get-Service -Name $Name
    [ordered]@{ name = [string]$after.Name; action = $normalized; status = [string]$after.Status }
}

function Get-ProcessList {
    param([int]$Top = 20, [string]$Filter = '')

    $processes = @(Get-Process)
    if (-not [string]::IsNullOrWhiteSpace($Filter)) {
        $processes = @($processes | Where-Object { $_.ProcessName -like "*$Filter*" })
    }
    $sorted = @($processes | Sort-Object -Property @{ Expression = { if ($null -eq $_.CPU) { -1 } else { $_.CPU } }; Descending = $true } | Select-Object -First $Top)

    $items = @()
    foreach ($proc in $sorted) {
        $path = ''
        try { $path = [string]$proc.Path } catch { }
        $startTime = ''
        try { $startTime = $proc.StartTime.ToString('o') } catch { }
        $items += [ordered]@{
            id         = [int]$proc.Id
            name       = [string]$proc.ProcessName
            cpuSeconds = if ($null -eq $proc.CPU) { 0 } else { [math]::Round([double]$proc.CPU, 2) }
            workingSetMB = [math]::Round(($proc.WorkingSet64 / 1MB), 1)
            threadCount  = [int]$proc.Threads.Count
            startTime    = $startTime
            path         = $path
        }
    }
    [ordered]@{ items = $items; count = $items.Count; top = $Top }
}

function Stop-ProcessItem {
    param([int[]]$Id = @(), [string]$Name = '', [bool]$Force = $false)

    $targets = @()
    if ($Id.Count -gt 0) {
        foreach ($item in $Id) { $targets += Get-Process -Id $item -ErrorAction Stop }
    }
    elseif (-not [string]::IsNullOrWhiteSpace($Name)) {
        $targets = @(Get-Process -Name $Name -ErrorAction Stop)
    }
    else {
        throw 'INVALID_PARAMS: provide Id or Name'
    }

    $stopped = @()
    foreach ($proc in $targets) {
        $procId = [int]$proc.Id
        $procName = [string]$proc.ProcessName
        if ($Force) { Stop-Process -Id $procId -Force -ErrorAction Stop }
        else { Stop-Process -Id $procId -ErrorAction Stop }
        $stopped += [ordered]@{ id = $procId; name = $procName }
    }
    [ordered]@{ stopped = $stopped; count = $stopped.Count }
}

function Get-EventLogEntries {
    param([string]$LogName = 'System', [string]$Level = '', [int]$MaxEvents = 20)

    try {
        $filter = @{ LogName = $LogName }
        if (-not [string]::IsNullOrWhiteSpace($Level)) {
            $levelMap = @{ critical = 1; error = 2; warning = 3; information = 4; verbose = 5 }
            $key = $Level.ToLowerInvariant()
            if ($levelMap.ContainsKey($key)) { $filter['Level'] = $levelMap[$key] }
        }
        $events = @(Get-WinEvent -FilterHashtable $filter -MaxEvents $MaxEvents -ErrorAction Stop)
    }
    catch {
        return [ordered]@{ items = @(); count = 0; logName = $LogName; note = 'no events matched or log inaccessible' }
    }

    $items = @()
    foreach ($event in $events) {
        $message = ''
        try { $message = [string]$event.Message } catch { }
        if ($message.Length -gt 400) { $message = $message.Substring(0, 400) + '...' }
        $timeText = ''
        try { $timeText = $event.TimeCreated.ToString('o') } catch { }
        $items += [ordered]@{
            time        = $timeText
            level       = [string]$event.LevelDisplayName
            source      = [string]$event.ProviderName
            eventId     = [int]$event.Id
            message     = $message
        }
    }
    [ordered]@{ items = $items; count = $items.Count; logName = $LogName }
}

function Get-ScheduledTaskList {
    param([string]$Filter = '', [int]$MaxItems = 50)

    $tasks = @(Get-ScheduledTask)
    if (-not [string]::IsNullOrWhiteSpace($Filter)) {
        $tasks = @($tasks | Where-Object { $_.TaskName -like "*$Filter*" -or $_.TaskPath -like "*$Filter*" })
    }

    $items = @()
    foreach ($task in ($tasks | Select-Object -First $MaxItems)) {
        $lastRun = ''
        $nextRun = ''
        try {
            $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop
            if ($null -ne $info.LastRunTime) { $lastRun = $info.LastRunTime.ToString('o') }
            if ($null -ne $info.NextRunTime) { $nextRun = $info.NextRunTime.ToString('o') }
        }
        catch { }
        $items += [ordered]@{
            name    = [string]$task.TaskName
            path    = [string]$task.TaskPath
            state   = [string]$task.State
            author  = [string]$task.Author
            lastRun = $lastRun
            nextRun = $nextRun
        }
    }
    [ordered]@{ items = $items; count = $items.Count }
}

function Get-RegistryValue {
    param([Parameter(Mandatory)][string]$Path, [string]$Name = '')

    if (-not (Test-Path -LiteralPath $Path)) {
        return [ordered]@{ exists = $false; path = $Path; name = $Name }
    }
    if ([string]::IsNullOrWhiteSpace($Name)) {
        $key = Get-Item -LiteralPath $Path
        $valueNames = @($key.GetValueNames())
        $values = @()
        foreach ($valueName in $valueNames) {
            $valueType = ''
            try { $valueType = [string]$key.GetValueKind($valueName) } catch { }
            $values += [ordered]@{
                name  = [string]$valueName
                value = ConvertTo-PlainString ($key.GetValue($valueName))
                type  = $valueType
            }
        }
        return [ordered]@{ exists = $true; path = $Path; valueCount = $values.Count; values = $values }
    }

    $keyItem = Get-Item -LiteralPath $Path
    if (-not ($keyItem.GetValueNames() -contains $Name)) {
        return [ordered]@{ exists = $false; path = $Path; name = $Name }
    }
    $valueTypeSingle = ''
    try { $valueTypeSingle = [string]$keyItem.GetValueKind($Name) } catch { }
    return [ordered]@{
        exists = $true
        path   = $Path
        name   = $Name
        value  = ConvertTo-PlainString ($keyItem.GetValue($Name))
        type   = $valueTypeSingle
    }
}

function Set-RegistryValue {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name,
        [AllowEmptyString()][string]$Value = '',
        [string]$Type = 'String'
    )

    $typeMap = @{
        string         = 'String'
        dword          = 'DWord'
        qword          = 'QWord'
        expandstring   = 'ExpandString'
        multistring    = 'MultiString'
    }
    $kindKey = $Type.ToLowerInvariant()
    if (-not $typeMap.ContainsKey($kindKey)) { throw "UNSUPPORTED_TYPE: $Type" }
    $kind = $typeMap[$kindKey]

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -Path $Path -Force | Out-Null
    }

    $previous = $null
    $keyItem = Get-Item -LiteralPath $Path
    if ($keyItem.GetValueNames() -contains $Name) {
        $previousType = 'String'
        try { $previousType = [string]$keyItem.GetValueKind($Name) } catch { }
        $previous = [ordered]@{
            value = ConvertTo-PlainString ($keyItem.GetValue($Name))
            type  = $previousType
        }
    }

    # 统一走 GUID 备份（CL-013）：恢复入口只接受 backupId，不接受路径
    $entryJson = (@([ordered]@{ kind = 'registry'; path = $Path; name = $Name }) | ConvertTo-Json -Depth 4 -Compress)
    $backup = New-SettingsBackup -Operation 'registry.write' -EntriesJson $entryJson
    $backupId = [string]$backup.backupId
    $backupPath = [string]$backup.path

    if ($kind -eq 'DWord' -or $kind -eq 'QWord') {
        Set-ItemProperty -LiteralPath $Path -Name $Name -Value ([int64]$Value) -Type $kind
    }
    elseif ($kind -eq 'MultiString') {
        $parts = @($Value -split "`n" | Where-Object { $_.Length -gt 0 })
        Set-ItemProperty -LiteralPath $Path -Name $Name -Value $parts -Type $kind
    }
    else {
        Set-ItemProperty -LiteralPath $Path -Name $Name -Value $Value -Type $kind
    }

    $verified = (Get-ItemProperty -LiteralPath $Path -Name $Name).$Name
    return [ordered]@{
        changed        = $true
        path           = $Path
        name           = $Name
        type           = $kind
        previousExists = ($null -ne $previous)
        verified       = ConvertTo-PlainString $verified
        backupId       = $backupId
        backupPath     = $backupPath
    }
}

function Get-StartupItems {
    $items = @()
    $runKeys = @(
        @{ hive = 'HKCU'; path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' },
        @{ hive = 'HKLM'; path = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' }
    )
    foreach ($entry in $runKeys) {
        if (-not (Test-Path -LiteralPath $entry.path)) { continue }
        $key = Get-Item -LiteralPath $entry.path
        foreach ($name in @($key.GetValueNames())) {
            $items += [ordered]@{
                source = "registry:$($entry.hive)"
                name   = [string]$name
                command = ConvertTo-PlainString ($key.GetValue($name))
            }
        }
    }

    $startupDirs = @(
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'),
        (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Startup')
    )
    foreach ($dir in $startupDirs) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($file in @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue)) {
            $items += [ordered]@{
                source = 'startup-folder'
                name   = [string]$file.Name
                command = [string]$file.FullName
            }
        }
    }
    [ordered]@{ items = $items; count = $items.Count }
}

function Get-NetworkConfig {
    $adapters = @()
    try {
        $configs = @(Get-NetIPConfiguration -ErrorAction Stop)
        foreach ($config in $configs) {
            $ipv4 = @()
            foreach ($address in @($config.IPv4Address)) { $ipv4 += [string]$address.IPAddress }
            $gateway = @()
            foreach ($gw in @($config.IPv4DefaultGateway)) { $gateway += [string]$gw.NextHop }
            $dns = @()
            foreach ($server in @($config.DNSServer | Where-Object { $_.AddressFamily -eq 2 })) {
                foreach ($address in @($server.ServerAddresses)) { $dns += [string]$address }
            }
            $adapters += [ordered]@{
                alias       = [string]$config.InterfaceAlias
                description = [string]$config.InterfaceDescription
                status      = [string]$config.NetAdapter.Status
                ipv4        = $ipv4
                gateway     = $gateway
                dns         = $dns
            }
        }
    }
    catch { }
    [ordered]@{ items = $adapters; count = $adapters.Count }
}
# ---------------------------------------------------------------------------
# CL-013: settings backup / restore (GUID-only, reverse order)
# ---------------------------------------------------------------------------
function Get-SettingsBackupFile {
    param([Parameter(Mandatory)][string]$BackupId)

    # 只接受 GUID，绝不接受路径 —— 否则等于开了一个"读任意文件"的入口
    if ($BackupId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
        throw "INVALID_PARAMS: backupId 必须是 GUID（收到 '$BackupId'）；不接受文件路径"
    }
    return (Join-Path $script:BackupRoot "$BackupId.json")
}

function Read-RegistryEntrySnapshot {
    param([string]$Path, [string]$Name)

    if (-not (Test-Path -LiteralPath $Path)) {
        return [ordered]@{ kind = 'registry'; path = $Path; name = $Name; exists = $false; value = $null; valueType = $null; keyExisted = $false }
    }
    $keyItem = Get-Item -LiteralPath $Path
    $exists = ($keyItem.GetValueNames() -contains $Name)
    $value = $null
    $valueType = $null
    if ($exists) {
        $valueType = 'String'
        try { $valueType = [string]$keyItem.GetValueKind($Name) } catch { }
        $value = ConvertTo-PlainString ($keyItem.GetValue($Name))
    }
    return [ordered]@{
        kind       = 'registry'
        path       = $Path
        name       = $Name
        exists     = $exists
        value      = $value
        valueType  = $valueType
        keyExisted = $true
    }
}

function Read-ServiceEntrySnapshot {
    param([string]$Name)

    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        return [ordered]@{ kind = 'service'; name = $Name; exists = $false; startType = $null; status = $null }
    }
    $startType = ''
    try {
        $wmi = Get-CimInstance -ClassName Win32_Service -Filter ("Name='{0}'" -f $Name) -ErrorAction Stop
        $startType = [string]$wmi.StartMode
    } catch {
        $startType = ''
    }
    return [ordered]@{ kind = 'service'; name = $Name; exists = $true; startType = $startType; status = [string]$svc.Status }
}

function New-SettingsBackup {
    param(
        [string]$Operation = 'manual',
        [string]$EntriesJson = '[]'
    )

    if (-not (Test-Path -LiteralPath $script:BackupRoot)) {
        New-Item -ItemType Directory -Path $script:BackupRoot -Force | Out-Null
    }

    $requested = @()
    if (-not [string]::IsNullOrWhiteSpace($EntriesJson)) {
        $requested = @($EntriesJson | ConvertFrom-Json)
    }

    $captured = New-Object System.Collections.ArrayList
    foreach ($entry in $requested) {
        $kind = [string]$entry.kind
        if ($kind -eq 'registry') {
            [void]$captured.Add((Read-RegistryEntrySnapshot -Path ([string]$entry.path) -Name ([string]$entry.name)))
        }
        elseif ($kind -eq 'service') {
            [void]$captured.Add((Read-ServiceEntrySnapshot -Name ([string]$entry.name)))
        }
        else {
            throw "INVALID_PARAMS: 不支持的备份类型 '$kind'（registry|service）"
        }
    }

    $backupId = [guid]::NewGuid().ToString()
    $path = Join-Path $script:BackupRoot "$backupId.json"
    $payload = [ordered]@{
        schema         = 1
        backupId       = $backupId
        operation      = $Operation
        machine        = $env:COMPUTERNAME
        user           = $env:USERNAME
        createdAt      = (Get-Date).ToString('o')
        entries        = @($captured.ToArray())
    }
    ($payload | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $path -Encoding UTF8

    [ordered]@{
        backupId  = $backupId
        path      = $path
        operation = $Operation
        entryCount = $captured.Count
        entries   = @($captured.ToArray())
    }
}

function Restore-SettingsBackup {
    param([Parameter(Mandatory)][string]$BackupId)

    $file = Get-SettingsBackupFile -BackupId $BackupId
    if (-not (Test-Path -LiteralPath $file)) {
        throw "BACKUP_NOT_FOUND: 备份 $BackupId 不存在（$file）"
    }

    $data = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ([string]$data.machine -ne $env:COMPUTERNAME) {
        throw "INVALID_PARAMS: 备份来自机器 '$($data.machine)'，当前是 '$env:COMPUTERNAME'，拒绝跨机恢复"
    }

    $entries = @($data.entries)
    $restored = New-Object System.Collections.ArrayList
    $failed = New-Object System.Collections.ArrayList

    # 逆序恢复：同一项被多次修改时，先撤销最后一次改动才是正确状态
    for ($index = $entries.Count - 1; $index -ge 0; $index--) {
        $entry = $entries[$index]
        try {
            if ([string]$entry.kind -eq 'registry') {
                $path = [string]$entry.path
                $name = [string]$entry.name
                if (-not (Test-Path -LiteralPath $path)) {
                    # 键本身是新建的：保留空键（删除可能抹掉其他程序刚写入的值）
                    [void]$restored.Add([ordered]@{ kind = 'registry'; path = $path; name = $name; action = 'skipped-key-missing' })
                    continue
                }
                if ([bool]$entry.exists) {
                    $valueType = [string]$entry.valueType
                    $value = $entry.value
                    if ($valueType -eq 'DWord' -or $valueType -eq 'QWord') {
                        Set-ItemProperty -LiteralPath $path -Name $name -Value ([int64]$value) -Type $valueType
                    }
                    elseif ($valueType -eq 'MultiString') {
                        $parts = @(([string]$value) -split "`n" | Where-Object { $_.Length -gt 0 })
                        Set-ItemProperty -LiteralPath $path -Name $name -Value $parts -Type $valueType
                    }
                    else {
                        Set-ItemProperty -LiteralPath $path -Name $name -Value ([string]$value) -Type $valueType
                    }
                    [void]$restored.Add([ordered]@{ kind = 'registry'; path = $path; name = $name; action = 'restored-value' })
                }
                else {
                    # 原本不存在 → 精确还原"不存在"，而不是写个默认值
                    Remove-ItemProperty -LiteralPath $path -Name $name -ErrorAction SilentlyContinue
                    [void]$restored.Add([ordered]@{ kind = 'registry'; path = $path; name = $name; action = 'removed-value' })
                }
            }
            elseif ([string]$entry.kind -eq 'service') {
                $name = [string]$entry.name
                if (-not [bool]$entry.exists) {
                    [void]$restored.Add([ordered]@{ kind = 'service'; name = $name; action = 'skipped-service-missing' })
                    continue
                }
                $startType = [string]$entry.startType
                if (-not [string]::IsNullOrWhiteSpace($startType)) {
                    Set-Service -Name $name -StartupType $startType -ErrorAction Stop
                }
                $targetStatus = [string]$entry.status
                if ($targetStatus -eq 'Running') {
                    Start-Service -Name $name -ErrorAction SilentlyContinue
                }
                elseif ($targetStatus -eq 'Stopped') {
                    Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
                }
                [void]$restored.Add([ordered]@{ kind = 'service'; name = $name; action = 'restored-service'; startType = $startType })
            }
        }
        catch {
            [void]$failed.Add([ordered]@{ entry = $entry; message = $_.Exception.Message })
        }
    }

    [ordered]@{
        backupId     = $BackupId
        operation    = [string]$data.operation
        capturedAt   = [string]$data.createdAt
        restoredCount = $restored.Count
        failedCount   = $failed.Count
        restored     = @($restored.ToArray())
        failures     = @($failed.ToArray())
    }
}

function Get-SettingsBackups {
    param([int]$MaxItems = 20)

    if (-not (Test-Path -LiteralPath $script:BackupRoot)) {
        return [ordered]@{ items = @(); count = 0; root = $script:BackupRoot }
    }

    $items = New-Object System.Collections.ArrayList
    $files = Get-ChildItem -LiteralPath $script:BackupRoot -Filter '*.json' -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTime -Descending |
        Select-Object -First $MaxItems

    foreach ($file in $files) {
        $meta = [ordered]@{ backupId = $file.BaseName; path = $file.FullName; sizeBytes = $file.Length; modifiedAt = $file.LastWriteTime.ToString('o') }
        try {
            $parsed = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            $meta.operation = [string]$parsed.operation
            $meta.createdAt = [string]$parsed.createdAt
            $meta.entryCount = @($parsed.entries).Count
        } catch {
            $meta.parseError = '无法解析（可能写入中断）'
        }
        [void]$items.Add($meta)
    }

    [ordered]@{ items = @($items.ToArray()); count = $items.Count; root = $script:BackupRoot }
}
