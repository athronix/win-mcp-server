# desktop.ps1 -- win-desktop capability module
# ASCII only (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

Set-StrictMode -Version 1
$ErrorActionPreference = 'Stop'

if (-not ('WinMcpDesktop' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WinMcpDesktop {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@
}

function Get-ScreenCapture {
    param([int]$MaxWidth = 0)

    Add-Type -AssemblyName System.Drawing

    $x = [WinMcpDesktop]::GetSystemMetrics(76)
    $y = [WinMcpDesktop]::GetSystemMetrics(77)
    $width = [WinMcpDesktop]::GetSystemMetrics(78)
    $height = [WinMcpDesktop]::GetSystemMetrics(79)
    if ($width -le 0) { $width = [WinMcpDesktop]::GetSystemMetrics(0) }
    if ($height -le 0) { $height = [WinMcpDesktop]::GetSystemMetrics(1) }

    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)

    $target = $bitmap
    if ($MaxWidth -gt 0 -and $width -gt $MaxWidth) {
        $ratio = $MaxWidth / $width
        $newWidth = [int]$MaxWidth
        $newHeight = [int]($height * $ratio)
        $target = New-Object System.Drawing.Bitmap($newWidth, $newHeight)
        $resizeGraphics = [System.Drawing.Graphics]::FromImage($target)
        $resizeGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $resizeGraphics.DrawImage($bitmap, 0, 0, $newWidth, $newHeight)
        $resizeGraphics.Dispose()
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $path = Join-Path $env:TEMP "win-mcp-shot-$stamp.png"
    $target.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

    $result = [ordered]@{
        path      = $path
        width     = $target.Width
        height    = $target.Height
        virtualX  = $x
        virtualY  = $y
        capturedAt = (Get-Date).ToString('o')
    }

    if (-not [object]::ReferenceEquals($target, $bitmap)) { $target.Dispose() }
    $bitmap.Dispose()
    $graphics.Dispose()
    return $result
}

function Get-WindowList {
    param([string]$Filter = '', [int]$MaxItems = 100)

    $windows = New-Object System.Collections.ArrayList
    $callback = [WinMcpDesktop+EnumWindowsProc] {
        param([IntPtr]$hWnd, [IntPtr]$lParam)

        if (-not [WinMcpDesktop]::IsWindowVisible($hWnd)) { return $true }
        $buffer = New-Object System.Text.StringBuilder 512
        [void][WinMcpDesktop]::GetWindowText($hWnd, $buffer, 512)
        $title = $buffer.ToString()
        if ([string]::IsNullOrWhiteSpace($title)) { return $true }
        if (-not [string]::IsNullOrWhiteSpace($Filter) -and $title -notlike "*$Filter*") { return $true }

        $processId = 0
        [void][WinMcpDesktop]::GetWindowThreadProcessId($hWnd, [ref]$processId)
        $processName = ''
        try { $processName = [string](Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { }

        [void]$windows.Add([ordered]@{
            handle      = [int64]$hWnd
            title       = $title
            processId   = [int]$processId
            processName = $processName
        })
        return $true
    }

    [void][WinMcpDesktop]::EnumWindows($callback, [IntPtr]::Zero)

    $items = @($windows | Select-Object -First $MaxItems)
    [ordered]@{ items = $items; count = $items.Count; totalVisible = $windows.Count }
}

function Set-WindowState {
    param([Parameter(Mandatory)][int64]$Handle, [Parameter(Mandatory)][string]$Action)

    $hWnd = [IntPtr]::new($Handle)
    if (-not [WinMcpDesktop]::IsWindow($hWnd)) { throw "WINDOW_NOT_FOUND: $Handle" }

    switch ($Action.ToLowerInvariant()) {
        'minimize' { [void][WinMcpDesktop]::ShowWindow($hWnd, 6) }
        'maximize' { [void][WinMcpDesktop]::ShowWindow($hWnd, 3) }
        'restore' { [void][WinMcpDesktop]::ShowWindow($hWnd, 9) }
        'activate' { [void][WinMcpDesktop]::SetForegroundWindow($hWnd) }
        'close' { [void][WinMcpDesktop]::PostMessage($hWnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
        default { throw "UNSUPPORTED_ACTION: $Action (minimize|maximize|restore|activate|close)" }
    }

    Start-Sleep -Milliseconds 150
    $buffer = New-Object System.Text.StringBuilder 512
    [void][WinMcpDesktop]::GetWindowText($hWnd, $buffer, 512)
    [ordered]@{
        handle  = $Handle
        action  = $Action.ToLowerInvariant()
        visible = [bool][WinMcpDesktop]::IsWindowVisible($hWnd)
        title   = $buffer.ToString()
    }
}

function Get-ClipboardContent {
    $text = ''
    try { $text = [string](Get-Clipboard -Raw -ErrorAction Stop) } catch { }
    [ordered]@{ text = $text; length = $text.Length; capturedAt = (Get-Date).ToString('o') }
}

function Set-ClipboardContent {
    param([AllowEmptyString()][string]$Text = '')
    Set-Clipboard -Value $Text
    $verified = ''
    try { $verified = [string](Get-Clipboard -Raw -ErrorAction Stop) } catch { }
    [ordered]@{ set = $true; length = $Text.Length; verifiedLength = $verified.Length }
}

# CL-011: UIA semantic tree, ref resolution, controlled input and desktop-control
# state live in a sibling file. Dot-sourced here so the single 'desktop' module
# entry in the bridge whitelist exposes all of them.
. (Join-Path $PSScriptRoot 'desktop-uia.ps1')