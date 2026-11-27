# shell.ps1 -- win-shell capability module
#
# Provides:
#   Get-ShellInfo        -> pwsh version / elevated / git-bash path / platform
#   Invoke-BashCommand   -> run a bash -lc command with timeout + output capture
#
# ASCII only (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

Set-StrictMode -Version 1
$ErrorActionPreference = 'Stop'

function Find-GitBash {
    $candidates = @(
        'C:\Program Files\Git\bin\bash.exe',
        'C:\Program Files\Git\usr\bin\bash.exe',
        'C:\Program Files (x86)\Git\bin\bash.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    try {
        $found = Get-Command bash -ErrorAction Stop
        if ($null -ne $found -and -not [string]::IsNullOrWhiteSpace($found.Source)) {
            return [string]$found.Source
        }
    }
    catch { }
    return ''
}

function Get-ShellInfo {
    $elevated = $false
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $elevated = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch { }

    $bashPath = Find-GitBash
    $bashVersion = ''
    if (-not [string]::IsNullOrWhiteSpace($bashPath)) {
        try {
            $bashVersion = [string](& $bashPath --version 2>&1 | Select-Object -First 1)
        }
        catch { }
    }

    [ordered]@{
        psVersion    = $PSVersionTable.PSVersion.ToString()
        psEdition    = [string]$PSVersionTable.PSEdition
        elevated     = [bool]$elevated
        pid          = $PID
        bashPath     = $bashPath
        bashAvailable = (-not [string]::IsNullOrWhiteSpace($bashPath))
        bashVersion  = $bashVersion
        platform     = [string][System.Environment]::OSVersion.VersionString
    }
}

function Invoke-BashCommand {
    param(
        [Parameter(Mandatory)][string]$Command,
        [int]$TimeoutMs = 30000,
        [int]$MaxOutputChars = 60000
    )

    $bashPath = Find-GitBash
    if ([string]::IsNullOrWhiteSpace($bashPath)) {
        throw 'BASH_NOT_FOUND: git-bash not detected on PATH or standard locations'
    }
    if ([string]::IsNullOrWhiteSpace($Command)) {
        throw 'INVALID_PARAMS: command must be a non-empty string'
    }

    $shell = [powershell]::Create()
    try {
        # Pass arguments positionally to avoid string concatenation / quoting bugs.
        [void]$shell.AddScript('param($bash, $cmd) & $bash -lc $cmd 2>&1')
        [void]$shell.AddArgument($bashPath)
        [void]$shell.AddArgument($Command)

        $async = $shell.BeginInvoke()
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) {
            try { $shell.Stop() } catch { }
            try { $shell.Dispose() } catch { }
            return [ordered]@{
                ok    = $false
                error = [ordered]@{ code = 'TIMEOUT'; message = "bash command timed out after ${TimeoutMs}ms" }
            }
        }

        $output = $null
        try { $output = $shell.EndInvoke($async) } catch { $output = $null }

        $text = ''
        if ($null -ne $output) { $text = ($output | Out-String -Width 4096) }

        $truncated = $false
        if ($text.Length -gt $MaxOutputChars) {
            $original = $text.Length
            $text = $text.Substring(0, $MaxOutputChars) + "`n...[truncated, original length $original]"
            $truncated = $true
        }

        $errorText = ''
        if ($shell.Streams.Error.Count -gt 0) {
            $parts = @($shell.Streams.Error | ForEach-Object { $_.ToString() })
            $errorText = ($parts -join "`n")
        }

        [ordered]@{
            ok   = $true
            data = [ordered]@{
                output    = $text
                errors    = $errorText
                truncated = $truncated
                bashPath  = $bashPath
            }
        }
    }
    catch {
        [ordered]@{
            ok    = $false
            error = [ordered]@{ code = 'EXEC_FAILED'; message = $_.Exception.Message }
        }
    }
    finally {
        try { $shell.Dispose() } catch { }
    }
}