# ps-bridge.ps1 -- win-mcp-servers PowerShell bridge (NDJSON over stdio)
#
# Contract:
#   - stdout carries ONLY protocol lines: one JSON object per line
#   - diagnostics go to stderr
#   - request:  {"id":"req_1","op":"parse","params":{"command":"..."}}
#   - response: {"id":"req_1","ok":true,"data":{...},"durationMs":3}
#               {"id":"req_1","ok":false,"error":{"code":"TIMEOUT","message":"..."}}
#
# Ops: ping | info | parse | invoke
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less
# UTF-8 scripts as ANSI, so non-ASCII text here would be garbled.

Set-StrictMode -Version 1
$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $script:OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:MaxOutputCharsDefault = 100000

# --- Capability modules (explicit whitelist; never expose arbitrary invocation) ---
$script:ModuleRoot = Join-Path $PSScriptRoot 'modules'
$script:ModuleWhitelist = @{
    'system' = @(
        'Get-SystemOverview',
        'Get-ServiceList',
        'Invoke-ServiceAction',
        'Get-ProcessList',
        'Stop-ProcessItem',
        'Get-EventLogEntries',
        'Get-ScheduledTaskList',
        'Get-RegistryValue',
        'Set-RegistryValue',
        'Get-StartupItems',
        'Get-NetworkConfig',
        'New-SettingsBackup',
        'Restore-SettingsBackup',
        'Get-SettingsBackups'
    )
    'shell' = @(
        'Get-ShellInfo',
        'Invoke-BashCommand'
    )
    'apps' = @(
        'Get-InstalledApps',
        'Get-WingetInfo',
        'Invoke-WingetAction',
        'Get-WingetInstalledState',
        'Start-Application'
    )
    'resource' = @(
        'Get-ResourceMetrics',
        'Get-VolumeSpace',
        'Get-CleanupAnalysis',
        'Clear-UserTempFiles',
        'Get-TuningCatalog',
        'New-TuningSnapshot',
        'Invoke-TuningApply',
        'Restore-TuningSnapshot',
        'Get-TuningSnapshots'
    )
    'desktop' = @(
        'Get-ScreenCapture',
        'Get-WindowList',
        'Set-WindowState',
        'Get-ClipboardContent',
        'Set-ClipboardContent',
        'Get-UiTree',
        'Invoke-UiAction',
        'Send-UiInput',
        'Get-ControlState',
        'Set-ControlPolicy'
    )
    'browser' = @(
        'Get-BrowserProfiles',
        'Get-Bookmarks',
        'Add-Bookmark',
        'Remove-Bookmark',
        'Open-Url'
    )
}
$script:LoadedModules = @{}

# NOTE: dot-sourcing must happen in the script scope (main loop), not inside a
# function -- otherwise the module functions disappear when the function returns.
function Resolve-CapabilityModulePath {
    param([string]$Name)
    if (-not $script:ModuleWhitelist.ContainsKey($Name)) { throw "UNKNOWN_MODULE: $Name" }
    $path = Join-Path $script:ModuleRoot "$Name.ps1"
    if (-not (Test-Path -LiteralPath $path)) { throw "UNKNOWN_MODULE: $Name" }
    return $path
}

function Write-ProtocolLine {
    param([string]$Json)
    [Console]::Out.WriteLine($Json)
    [Console]::Out.Flush()
}

function Send-Ok {
    param($Id, $Data, [int]$DurationMs)
    $payload = [ordered]@{
        id         = $Id
        ok         = $true
        data       = $Data
        durationMs = $DurationMs
    }
    Write-ProtocolLine -Json ($payload | ConvertTo-Json -Depth 8 -Compress)
}

function Send-Fail {
    param($Id, [string]$Code, [string]$Message, [int]$DurationMs, $Details)
    $errorObject = [ordered]@{ code = $Code; message = $Message }
    if ($null -ne $Details) { $errorObject.details = $Details }
    $payload = [ordered]@{
        id         = $Id
        ok         = $false
        error      = $errorObject
        durationMs = $DurationMs
    }
    Write-ProtocolLine -Json ($payload | ConvertTo-Json -Depth 8 -Compress)
}

