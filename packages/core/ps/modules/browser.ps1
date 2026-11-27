# browser.ps1 -- win-browser capability module
# Bookmark read/write via the browsers' Bookmarks JSON (no CDP required).
# ASCII only (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

Set-StrictMode -Version 1
$ErrorActionPreference = 'Stop'

$script:BackupRoot = Join-Path $env:LOCALAPPDATA 'win-mcp\backups'

function Get-BrowserRoots {
    return @(
        [ordered]@{ browser = 'chrome'; path = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data') },
        [ordered]@{ browser = 'edge'; path = (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data') }
    )
}

function Get-BrowserProfiles {
    $items = @()
    foreach ($root in Get-BrowserRoots) {
        if (-not (Test-Path -LiteralPath $root.path)) { continue }
        $directories = @(Get-ChildItem -LiteralPath $root.path -Directory -ErrorAction SilentlyContinue)
        foreach ($directory in $directories) {
            $bookmarks = Join-Path $directory.FullName 'Bookmarks'
            if (-not (Test-Path -LiteralPath $bookmarks)) { continue }
            $size = 0
            try { $size = [int64](Get-Item -LiteralPath $bookmarks).Length } catch { }
            $items += [ordered]@{
                browser       = $root.browser
                profile       = [string]$directory.Name
                bookmarksPath = $bookmarks
                sizeBytes     = $size
            }
        }
    }
    [ordered]@{ items = $items; count = $items.Count }
}

function Get-BookmarkNodes {
    param($Node, [string]$Prefix, $Output)

    if ($null -eq $Node) { return }
    $children = $null
    try { $children = $Node.children } catch { }
    if ($null -eq $children) { return }

    foreach ($child in @($children)) {
        $name = ''
        try { $name = [string]$child.name } catch { }
        $type = ''
        try { $type = [string]$child.type } catch { }
        if ($type -eq 'url') {
            $url = ''
            try { $url = [string]$child.url } catch { }
            $id = ''
            try { $id = [string]$child.id } catch { }
            $added = ''
            try { $added = [string]$child.date_added } catch { }
            [void]$Output.Add([ordered]@{
                id         = $id
                name       = $name
                url        = $url
                folder     = $Prefix
                dateAdded  = $added
            })
        }
        else {
            $nextPrefix = if ([string]::IsNullOrWhiteSpace($Prefix)) { $name } else { "$Prefix/$name" }
            Get-BookmarkNodes -Node $child -Prefix $nextPrefix -Output $Output
        }
    }
}

function Read-BookmarksFile {
    param([Parameter(Mandatory)][string]$ProfilePath)
    $file = Join-Path $ProfilePath 'Bookmarks'
    if (-not (Test-Path -LiteralPath $file)) { throw "BOOKMARKS_NOT_FOUND: $file" }
    $raw = Get-Content -LiteralPath $file -Raw -Encoding UTF8
    return @{ file = $file; json = ($raw | ConvertFrom-Json) }
}

function Get-Bookmarks {
    param([Parameter(Mandatory)][string]$ProfilePath, [string]$Filter = '', [int]$MaxItems = 500)

    $loaded = Read-BookmarksFile -ProfilePath $ProfilePath
    $output = New-Object System.Collections.ArrayList

    foreach ($rootName in @('bookmark_bar', 'other', 'synced')) {
        $root = $null
        try { $root = $loaded.json.roots.$rootName } catch { }
        if ($null -ne $root) {
            Get-BookmarkNodes -Node $root -Prefix $rootName -Output $output
        }
    }

    $all = @($output)
    if (-not [string]::IsNullOrWhiteSpace($Filter)) {
        $all = @($all | Where-Object { $_.name -like "*$Filter*" -or $_.url -like "*$Filter*" })
    }
    $items = @($all | Select-Object -First $MaxItems)
    [ordered]@{
        profilePath = $ProfilePath
        count       = $items.Count
        totalMatched = $all.Count
        items       = $items
    }
}

function Backup-BookmarksFile {
    param([string]$FilePath)
    if (-not (Test-Path -LiteralPath $script:BackupRoot)) {
        New-Item -ItemType Directory -Path $script:BackupRoot -Force | Out-Null
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $target = Join-Path $script:BackupRoot "bookmarks-$stamp.json"
    Copy-Item -LiteralPath $FilePath -Destination $target -Force
    return $target
}

function ConvertTo-ChromeTimestamp {
    $epoch = [datetime]::new(1601, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
    $micros = [int64](((Get-Date).ToUniversalTime() - $epoch).TotalMilliseconds * 1000)
    return [string]$micros
}

function Add-Bookmark {
    param(
        [Parameter(Mandatory)][string]$ProfilePath,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Url
    )

    $loaded = Read-BookmarksFile -ProfilePath $ProfilePath
    $backup = Backup-BookmarksFile -FilePath $loaded.file

    $bar = $loaded.json.roots.bookmark_bar
    $children = @()
    try { $children = @($bar.children) } catch { }

    $maxId = 0
    $stack = New-Object System.Collections.Stack
    $stack.Push($loaded.json.roots)
    while ($stack.Count -gt 0) {
        $node = $stack.Pop()
        $nodeChildren = $null
        try { $nodeChildren = $node.children } catch { }
        if ($null -eq $nodeChildren) { continue }
        foreach ($child in @($nodeChildren)) {
            $idText = ''
            try { $idText = [string]$child.id } catch { }
            $parsed = 0
            if ([int]::TryParse($idText, [ref]$parsed) -and $parsed -gt $maxId) { $maxId = $parsed }
            $stack.Push($child)
        }
    }

    $timestamp = ConvertTo-ChromeTimestamp
    $newEntry = [ordered]@{
        date_added    = $timestamp
        date_last_used = '0'
        guid          = [guid]::NewGuid().ToString()
        id            = [string]($maxId + 1)
        name          = $Name
        type          = 'url'
        url           = $Url
    }
    $bar.children = @($children + $newEntry)
    $loaded.json | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $loaded.file -Encoding UTF8

    [ordered]@{
        added      = $true
        name       = $Name
        url        = $Url
        id         = $newEntry.id
        backupPath = $backup
        note       = 'Close the browser before editing bookmarks, otherwise it may overwrite the file on exit.'
    }
}

function Remove-BookmarksByMatch {
    param($Node, [string]$Id, [string]$Url, [ref]$Removed)

    if ($null -eq $Node) { return }
    $children = $null
    try { $children = $Node.children } catch { }
    if ($null -eq $children) { return }

    $kept = @()
    foreach ($child in @($children)) {
        $childId = ''
        try { $childId = [string]$child.id } catch { }
        $childUrl = ''
        try { $childUrl = [string]$child.url } catch { }

        $matchById = (-not [string]::IsNullOrWhiteSpace($Id)) -and ($childId -eq $Id)
        $matchByUrl = (-not [string]::IsNullOrWhiteSpace($Url)) -and ($childUrl -eq $Url)
        if ($matchById -or $matchByUrl) {
            $Removed.Value = $Removed.Value + 1
            continue
        }
        $childChildren = $null
        try { $childChildren = $child.children } catch { }
        if ($null -ne $childChildren) {
            Remove-BookmarksByMatch -Node $child -Id $Id -Url $Url -Removed $Removed
        }
        $kept += $child
    }
    $Node.children = $kept
}

function Remove-Bookmark {
    param([Parameter(Mandatory)][string]$ProfilePath, [string]$Id = '', [string]$Url = '')

    if ([string]::IsNullOrWhiteSpace($Id) -and [string]::IsNullOrWhiteSpace($Url)) {
        throw 'INVALID_PARAMS: provide id or url'
    }

    $loaded = Read-BookmarksFile -ProfilePath $ProfilePath
    $backup = Backup-BookmarksFile -FilePath $loaded.file
    $removed = 0
    $counter = [ref]$removed

    foreach ($rootName in @('bookmark_bar', 'other', 'synced')) {
        $root = $null
        try { $root = $loaded.json.roots.$rootName } catch { }
        if ($null -ne $root) {
            Remove-BookmarksByMatch -Node $root -Id $Id -Url $Url -Removed $counter
        }
    }

    $removed = [int]$counter.Value
    if ($removed -gt 0) {
        $loaded.json | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $loaded.file -Encoding UTF8
    }

    [ordered]@{
        removed    = $removed
        backupPath = $backup
        id         = $Id
        url        = $Url
    }
}

function Open-Url {
    param([Parameter(Mandatory)][string]$Url)
    if ($Url -notmatch '^https?://') { throw 'INVALID_URL: only http/https is allowed' }
    Start-Process $Url | Out-Null
    [ordered]@{ opened = $true; url = $Url }
}