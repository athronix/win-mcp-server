# control-indicator.ps1 -- amber edge overlay shown while the AI holds the desktop lease.
#
# Runs as a SEPARATE process (spawned by src/desktop/indicator.ts) so a GUI hang
# cannot block the MCP server, and so killing it is enough to make the indicator
# disappear. Window styles are click-through + no-activate: the overlay must never
# steal focus or intercept a click.
#
# ASCII only (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

param(
    [int]$Seconds = 300,
    [string]$Color = '#FFBF00',
    [int]$Thickness = 6,
    [string]$Label = 'AI 控制桌面中 - 移动鼠标可夺回'
)

$ErrorActionPreference = 'Stop'

if (-not [Environment]::UserInteractive) { exit 13 }

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
} catch {
    exit 13
}

if (-not ('WinMcpOverlay' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class WinMcpOverlay {
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TRANSPARENT = 0x00000020;
    public const int WS_EX_LAYERED = 0x00080000;
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public const int WS_EX_TOOLWINDOW = 0x00000080;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    public static void MakeClickThrough(IntPtr hWnd) {
        int style = GetWindowLong(hWnd, GWL_EXSTYLE);
        style |= WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        SetWindowLong(hWnd, GWL_EXSTYLE, style);
    }
}
'@
}

$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$color = [System.Drawing.ColorTranslator]::FromHtml($Color)

$forms = New-Object System.Collections.ArrayList

function New-EdgeStrip {
    param([int]$X, [int]$Y, [int]$Width, [int]$Height)

    $strip = New-Object System.Windows.Forms.Form
    $strip.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $strip.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $strip.ShowInTaskbar = $false
    $strip.TopMost = $true
    $strip.BackColor = $color
    $strip.SetBounds($X, $Y, $Width, $Height)
    $strip.Show()
    [void][WinMcpOverlay]::MakeClickThrough($strip.Handle)
    return $strip
}

try {
    # four edges of the virtual screen
    [void]$forms.Add((New-EdgeStrip -X $screen.X -Y $screen.Y -Width $screen.Width -Height $Thickness))
    [void]$forms.Add((New-EdgeStrip -X $screen.X -Y ($screen.Y + $screen.Height - $Thickness) -Width $screen.Width -Height $Thickness))
    [void]$forms.Add((New-EdgeStrip -X $screen.X -Y $screen.Y -Width $Thickness -Height $screen.Height))
    [void]$forms.Add((New-EdgeStrip -X ($screen.X + $screen.Width - $Thickness) -Y $screen.Y -Width $Thickness -Height $screen.Height))

    # small caption so the user knows what the border means
    $caption = New-Object System.Windows.Forms.Form
    $caption.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $caption.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $caption.ShowInTaskbar = $false
    $caption.TopMost = $true
    $caption.BackColor = [System.Drawing.Color]::FromArgb(255, 32, 32, 32)
    $caption.SetBounds(($screen.X + [int](($screen.Width - 360) / 2)), ($screen.Y + 12), 360, 34)
    $text = New-Object System.Windows.Forms.Label
    $text.Text = $Label
    $text.ForeColor = $color
    $text.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
    $text.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
    $text.SetBounds(0, 0, 360, 34)
    $caption.Controls.Add($text)
    $caption.Show()
    [void][WinMcpOverlay]::MakeClickThrough($caption.Handle)
    [void]$forms.Add($caption)

    if ($Seconds -le 0) { $Seconds = 300 }
    $script:lifeTimer = New-Object System.Windows.Forms.Timer
    $script:lifeTimer.Interval = [Math]::Min($Seconds * 1000, 2147483647)
    $script:lifeTimer.Add_Tick({
        $script:lifeTimer.Stop()
        foreach ($form in $forms) { try { $form.Close() } catch { } }
        [System.Windows.Forms.Application]::ExitThread()
    })
    $script:lifeTimer.Start()

    [System.Windows.Forms.Application]::Run()
} catch {
    [Console]::Error.WriteLine("INDICATOR_FAILED: $($_.Exception.Message)")
    exit 1
}

exit 0