# apps.ps1 -- win-apps capability module
# ASCII only (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

Set-StrictMode -Version 1
$ErrorActionPreference = 'Stop'

function Get-InstalledApps {
    param([string]$Filter = '', [int]$MaxItems = 200)

    $registryPaths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )

    $collected = @()
    foreach ($registryPath in $registryPaths) {
        $entries = @(Get-ItemProperty -Path $registryPath -ErrorAction SilentlyContinue)
        foreach ($entry in $entries) {
            $name = ''
            try { $name = [string]$entry.DisplayName } catch { }
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            if (-not [string]::IsNullOrWhiteSpace($Filter) -and $name -notlike "*$Filter*") { continue }

            $uninstall = ''
            try { $uninstall = [string]$entry.UninstallString } catch { }
            $collected += [ordered]@{
                name             = $name
                version          = [string]$entry.DisplayVersion
                publisher        = [string]$entry.Publisher
                installDate      = [string]$entry.InstallDate
                estimatedSizeMB  = if ($null -ne $entry.EstimatedSize) { [math]::Round([double]$entry.EstimatedSize / 1024, 1) } else { 0 }
                uninstallString  = $uninstall
                hive             = if ($registryPath.StartsWith('HKCU')) { 'HKCU' } else { 'HKLM' }
            }
        }
    }

    $sorted = @($collected | Sort-Object name)
    $total = $sorted.Count
    $limited = @($sorted | Select-Object -First $MaxItems)
    [ordered]@{ items = $limited; count = $limited.Count; totalMatched = $total; filtered = (-not [string]::IsNullOrWhiteSpace($Filter)) }
}

function Get-WingetInfo {
    $command = Get-Command winget -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return [ordered]@{ available = $false; version = ''; source = '' }
    }
    $version = ''
    try { $version = [string](& winget --version 2>&1 | Select-Object -First 1) } catch { }
    return [ordered]@{ available = $true; version = $version.Trim(); source = [string]$command.Source }
}