function Test-IsElevated {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function Get-SafeProcessPath {
    try {
        return [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    }
    catch {
        return ''
    }
}

function Get-BridgeInfo {
    [ordered]@{
        version    = $PSVersionTable.PSVersion.ToString()
        edition    = [string]$PSVersionTable.PSEdition
        elevated   = [bool](Test-IsElevated)
        pid        = $PID
        executable = [string](Get-SafeProcessPath)
        platform   = [string][System.Environment]::OSVersion.VersionString
    }
}

# --- AST parsing -------------------------------------------------------------
function Test-LooksLikePathLiteral {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    if ($Value -match '^[A-Za-z]:[\\/]') { return $true }
    if ($Value.StartsWith('\\')) { return $true }
    if ($Value -match '^HK[A-Z_]+[:\\]') { return $true }
    if ($Value -match '^\$env:') { return $true }
    if ($Value.StartsWith('~')) { return $true }
    return $false
}

function Get-ParamValue {
    param($Params, [string]$Name, $Default = $null)
    if ($null -eq $Params) { return $Default }
    $property = $Params.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    if ($null -eq $property.Value) { return $Default }
    return $property.Value
}

function Invoke-AstParse {
    param([AllowEmptyString()][string]$Command)

    [System.Management.Automation.Language.Token[]]$tokens = $null
    [System.Management.Automation.Language.ParseError[]]$parseErrors = $null
    $ast = $null
    try {
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($Command, [ref]$tokens, [ref]$parseErrors)
    }
    catch {
        $ast = $null
        $parseErrors = @([pscustomobject]@{ Message = [string]$_.Exception.Message; Extent = $null })
    }

    $errorList = New-Object System.Collections.Generic.List[object]
    if ($null -ne $parseErrors) {
        foreach ($e in @($parseErrors)) {
            $line = 0
            $column = 0
            if ($null -ne $e.Extent -and $null -ne $e.Extent.StartLineNumber) {
                $line = [int]$e.Extent.StartLineNumber
                $column = [int]$e.Extent.StartColumnNumber
            }
            $errorList.Add([ordered]@{ message = [string]$e.Message; line = $line; column = $column })
        }
    }

    $commands = New-Object System.Collections.Generic.List[string]
    $dynamicCalls = New-Object System.Collections.Generic.List[string]
    $pathValues = New-Object System.Collections.Generic.List[string]
    $statementCount = 0

    if ($null -ne $ast) {
        $commandAsts = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true))
        $statementCount = $commandAsts.Count

        foreach ($commandAst in $commandAsts) {
            $elements = @($commandAst.CommandElements)
            if ($elements.Count -gt 0 -and $elements[0] -is [System.Management.Automation.Language.VariableExpressionAst]) {
                $dynamicCalls.Add([string]$commandAst.Extent.Text)
                continue
            }
            $name = $null
            try { $name = $commandAst.GetCommandName() } catch { $name = $null }
            if ([string]::IsNullOrWhiteSpace($name)) {
                $dynamicCalls.Add([string]$commandAst.Extent.Text)
            }
            else {
                $lowered = $name.ToLowerInvariant()
                if (-not ($commands -contains $lowered)) { $commands.Add($lowered) }
            }
        }

        # Collect both plain strings and expandable strings; the latter is missed
        # by the reference implementation, which loses "$env:X\..." style paths.
        $stringAsts = @($ast.FindAll({
                    param($n)
                    ($n -is [System.Management.Automation.Language.StringConstantExpressionAst]) -or
                    ($n -is [System.Management.Automation.Language.ExpandableStringExpressionAst])
                }, $true))

        foreach ($stringAst in $stringAsts) {
            $value = [string]$stringAst.Value
            if ([string]::IsNullOrWhiteSpace($value)) { continue }
            # Command names are also StringConstant nodes; drop them to avoid noise.
            if ($commands -contains $value.ToLowerInvariant()) { continue }
            if (Test-LooksLikePathLiteral -Value $value) {
                if (-not ($pathValues -contains $value)) { $pathValues.Add($value) }
            }
        }
    }

    # NOTE: use .ToArray() instead of @($list) -- PowerShell 7.6 throws
    # "Argument types do not match" when @() is applied to List[object]
    # holding OrderedDictionary elements.
    [ordered]@{
        syntaxValid    = ($errorList.Count -eq 0)
        errors         = $errorList.ToArray()
        commands       = $commands.ToArray()
        paths          = $pathValues.ToArray()
        statementCount = $statementCount
        dynamicCalls   = $dynamicCalls.ToArray()
        parser         = 'powershell-ast'
    }
}

