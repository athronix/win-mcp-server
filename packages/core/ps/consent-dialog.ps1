# consent-dialog.ps1 -- desktop control consent countdown.
#
# Runs as a SEPARATE process (see src/desktop/consent.ts):
#  - a GUI window must not share the MCP server's stdio pipes
#  - a hung/crashed dialog must not take the server down
#  - the answer travels through the exit code, never through stdout
#
# Exit codes (deliberately distinct from 0/1 crash codes):
#   10 = allow now
#   11 = deny (button or window close)
#   12 = countdown elapsed with no answer (auto-allow, keeps unattended runs working)
#   13 = no interactive session, dialog cannot be shown
#
# ASCII only (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

param(
    [int]$Seconds = 10,
    [string]$Title = 'AI 需要控制桌面',
    [string]$Message = 'AI 即将接管鼠标和键盘以完成当前任务。',
    [string]$AgentName = 'win-mcp'
)

$ErrorActionPreference = 'Stop'

if (-not [Environment]::UserInteractive) {
    [Console]::Error.WriteLine('CONSENT_NON_INTERACTIVE')
    exit 13
}

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
} catch {
    [Console]::Error.WriteLine("CONSENT_NO_WINFORMS: $($_.Exception.Message)")
    exit 13
}

$result = 11
# Script-scope handles: WinForms event handlers run later, in a different scope.
$script:result = 11
$script:remaining = [Math]::Max(0, $Seconds)

try {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = "$Title ($AgentName)"
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.TopMost = $true
    $form.Width = 460
    $form.Height = 210
    $form.BackColor = [System.Drawing.Color]::FromArgb(255, 32, 32, 32)
    $form.ForeColor = [System.Drawing.Color]::White

    $headline = New-Object System.Windows.Forms.Label
    $headline.Text = $Title
    $headline.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
    $headline.ForeColor = [System.Drawing.Color]::FromArgb(255, 255, 191, 0)
    $headline.SetBounds(16, 14, 420, 28)
    $form.Controls.Add($headline)

    $body = New-Object System.Windows.Forms.Label
    $body.Text = $Message
    $body.SetBounds(16, 48, 420, 56)
    $form.Controls.Add($body)

    $countdown = New-Object System.Windows.Forms.Label
    $countdown.SetBounds(16, 104, 420, 26)
    $countdown.Font = New-Object System.Drawing.Font('Segoe UI', 10)
    $form.Controls.Add($countdown)

    $allow = New-Object System.Windows.Forms.Button
    $allow.Text = '立即允许 (Allow now)'
    $allow.SetBounds(16, 138, 200, 32)
    $allow.Add_Click({ $script:result = 10; $form.Close() })
    $form.Controls.Add($allow)

    $deny = New-Object System.Windows.Forms.Button
    $deny.Text = '拒绝 (Deny)'
    $deny.SetBounds(236, 138, 200, 32)
    $deny.Add_Click({ $script:result = 11; $form.Close() })
    $form.Controls.Add($deny)

    $form.Add_FormClosing({ })

    if ($script:remaining -le 0) { $script:result = 10 }
    $countdown.Text = "无人应答将在 $($script:remaining) 秒后自动开始控制"

    $script:timer = New-Object System.Windows.Forms.Timer
    $script:timer.Interval = 1000
    $script:form = $form
    $script:countdown = $countdown
    $script:timer.Add_Tick({
        $script:remaining = $script:remaining - 1
        if ($script:remaining -le 0) {
            if ($script:result -eq 11) { $script:result = 12 }
            $script:timer.Stop()
            $script:form.Close()
            return
        }
        $script:countdown.Text = "无人应答将在 $($script:remaining) 秒后自动开始控制"
    })

    $form.Add_Shown({
        $form.Activate()
        if ($script:remaining -gt 0) { $script:timer.Start() }
    })

    if ($remaining -gt 0) {
        [void]$form.ShowDialog()
    }
    $result = [int]$script:result
} catch {
    [Console]::Error.WriteLine("CONSENT_DIALOG_FAILED: $($_.Exception.Message)")
    exit 13
}

exit $result