function Invoke-WingetAction {
    param(
        [Parameter(Mandatory)][string]$Action,
        [string]$Target = '',
        [int]$MaxOutputChars = 60000
    )

    $info = Get-WingetInfo
    if ($info.available -ne $true) { throw 'WINGET_NOT_FOUND: winget is not installed or not on PATH' }

    $normalized = $Action.ToLowerInvariant()
    $wingetArgs = @()
    switch ($normalized) {
        'search' {
            if ([string]::IsNullOrWhiteSpace($Target)) { throw 'INVALID_PARAMS: search requires target' }
            $wingetArgs = @('search', $Target, '--accept-source-agreements')
        }
        'list' {
            $wingetArgs = @('list', '--accept-source-agreements')
        }
        'install' {
            if ([string]::IsNullOrWhiteSpace($Target)) { throw 'INVALID_PARAMS: install requires target (package id)' }
            $wingetArgs = @('install', '--id', $Target, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements')
        }
        'uninstall' {
            if ([string]::IsNullOrWhiteSpace($Target)) { throw 'INVALID_PARAMS: uninstall requires target (package id)' }
            $wingetArgs = @('uninstall', '--id', $Target, '-e', '--silent', '--accept-source-agreements')
        }
        'upgrade' {
            if ([string]::IsNullOrWhiteSpace($Target)) { throw 'INVALID_PARAMS: upgrade requires target (package id)' }
            $wingetArgs = @('upgrade', '--id', $Target, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements')
        }
        default { throw "UNSUPPORTED_ACTION: $Action (expect search|list|install|uninstall|upgrade)" }
    }

    $text = ''
    $exitCode = 0
    try {
        $text = [string](& winget @wingetArgs 2>&1 | Out-String -Width 4096)
        $exitCode = [int]$LASTEXITCODE
    }
    catch {
        return [ordered]@{
            ok       = $false
            action   = $normalized
            target   = $Target
            exitCode = -1
            message  = $_.Exception.Message
        }
    }

    $truncated = $false
    if ($text.Length -gt $MaxOutputChars) {
        $original = $text.Length
        $text = $text.Substring(0, $MaxOutputChars) + "`n...[truncated, original length $original]"
        $truncated = $true
    }

    $lines = @($text -split "`n" | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -First 80)

    [ordered]@{
        ok        = ($exitCode -eq 0)
        action    = $normalized
        target    = $Target
        exitCode  = $exitCode
        truncated = $truncated
        lines     = $lines
        text      = $text
    }
}

function Start-Application {
    param([Parameter(Mandatory)][string]$Name, [string]$Arguments = '')

    # Resolve by command name first (PATH) so callers do not need to pass
    # absolute paths inside protected directories.
    $resolved = ''
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
        $resolved = [string]$command.Source
    }
    elseif (Test-Path -LiteralPath $Name) {
        $resolved = $Name
    }
    else {
        throw "NOT_FOUND: $Name (not on PATH and not an existing file)"
    }

    if ([string]::IsNullOrWhiteSpace($Arguments)) {
        Start-Process -FilePath $resolved | Out-Null
    }
    else {
        Start-Process -FilePath $resolved -ArgumentList $Arguments | Out-Null
    }
    [ordered]@{ started = $true; name = $Name; resolvedPath = $resolved; arguments = $Arguments }
}
# ---------------------------------------------------------------------------
# CL-013: winget 计划用的"已装状态"探测
# ---------------------------------------------------------------------------
function Get-WingetInstalledState {
    param([string]$IdsJson = '[]', [int]$MaxOutputChars = 200000, [string]$Mode = 'exact')

    $info = Get-WingetInfo
    if ($info.available -ne $true) {
        return [ordered]@{ available = $false; version = ''; packages = @(); source = 'winget-not-found' }
    }

    $ids = @()
    if (-not [string]::IsNullOrWhiteSpace($IdsJson)) {
        $ids = @($IdsJson | ConvertFrom-Json)
    }

    # exact：逐个 `winget list --id <id> -e`，精确但每题一次调用（<=10 个才用）
    # bulk ：一次 `winget list` 后做 Id 列子串匹配，快但是启发式
    $useExact = ($Mode -eq 'exact' -and $ids.Count -le 10)
    $packages = New-Object System.Collections.ArrayList

    if ($useExact) {
        foreach ($id in $ids) {
            $needle = [string]$id
            if ([string]::IsNullOrWhiteSpace($needle)) {
                [void]$packages.Add([ordered]@{ id = $needle; installed = $false; source = 'empty-id' })
                continue
            }
            $text = ''
            $exitCode = 0
            try {
                $text = [string](& winget list --id $needle -e --accept-source-agreements 2>&1 | Out-String -Width 4096)
                $exitCode = [int]$LASTEXITCODE
            } catch {
                $text = ''
                $exitCode = -1
            }
            if ($text.Length -gt $MaxOutputChars) { $text = $text.Substring(0, $MaxOutputChars) }
            # winget 在"没有匹配"时可能返回 0 且输出 No installed package found
            $noMatch = ($text -match 'No installed package|找不到已安装|No applicable');
            $installed = ($exitCode -eq 0) -and (-not $noMatch)
            [void]$packages.Add([ordered]@{ id = $needle; installed = $installed; exitCode = $exitCode; source = 'winget-list-exact' })
        }
        return [ordered]@{
            available = $true
            version   = $info.version
            packages  = @($packages.ToArray())
            source    = 'winget-list-exact'
        }
    }

    $bulkText = ''
    try {
        $bulkText = [string](& winget list --accept-source-agreements 2>&1 | Out-String -Width 4096)
    } catch {
        return [ordered]@{ available = $false; version = $info.version; packages = @(); source = 'list-failed'; message = $_.Exception.Message }
    }
    if ($bulkText.Length -gt $MaxOutputChars) { $bulkText = $bulkText.Substring(0, $MaxOutputChars) }

    foreach ($id in $ids) {
        $needle = [string]$id
        $installed = $false
        if ($needle.Length -gt 0) {
            $installed = $bulkText.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }
        [void]$packages.Add([ordered]@{ id = $needle; installed = $installed; source = 'winget-list-substring' })
    }

    [ordered]@{
        available = $true
        version   = $info.version
        packages  = @($packages.ToArray())
        source    = 'winget-list-substring'
    }
}