# --- Controlled execution ----------------------------------------------------
function Invoke-CommandInRunspace {
    param(
        [AllowEmptyString()][string]$Command,
        [int]$TimeoutMs = 60000,
        [int]$MaxOutputChars = 100000
    )

    if ([string]::IsNullOrWhiteSpace($Command)) {
        return [ordered]@{
            ok    = $false
            error = [ordered]@{ code = 'INVALID_PARAMS'; message = 'command must be a non-empty string' }
        }
    }

    $powershell = [powershell]::Create()
    try {
        [void]$powershell.AddScript($Command)
        $async = $powershell.BeginInvoke()

        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) {
            try { $powershell.Stop() } catch { }
            return [ordered]@{
                ok    = $false
                error = [ordered]@{ code = 'TIMEOUT'; message = "command timed out after ${TimeoutMs}ms" }
            }
        }

        $output = $null
        try { $output = $powershell.EndInvoke($async) } catch { $output = $null }

        $text = ''
        if ($null -ne $output) { $text = ($output | Out-String -Width 4096) }

        $truncated = $false
        if ($text.Length -gt $MaxOutputChars) {
            $originalLength = $text.Length
            $text = $text.Substring(0, $MaxOutputChars) + "`n...[truncated, original length $originalLength]"
            $truncated = $true
        }

        $errorText = ''
        if ($powershell.Streams.Error.Count -gt 0) {
            $parts = @($powershell.Streams.Error | ForEach-Object { $_.ToString() })
            $errorText = ($parts -join "`n")
        }

        [ordered]@{
            ok   = $true
            data = [ordered]@{
                output    = $text
                errors    = $errorText
                truncated = $truncated
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
        try { $powershell.Dispose() } catch { }
    }
}

# --- Main loop ---------------------------------------------------------------
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $request = $null
    try {
        $request = $line | ConvertFrom-Json
    }
    catch {
        Send-Fail -Id $null -Code 'BAD_REQUEST' -Message 'request is not valid JSON' -DurationMs 0
        continue
    }

    $requestId = $null
    if ($null -ne $request -and $null -ne $request.id) { $requestId = [string]$request.id }
    $op = ''
    if ($null -ne $request -and $null -ne $request.op) { $op = [string]$request.op }

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        switch ($op) {
            'ping' {
                Send-Ok -Id $requestId -Data ([ordered]@{ pong = $true }) -DurationMs ([int]$stopwatch.ElapsedMilliseconds)
            }
            'info' {
                Send-Ok -Id $requestId -Data (Get-BridgeInfo) -DurationMs ([int]$stopwatch.ElapsedMilliseconds)
            }
            'parse' {
                $commandText = [string](Get-ParamValue -Params $request.params -Name 'command' -Default '')
                $parsed = Invoke-AstParse -Command $commandText
                Send-Ok -Id $requestId -Data $parsed -DurationMs ([int]$stopwatch.ElapsedMilliseconds)
            }
            'invoke' {
                $commandText = [string](Get-ParamValue -Params $request.params -Name 'command' -Default '')
                $timeoutMs = [int](Get-ParamValue -Params $request.params -Name 'timeoutMs' -Default 60000)
                $maxChars = [int](Get-ParamValue -Params $request.params -Name 'maxOutputChars' -Default $script:MaxOutputCharsDefault)
                $result = Invoke-CommandInRunspace -Command $commandText -TimeoutMs $timeoutMs -MaxOutputChars $maxChars
                if ($result.ok -eq $true) {
                    Send-Ok -Id $requestId -Data $result.data -DurationMs ([int]$stopwatch.ElapsedMilliseconds)
                }
                else {
                    Send-Fail -Id $requestId -Code ([string]$result.error.code) -Message ([string]$result.error.message) -DurationMs ([int]$stopwatch.ElapsedMilliseconds)
                }
            }
            'module' {
                $moduleName = [string](Get-ParamValue -Params $request.params -Name 'module' -Default '')
                $functionName = [string](Get-ParamValue -Params $request.params -Name 'function' -Default '')
                if (-not $script:ModuleWhitelist.ContainsKey($moduleName)) {
                    throw "UNKNOWN_MODULE: $moduleName"
                }
                if (-not ($script:ModuleWhitelist[$moduleName] -contains $functionName)) {
                    throw "FUNCTION_NOT_ALLOWED: $moduleName/$functionName"
                }
                if (-not $script:LoadedModules.ContainsKey($moduleName)) {
                    # 脚本作用域 dot-source，模块函数对后续 & 调用可见
                    . (Resolve-CapabilityModulePath -Name $moduleName)
                    $script:LoadedModules[$moduleName] = $true
                }
                $argTable = @{}
                $rawArgs = Get-ParamValue -Params $request.params -Name 'args' -Default $null
                if ($null -ne $rawArgs) {
                    foreach ($property in $rawArgs.PSObject.Properties) {
                        $argTable[$property.Name] = $property.Value
                    }
                }
                $moduleResult = & $functionName @argTable
                Send-Ok -Id $requestId -Data $moduleResult -DurationMs ([int]$stopwatch.ElapsedMilliseconds)
            }
            default {
                Send-Fail -Id $requestId -Code 'UNKNOWN_OP' -Message "unsupported op: $op" -DurationMs ([int]$stopwatch.ElapsedMilliseconds)
            }
        }
    }
    catch {
        # Module functions signal domain errors as "CODE: message" (e.g. STALE_REF: ...).
        # Forward the leading token as the protocol error code so the Node side can map
        # it onto a ToolError code instead of collapsing everything into BRIDGE_ERROR.
        $failureMessage = $_.Exception.Message
        $failureCode = 'BRIDGE_ERROR'
        if ($failureMessage -match '^([A-Z][A-Z0-9_]{3,40}):\s') {
            $failureCode = $Matches[1]
        }
        Send-Fail -Id $requestId -Code $failureCode -Message $failureMessage -DurationMs ([int]$stopwatch.ElapsedMilliseconds)
    }
}