# desktop-uia.ps1 -- UIA semantic tree, ref resolution, controlled input.
# Dot-sourced from desktop.ps1 so functions land in the bridge script scope.
# ASCII only (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

Set-StrictMode -Version 1
$ErrorActionPreference = 'Stop'

# Declare every script-scope slot up front: StrictMode rejects reading an
# unassigned variable, and these are touched from several functions.
$script:DpiInitialized = $false
$script:UiaReady = $false
$script:UiSnapshots = @{}
$script:UiSnapshotSeq = 0
$script:UiSnapshotKeep = 8

# ---------------------------------------------------------------------------
# Native input / DPI / idle probe
# ---------------------------------------------------------------------------
if (-not ('WinMcpInput' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public struct WINMCP_POINT { public int X; public int Y; }
public struct WINMCP_LASTINPUTINFO { public uint cbSize; public uint dwTime; }

public class WinMcpInput {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out WINMCP_POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref WINMCP_LASTINPUTINFO plii);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    // --- Chromium/Electron renderer accessibility activation ---
    public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumChildProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint dwId, ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppvObject);

    // Asking for the MSAA object is what flips Chromium/Electron into accessibility
    // mode; before that the renderer exposes only "Chrome Legacy Window" with no
    // children. The caller must KEEP the returned object alive -- releasing it
    // immediately lets the renderer drop back out of accessibility mode.
    public static object RequestRendererAccessibility(IntPtr hwnd) {
        Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); // IID_IAccessible
        object acc = null;
        try {
            int hr = AccessibleObjectFromWindow(hwnd, 0xFFFFFFFC, ref iid, out acc);
            if (hr != 0) { return null; }
            return acc;
        } catch {
            return null;
        }
    }

    public static void ReleaseObject(object comObject) {
        if (comObject != null && Marshal.IsComObject(comObject)) {
            try { Marshal.ReleaseComObject(comObject); } catch { }
        }
    }
}
'@
}

# UIA BoundingRectangle and SetCursorPos only agree when the host is DPI aware.
# pwsh may already carry awareness; the call fails harmlessly in that case.
if (-not $script:DpiInitialized) {
    try {
        $dpiResult = [WinMcpInput]::SetProcessDpiAwareness(2)
        if ($dpiResult -ne 0) { [void][WinMcpInput]::SetProcessDPIAware() }
    } catch {
        try { [void][WinMcpInput]::SetProcessDPIAware() } catch { }
    }
    $script:DpiInitialized = $true
}

$script:UiSnapshots = @{}
$script:UiSnapshotSeq = 0
$script:UiSnapshotKeep = 8

$script:UiaRoleMap = @{
    'Button' = 'button'; 'Calendar' = 'grid'; 'CheckBox' = 'checkbox'; 'ComboBox' = 'combobox'
    'Edit' = 'textbox'; 'Hyperlink' = 'link'; 'Image' = 'img'; 'ListItem' = 'listitem'
    'List' = 'list'; 'Menu' = 'menu'; 'MenuBar' = 'menubar'; 'MenuItem' = 'menuitem'
    'ProgressBar' = 'progressbar'; 'RadioButton' = 'radio'; 'ScrollBar' = 'scrollbar'
    'Slider' = 'slider'; 'Spinner' = 'spinbutton'; 'StatusBar' = 'status'; 'Tab' = 'tab'
    'TabItem' = 'tabitem'; 'Text' = 'text'; 'ToolBar' = 'toolbar'; 'ToolTip' = 'tooltip'
    'Tree' = 'tree'; 'TreeItem' = 'treeitem'; 'Custom' = 'generic'; 'Group' = 'group'
    'Thumb' = 'thumb'; 'DataGrid' = 'grid'; 'DataItem' = 'row'; 'Document' = 'document'
    'SplitButton' = 'button'; 'Window' = 'window'; 'Pane' = 'group'; 'Header' = 'row'
    'HeaderItem' = 'columnheader'; 'Table' = 'table'; 'TitleBar' = 'titlebar'
    'Separator' = 'separator'; 'AppBar' = 'toolbar'
}

function Initialize-Uia {
    if ($script:UiaReady) { return }
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $script:UiaReady = $true
}

function Get-UiaSafe {
    param([scriptblock]$Getter, $Default = $null)
    try { return (& $Getter) } catch { return $Default }
}

function ConvertTo-UiaRole {
    param($ControlType)
    $name = ''
    try { $name = [string]$ControlType.ProgrammaticName } catch { return 'generic' }
    if ($name.StartsWith('ControlType.')) { $name = $name.Substring(12) }
    if ($script:UiaRoleMap.ContainsKey($name)) { return $script:UiaRoleMap[$name] }
    return $name.ToLowerInvariant()
}

function Get-UiaPatternSummary {
    param($Element)

    $actions = New-Object System.Collections.Generic.List[string]
    $states = New-Object System.Collections.Generic.List[string]

    $enabled = Get-UiaSafe { [bool]$Element.Current.IsEnabled } $true
    if (-not $enabled) { [void]$states.Add('disabled') }
    if (Get-UiaSafe { [bool]$Element.Current.IsKeyboardFocusable } $false) { [void]$states.Add('focusable') }
    if (Get-UiaSafe { [bool]$Element.Current.HasKeyboardFocus } $false) { [void]$states.Add('focused') }
    if (Get-UiaSafe { [bool]$Element.Current.IsOffscreen } $false) { [void]$states.Add('offscreen') }

    $pattern = $null

    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        [void]$actions.Add('click')
    }

    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
        $toggleState = Get-UiaSafe { [string]$pattern.Current.ToggleState } 'Off'
        [void]$actions.Add('toggle')
        if ($toggleState -eq 'On') { [void]$states.Add('checked') }
        if ($toggleState -eq 'Indeterminate') { [void]$states.Add('mixed') }
    }

    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
        $expandState = Get-UiaSafe { [string]$pattern.Current.ExpandCollapseState } 'LeafNode'
        if ($expandState -eq 'Expanded') {
            [void]$states.Add('expanded')
            [void]$actions.Add('collapse')
        } else {
            [void]$actions.Add('expand')
        }
    }

    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        [void]$actions.Add('select')
        if (Get-UiaSafe { [bool]$pattern.Current.IsSelected } $false) { [void]$states.Add('selected') }
    }

    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        [void]$actions.Add('setValue')
        if (Get-UiaSafe { [bool]$pattern.Current.IsReadOnly } $false) { [void]$states.Add('readonly') }
    }

    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern)) {
        [void]$actions.Add('scroll')
    }

    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$pattern)) {
        [void]$actions.Add('scrollIntoView')
    }

    [ordered]@{ actions = $actions.ToArray(); states = $states.ToArray() }
}

function Get-UiaValueText {
    param($Element)

    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $value = Get-UiaSafe { [string]$pattern.Current.Value } ''
        if (-not [string]::IsNullOrEmpty($value)) {
            if ($value.Length -gt 300) { $value = $value.Substring(0, 300) + '...' }
            return $value
        }
    }

    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
        $value = Get-UiaSafe { [string]$pattern.DocumentRange.GetText(200) } ''
        if (-not [string]::IsNullOrEmpty($value)) { return $value.Trim() }
    }

    return ''
}

function Get-UiaBoundingBox {
    param($Element)
    $rect = Get-UiaSafe { $Element.Current.BoundingRectangle } $null
    if ($null -eq $rect) { return $null }
    # Rect.Empty reports Width/Height as -Infinity; casting that to Int32 throws.
    $widthValue = Get-UiaSafe { [double]$rect.Width } 0
    $heightValue = Get-UiaSafe { [double]$rect.Height } 0
    if ([double]::IsNaN($widthValue) -or [double]::IsInfinity($widthValue)) { return $null }
    if ([double]::IsNaN($heightValue) -or [double]::IsInfinity($heightValue)) { return $null }
    $width = [int]$widthValue
    $height = [int]$heightValue
    if ($width -le 0 -or $height -le 0) { return $null }
    [ordered]@{
        x      = [int]([double]$rect.X)
        y      = [int]([double]$rect.Y)
        width  = $width
        height = $height
    }
}

function Get-UiaWindowRoot {
    param([int64]$Handle)

    Initialize-Uia
    # -1 明确表示"整个桌面根元素"（自动化里常用，但必须是显式请求：
    # 桌面根的扫描量远大于单窗口，不能作为默认值）
    if ($Handle -eq -1) {
        return [System.Windows.Automation.AutomationElement]::RootElement
    }
    if ($Handle -ne 0) {
        $hWnd = [IntPtr]::new($Handle)
        if (-not [WinMcpDesktop]::IsWindow($hWnd)) { throw "INVALID_PARAMS: window handle $Handle 不存在" }
        return [System.Windows.Automation.AutomationElement]::FromHandle($hWnd)
    }

    $foreground = [WinMcpInput]::GetForegroundWindow()
    if ($foreground -eq [IntPtr]::Zero) { throw "INVALID_PARAMS: 无法获取前台窗口" }
    return [System.Windows.Automation.AutomationElement]::FromHandle($foreground)
}

# Chromium/Electron 窗口在没有任何辅助技术连接时只暴露一个
# "Chrome Legacy Window"，子树完全为空。请求一次 MSAA 对象就会让渲染进程
# 进入可访问性模式（agent-desktop 把这一步叫 Chromium settle）。
# 返回触发次数，0 表示不是 Chromium 窗口。
function Get-RenderHostHandles {
    param([IntPtr]$WindowHandle)

    # Script scope on purpose: the delegate runs from native code, and a plain
    # local captured by the scriptblock is not reliably visible there.
    $script:RenderHostScratch = New-Object System.Collections.ArrayList
    $script:EnumFailure = ''
    $callback = [WinMcpInput+EnumChildProc] {
        param([IntPtr]$hWnd, [IntPtr]$lParam)

        try {
            $buffer = New-Object System.Text.StringBuilder 256
            [void][WinMcpInput]::GetClassName($hWnd, $buffer, 256)
            $className = $buffer.ToString()
            if ($className -like '*Chrome_RenderWidgetHost*') {
                [void]$script:RenderHostScratch.Add($hWnd)
            }
        } catch {
            $script:EnumFailure = $_.Exception.Message
        }
        return $true
    }

    try {
        [void][WinMcpInput]::EnumChildWindows($WindowHandle, $callback, [IntPtr]::Zero)
    } catch {
        $script:EnumFailure = $_.Exception.Message
    }
    return $script:RenderHostScratch
}

# 注：这里曾尝试"请求 MSAA 对象 + 以渲染宿主为根做 FindAll"来激活 Electron 的
# 可访问性。实测两个动作都会卡住数十秒且最终拿到 0 个子节点，因此整段删除。
# Electron 场景请用 --force-renderer-accessibility 启动，或走 win-browser 的 CDP。


function Get-UiaWindowMeta {
    param($Root)

    $handle = [int64](Get-UiaSafe { $Root.Current.NativeWindowHandle } 0)
    $processId = [int](Get-UiaSafe { $Root.Current.ProcessId } 0)
    $processName = ''
    if ($processId -gt 0) {
        $processName = Get-UiaSafe { [string](Get-Process -Id $processId -ErrorAction Stop).ProcessName } ''
    }
    [ordered]@{
        handle      = $handle
        title       = [string](Get-UiaSafe { $Root.Current.Name } '')
        processId   = $processId
        processName = $processName
    }
}

function Build-UiaNode {
    param($Element, [int]$Depth, $Context)

    if ($Context.Count -ge $Context.MaxNodes) {
        $Context.Truncated = $true
        return $null
    }

    $controlType = Get-UiaSafe { $Element.Current.ControlType } $null
    $role = ConvertTo-UiaRole $controlType
    $name = [string](Get-UiaSafe { $Element.Current.Name } '')
    if ($null -eq $name) { $name = '' }
    if ($name.Length -gt 200) { $name = $name.Substring(0, 200) + '...' }

    $offscreen = [bool](Get-UiaSafe { $Element.Current.IsOffscreen } $false)
    $summary = Get-UiaPatternSummary $Element
    $actions = @($summary.actions)

    # Build the subtree first: a node survives when it carries its own evidence OR
    # keeps a surviving descendant (structural containers stay on the path).
    $children = New-Object System.Collections.ArrayList
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    if ($Depth -lt $Context.MaxDepth) {
        $child = Get-UiaSafe { $walker.GetFirstChild($Element) } $null
        while ($null -ne $child) {
            $childNode = Build-UiaNode -Element $child -Depth ($Depth + 1) -Context $Context
            if ($null -ne $childNode) { [void]$children.Add($childNode) }
            $next = Get-UiaSafe { $walker.GetNextSibling($child) } $null
            $child = $next
        }
    }

    $keep = ($name.Length -gt 0) -or ($actions.Count -gt 0) -or ($children.Count -gt 0)
    if ($offscreen -and -not $Context.IncludeOffscreen -and $children.Count -eq 0) { $keep = $false }
    if (-not $keep) { return $null }

    if ($Context.Filter.Length -gt 0 -and $name.IndexOf($Context.Filter, [StringComparison]::OrdinalIgnoreCase) -lt 0 -and $children.Count -eq 0) {
        return $null
    }

    $Context.Count = $Context.Count + 1

    $runtimeId = ''
    try {
        $ids = $Element.GetRuntimeId()
        if ($null -ne $ids) { $runtimeId = ($ids | ForEach-Object { [string]$_ }) -join '.' }
    } catch { }

    [ordered]@{
        role         = $role
        name         = $name
        depth        = $Depth
        states       = @($summary.states)
        actions      = $actions
        bounds       = (Get-UiaBoundingBox $Element)
        value        = (Get-UiaValueText $Element)
        automationId = [string](Get-UiaSafe { $Element.Current.AutomationId } '')
        className    = [string](Get-UiaSafe { $Element.Current.ClassName } '')
        children     = $children.ToArray()
        identity     = [ordered]@{
            runtimeId    = $runtimeId
            role         = $role
            name         = $name
            automationId = [string](Get-UiaSafe { $Element.Current.AutomationId } '')
            className    = [string](Get-UiaSafe { $Element.Current.ClassName } '')
            windowHandle = $Context.WindowHandle
            element      = $Element
        }
    }
}

# Flatten depth-first, pre-order: assigning refs during the flatten pass is what
# keeps the list readable (parent always precedes its subtree).
function Expand-UiaNode {
    param($Node, $Flat, $Identities)

    $index = $Flat.Count
    $entry = [ordered]@{
        ref          = $null
        role         = $Node.role
        name         = $Node.name
        depth        = $Node.depth
        states       = $Node.states
        actions      = $Node.actions
        bounds       = $Node.bounds
        value        = $Node.value
        automationId = $Node.automationId
        className    = $Node.className
        children     = @()
    }
    [void]$Flat.Add($entry)
    [void]$Identities.Add($Node.identity)

    $childIndices = New-Object System.Collections.Generic.List[int]
    foreach ($child in $Node.children) {
        [void]$childIndices.Add((Expand-UiaNode -Node $child -Flat $Flat -Identities $Identities))
    }
    $entry.children = $childIndices.ToArray()

    return $index
}

function Get-UiTree {
    param(
        [int64]$Handle = 0,
        [int]$MaxDepth = 8,
        [int]$MaxNodes = 600,
        [bool]$IncludeOffscreen = $false,
        [string]$Filter = '',
        [bool]$EnableRendererSettle = $true
    )

    Initialize-Uia

    if ($MaxDepth -lt 1) { $MaxDepth = 1 }
    if ($MaxDepth -gt 20) { $MaxDepth = 20 }
    if ($MaxNodes -lt 20) { $MaxNodes = 20 }
    if ($MaxNodes -gt 3000) { $MaxNodes = 3000 }

    $root = Get-UiaWindowRoot -Handle $Handle
    # 桌面根的 NativeWindowHandle 是无意义的值（实测会返回某个 csrss 窗口句柄），
    # 用它去做 Chromium settle 会枚举到一堆无关子窗口，必须显式短路。
    $isDesktopRoot = ($Handle -eq -1)
    $meta = if ($isDesktopRoot) {
        [ordered]@{ handle = [int64]0; title = '(entire desktop)'; processId = 0; processName = '' }
    } else {
        Get-UiaWindowMeta -Root $root
    }

    # Chromium/Electron: 顶层窗口只暴露一个空的 "Chrome Legacy Window"。
    # 我们只**探测**（按窗口类名，很便宜）用于告警，不去请求 MSAA、也不拿渲染宿主
    # 当快照根 —— 实测这两步会卡住数十秒（Electron 渲染进程不响应 UIA 树请求），
    # 那个代价换不来可用结果，正确做法见 warnings 里指向的 CDP 通道。
    $rendererTriggers = 0
    $rendererRoot = 'window'
    $renderHostCount = 0
    $walkRoot = $root
    if ($meta.handle -ne 0) {
        try {
            $renderHosts = Get-RenderHostHandles -WindowHandle ([IntPtr]::new([int64]$meta.handle))
            $renderHostCount = $renderHosts.Count
        } catch {
            $renderHostCount = 0
        }
    }

    $script:UiSnapshotSeq = $script:UiSnapshotSeq + 1
    $snapshotId = $script:UiSnapshotSeq

    $context = @{
        Count            = 0
        MaxNodes         = $MaxNodes
        MaxDepth         = $MaxDepth
        IncludeOffscreen = $IncludeOffscreen
        Filter           = $Filter
        Truncated        = $false
        WindowHandle     = [int64]$meta.handle
    }

    $rootNode = Build-UiaNode -Element $walkRoot -Depth 0 -Context $context

    $nodes = New-Object System.Collections.ArrayList
    $identities = New-Object System.Collections.ArrayList
    if ($null -ne $rootNode) {
        [void](Expand-UiaNode -Node $rootNode -Flat $nodes -Identities $identities)
    }

    for ($i = 0; $i -lt $nodes.Count; $i++) {
        $nodes[$i].ref = "@s$snapshotId" + ":e$i"
    }

    $script:UiSnapshots[$snapshotId] = $identities.ToArray()

    # Retain a bounded history so an old ref reports STALE_REF with a clear message
    # instead of silently resolving against a newer snapshot.
    $stale = @($script:UiSnapshots.Keys | Sort-Object)
    while ($stale.Count -gt $script:UiSnapshotKeep) {
        $script:UiSnapshots.Remove($stale[0])
        $stale = @($stale | Select-Object -Skip 1)
    }

    $warnings = New-Object System.Collections.ArrayList
    $minimized = $false
    if ($meta.handle -ne 0) {
        $minimized = [bool](Get-UiaSafe { [WinMcpDesktop]::IsIconic([IntPtr]::new([int64]$meta.handle)) } $false)
    }
    if ($minimized) {
        [void]$warnings.Add('窗口处于最小化状态，UIA 子树基本为空；请先用 desktop.window.control 的 restore 恢复窗口再快照。')
    }
    if ($renderHostCount -gt 0 -and $nodes.Count -le 2) {
        [void]$warnings.Add(
            '该窗口是 Chromium/Electron，渲染进程未开启可访问性，语义树只有外壳。' +
            '可让应用以 --force-renderer-accessibility 启动，或改用 win-browser 的 CDP 通道（browser.cdp.*）。'
        )
    }

    [ordered]@{
        snapshotId  = $snapshotId
        window      = $meta
        nodes       = $nodes
        nodeCount   = $nodes.Count
        truncated   = [bool]$context.Truncated
        maxDepth    = $MaxDepth
        maxNodes    = $MaxNodes
        rendererAccessibility = $rendererTriggers
        rendererRoot = $rendererRoot
        minimized   = $minimized
        renderHostCount = $renderHostCount
        warnings    = $warnings.ToArray()
        capturedAt  = (Get-Date).ToString('o')
        refHint     = "refs are only valid for snapshot s$snapshotId; re-run desktop.ui.snapshot after the UI changes"
    }
}

function Get-UiaIdentityKey {
    param($Identity)
    return ("{0}|{1}|{2}" -f $Identity.role, $Identity.automationId, $Identity.name)
}

function Find-UiaByRuntimeId {
    param($Root, [string]$RuntimeId)

    if ([string]::IsNullOrEmpty($RuntimeId)) { return $null }
    $all = $Root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $total = [Math]::Min($all.Count, 4000)
    for ($i = 0; $i -lt $total; $i++) {
        $candidate = $all.Item($i)
        $ids = $null
        try { $ids = $candidate.GetRuntimeId() } catch { continue }
        if ($null -eq $ids) { continue }
        $joined = ($ids | ForEach-Object { [string]$_ }) -join '.'
        if ($joined -eq $RuntimeId) { return $candidate }
    }
    return $null
}

function Find-UiaByIdentity {
    param($Root, $Identity)

    $key = Get-UiaIdentityKey $Identity
    $all = $Root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $hits = New-Object System.Collections.ArrayList
    $total = [Math]::Min($all.Count, 4000)
    for ($i = 0; $i -lt $total; $i++) {
        $candidate = $all.Item($i)
        $role = ConvertTo-UiaRole (Get-UiaSafe { $candidate.Current.ControlType } $null)
        $automationId = [string](Get-UiaSafe { $candidate.Current.AutomationId } '')
        $name = [string](Get-UiaSafe { $candidate.Current.Name } '')
        $candidateKey = "{0}|{1}|{2}" -f $role, $automationId, $name
        if ($candidateKey -eq $key) { [void]$hits.Add($candidate) }
    }

    if ($hits.Count -eq 0) { return $null }
    if ($hits.Count -gt 1) {
        throw "AMBIGUOUS_TARGET: $($hits.Count) 个元素匹配 $key，请重新快照并改用更具体的元素"
    }
    return $hits[0]
}

function Resolve-UiRef {
    param([string]$Ref)

    if ($Ref -notmatch '^@s(\d+):e(\d+)$') {
        throw "INVALID_PARAMS: ref 必须形如 @s3:e12（收到 '$Ref'）"
    }
    $snapshotId = [int]$Matches[1]
    $index = [int]$Matches[2]

    if (-not $script:UiSnapshots.ContainsKey($snapshotId)) {
        throw "STALE_REF: 快照 s$snapshotId 已不在内存中，请重新调用 desktop.ui.snapshot"
    }
    $identities = $script:UiSnapshots[$snapshotId]
    if ($index -lt 0 -or $index -ge $identities.Count) {
        throw "STALE_REF: $Ref 不在快照 s$snapshotId 的范围内（共 $($identities.Count) 个元素）"
    }

    $identity = $identities[$index]
    $element = $identity.element

    # 1) fast path -- the captured element is still alive and unchanged
    $alive = $false
    try {
        $null = $element.Current.Name
        $alive = $true
    } catch {
        $alive = $false
    }

    if ($alive) {
        $currentIds = $null
        try { $currentIds = $element.GetRuntimeId() } catch { $currentIds = $null }
        $currentJoined = ''
        if ($null -ne $currentIds) { $currentJoined = ($currentIds | ForEach-Object { [string]$_ }) -join '.' }
        if ($currentJoined -eq $identity.runtimeId) {
            return [ordered]@{ element = $element; via = 'live-object'; identity = $identity }
        }
    }

    # 2) the UI rebuilt -- re-identify by runtime id inside the same window
    $windowHandle = [int64]$identity.windowHandle
    $root = $null
    if ($windowHandle -ne 0) {
        try { $root = Get-UiaWindowRoot -Handle $windowHandle } catch { $root = $null }
    }

    if ($null -eq $root) {
        # Fall back to the captured process so a re-parented window is still searchable
        $processId = 0
        try { $processId = [int]$element.Current.ProcessId } catch { $processId = 0 }
        if ($processId -le 0) { throw "STALE_REF: $Ref 已失效且无法定位所属窗口，请重新快照" }
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $processId
        )
        $root = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants, $condition
        )
        if ($null -eq $root) { throw "STALE_REF: 进程 $processId 的窗口已关闭，请重新快照" }
    }

    $byRuntimeId = Find-UiaByRuntimeId -Root $root -RuntimeId $identity.runtimeId
    if ($null -ne $byRuntimeId) {
        return [ordered]@{ element = $byRuntimeId; via = 'runtime-id'; identity = $identity }
    }

    $byIdentity = Find-UiaByIdentity -Root $root -Identity $identity
    if ($null -ne $byIdentity) {
        return [ordered]@{ element = $byIdentity; via = 'identity'; identity = $identity }
    }

    throw "STALE_REF: $Ref ($($identity.role) '$($identity.name)') 已不存在，请重新快照"
}

function Invoke-UiaMouseClick {
    param([int]$X, [int]$Y, [string]$Button = 'left', [int]$Count = 1)

    [void][WinMcpInput]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 40

    $down = 0x0002
    $up = 0x0004
    if ($Button -eq 'right') { $down = 0x0008; $up = 0x0010 }
    if ($Button -eq 'middle') { $down = 0x0020; $up = 0x0040 }

    for ($i = 0; $i -lt $Count; $i++) {
        [WinMcpInput]::mouse_event([uint32]$down, 0, 0, 0, [UIntPtr]::Zero)
        [WinMcpInput]::mouse_event([uint32]$up, 0, 0, 0, [UIntPtr]::Zero)
        if ($i -lt ($Count - 1)) { Start-Sleep -Milliseconds 60 }
    }
}

function Invoke-UiAction {
    param(
        [Parameter(Mandatory)][string]$Ref,
        [string]$Action = 'click',
        [AllowEmptyString()][string]$Text = '',
        [bool]$AllowMouseFallback = $true
    )

    Initialize-Uia
    $resolved = Resolve-UiRef -Ref $Ref
    $element = $resolved.element
    $identity = $resolved.identity
    $actionName = $Action.ToLowerInvariant()

    $via = ''
    $pattern = $null

    switch ($actionName) {
        'focus' {
            $element.SetFocus()
            $via = 'set-focus'
        }
        'click' {
            if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                $pattern.Invoke()
                $via = 'invoke-pattern'
            } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
                $pattern.Toggle()
                $via = 'toggle-pattern'
            } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
                $pattern.Select()
                $via = 'selection-item-pattern'
            } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
                $state = Get-UiaSafe { [string]$pattern.Current.ExpandCollapseState } 'Collapsed'
                if ($state -eq 'Expanded') { $pattern.Collapse() } else { $pattern.Expand() }
                $via = 'expand-collapse-pattern'
            } elseif ($AllowMouseFallback) {
                $box = Get-UiaBoundingBox $element
                if ($null -eq $box) { throw "STALE_REF: $Ref 不可见且无可点击区域" }
                Invoke-UiaMouseClick -X ($box.x + [int]($box.width / 2)) -Y ($box.y + [int]($box.height / 2))
                $via = 'mouse-fallback'
            } else {
                throw "INVALID_PARAMS: $Ref ($($identity.role)) 不支持 click，且未允许鼠标回退"
            }
        }
        'doubleclick' {
            $box = Get-UiaBoundingBox $element
            if ($null -eq $box) { throw "STALE_REF: $Ref 无可点击区域" }
            Invoke-UiaMouseClick -X ($box.x + [int]($box.width / 2)) -Y ($box.y + [int]($box.height / 2)) -Count 2
            $via = 'mouse-double-click'
        }
        'rightclick' {
            $box = Get-UiaBoundingBox $element
            if ($null -eq $box) { throw "STALE_REF: $Ref 无可点击区域" }
            Invoke-UiaMouseClick -X ($box.x + [int]($box.width / 2)) -Y ($box.y + [int]($box.height / 2)) -Button 'right'
            $via = 'mouse-right-click'
        }
        'setvalue' {
            if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                $readOnly = Get-UiaSafe { [bool]$pattern.Current.IsReadOnly } $false
                if (-not $readOnly) {
                    $pattern.SetValue($Text)
                    $via = 'value-pattern'
                } else {
                    throw "INVALID_PARAMS: $Ref 是只读控件，不能 setValue"
                }
            } elseif ($AllowMouseFallback) {
                $element.SetFocus()
                Start-Sleep -Milliseconds 60
                Send-UiInput -Action 'press' -Chord 'Ctrl+A'
                Start-Sleep -Milliseconds 40
                Send-UiInput -Action 'type' -Text $Text
                $via = 'focus-and-type'
            } else {
                throw "INVALID_PARAMS: $Ref 不支持 setValue"
            }
        }
        'toggle' {
            if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
                $pattern.Toggle()
                $via = 'toggle-pattern'
            } else {
                throw "INVALID_PARAMS: $Ref 不支持 toggle"
            }
        }
        'expand' {
            if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
                $pattern.Expand()
                $via = 'expand-collapse-pattern'
            } else {
                throw "INVALID_PARAMS: $Ref 不支持 expand"
            }
        }
        'collapse' {
            if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
                $pattern.Collapse()
                $via = 'expand-collapse-pattern'
            } else {
                throw "INVALID_PARAMS: $Ref 不支持 collapse"
            }
        }
        'select' {
            if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
                $pattern.Select()
                $via = 'selection-item-pattern'
            } else {
                throw "INVALID_PARAMS: $Ref 不支持 select"
            }
        }
        'scrollintoview' {
            if ($element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$pattern)) {
                $pattern.ScrollIntoView()
                $via = 'scroll-item-pattern'
            } else {
                $element.SetFocus()
                $via = 'set-focus'
            }
        }
        'gettext' {
            $text = Get-UiaValueText $element
            return [ordered]@{
                ref    = $Ref
                action = 'getText'
                via    = 'read-only'
                text   = $text
            }
        }
        default {
            throw "INVALID_PARAMS: 不支持 action=$Action（click|doubleClick|rightClick|setValue|focus|toggle|expand|collapse|select|scrollIntoView|getText）"
        }
    }

    Start-Sleep -Milliseconds 120

    $readback = [ordered]@{
        name  = [string](Get-UiaSafe { $element.Current.Name } '')
        value = Get-UiaValueText $element
    }

    [ordered]@{
        ref      = $Ref
        action   = $actionName
        via      = $via
        resolved = $resolved.via
        role     = $identity.role
        readback = $readback
    }
}

# ---------------------------------------------------------------------------
# Keyboard / mouse injection
# ---------------------------------------------------------------------------
$script:KeyNameMap = @{
    'BACKSPACE' = 0x08; 'TAB' = 0x09; 'ENTER' = 0x0D; 'RETURN' = 0x0D; 'SHIFT' = 0x10
    'CTRL' = 0x11; 'CONTROL' = 0x11; 'ALT' = 0x12; 'PAUSE' = 0x13; 'CAPSLOCK' = 0x14
    'ESC' = 0x1B; 'ESCAPE' = 0x1B; 'SPACE' = 0x20; 'PAGEUP' = 0x21; 'PAGEDOWN' = 0x22
    'END' = 0x23; 'HOME' = 0x24; 'LEFT' = 0x25; 'UP' = 0x26; 'RIGHT' = 0x27; 'DOWN' = 0x28
    'PRINTSCREEN' = 0x2C; 'INSERT' = 0x2D; 'DELETE' = 0x2E; 'DEL' = 0x2E
    'WIN' = 0x5B; 'LWIN' = 0x5B; 'RWIN' = 0x5C; 'APPS' = 0x5D
    'NUMLOCK' = 0x90; 'SCROLLLOCK' = 0x91
    'SEMICOLON' = 0xBA; 'EQUALS' = 0xBB; 'COMMA' = 0xBC; 'MINUS' = 0xBD
    'PERIOD' = 0xBE; 'SLASH' = 0xBF; 'BACKTICK' = 0xC0; 'LBRACKET' = 0xDB
    'BACKSLASH' = 0xDC; 'RBRACKET' = 0xDD; 'QUOTE' = 0xDE
}

$script:ExtendedKeys = @(0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x90)

function ConvertTo-VirtualKey {
    param([string]$Name)

    $upper = $Name.ToUpperInvariant()
    if ($script:KeyNameMap.ContainsKey($upper)) { return [int]$script:KeyNameMap[$upper] }
    if ($upper.Length -eq 1) {
        $code = [int][char]$upper
        if ($code -ge 0x30 -and $code -le 0x39) { return $code }
        if ($code -ge 0x41 -and $code -le 0x5A) { return $code }
        return $code
    }
    if ($upper -match '^F([1-9]|1[0-9]|2[0-4])$') {
        return 0x6F + [int]$Matches[1]
    }
    throw "INVALID_PARAMS: 未知按键 '$Name'"
}

function Send-KeyDown {
    param([int]$VirtualKey)
    $flags = [uint32]0
    if ($script:ExtendedKeys -contains $VirtualKey) { $flags = 0x0001 }
    [WinMcpInput]::keybd_event([byte]$VirtualKey, [byte]0, $flags, [UIntPtr]::Zero)
}

function Send-KeyUp {
    param([int]$VirtualKey)
    $flags = [uint32]0x0002
    if ($script:ExtendedKeys -contains $VirtualKey) { $flags = 0x0003 }
    [WinMcpInput]::keybd_event([byte]$VirtualKey, [byte]0, $flags, [UIntPtr]::Zero)
}

function Send-UnicodeText {
    param([AllowEmptyString()][string]$Text)

    foreach ($character in $Text.ToCharArray()) {
        $code = [int][char]$character
        [WinMcpInput]::keybd_event([byte]0, [byte]($code -band 0xFF), [uint32]0x0004, [UIntPtr]::Zero)
        [WinMcpInput]::keybd_event([byte]0, [byte](($code -shr 8) -band 0xFF), [uint32]0x0004, [UIntPtr]::Zero)
        [WinMcpInput]::keybd_event([byte]0, [byte]($code -band 0xFF), [uint32]0x0006, [UIntPtr]::Zero)
        [WinMcpInput]::keybd_event([byte]0, [byte](($code -shr 8) -band 0xFF), [uint32]0x0006, [UIntPtr]::Zero)
    }
}

function Send-UiInput {
    param(
        [Parameter(Mandatory)][string]$Action,
        [string]$Chord = '',
        [AllowEmptyString()][string]$Text = '',
        [int]$X = -1,
        [int]$Y = -1,
        [string]$Button = 'left',
        [int]$Count = 1,
        [int]$Delta = 0,
        [int]$ToX = -1,
        [int]$ToY = -1
    )

    $actionName = $Action.ToLowerInvariant()

    switch ($actionName) {
        'press' {
            if ([string]::IsNullOrWhiteSpace($Chord)) { throw "INVALID_PARAMS: press 需要 chord，如 Ctrl+Shift+Esc" }
            $parts = @($Chord.Split('+') | Where-Object { $_.Length -gt 0 } | ForEach-Object { $_.Trim() })
            if ($parts.Count -eq 0) { throw "INVALID_PARAMS: chord 为空" }

            $modifiers = New-Object System.Collections.Generic.List[int]
            for ($i = 0; $i -lt ($parts.Count - 1); $i++) {
                [void]$modifiers.Add((ConvertTo-VirtualKey $parts[$i]))
            }
            $primary = ConvertTo-VirtualKey $parts[$parts.Count - 1]

            foreach ($modifier in $modifiers) { Send-KeyDown -VirtualKey $modifier }
            Start-Sleep -Milliseconds 25
            Send-KeyDown -VirtualKey $primary
            Send-KeyUp -VirtualKey $primary
            Start-Sleep -Milliseconds 25
            for ($i = $modifiers.Count - 1; $i -ge 0; $i--) { Send-KeyUp -VirtualKey $modifiers[$i] }

            return [ordered]@{ action = 'press'; chord = $Chord; sent = $true }
        }
        'type' {
            if ($Text.Length -eq 0) { throw "INVALID_PARAMS: type 需要 text" }
            Send-UnicodeText -Text $Text
            return [ordered]@{ action = 'type'; length = $Text.Length; sent = $true }
        }
        'click' {
            if ($X -lt 0 -or $Y -lt 0) { throw "INVALID_PARAMS: click 需要 x/y" }
            Invoke-UiaMouseClick -X $X -Y $Y -Button $Button -Count $Count
            return [ordered]@{ action = 'click'; x = $X; y = $Y; button = $Button; count = $Count; sent = $true }
        }
        'move' {
            if ($X -lt 0 -or $Y -lt 0) { throw "INVALID_PARAMS: move 需要 x/y" }
            [void][WinMcpInput]::SetCursorPos($X, $Y)
            return [ordered]@{ action = 'move'; x = $X; y = $Y; sent = $true }
        }
        'scroll' {
            if ($X -ge 0 -and $Y -ge 0) { [void][WinMcpInput]::SetCursorPos($X, $Y) }
            if ($Delta -eq 0) { $Delta = -120 }
            [WinMcpInput]::mouse_event([uint32]0x0800, 0, 0, [int]$Delta, [UIntPtr]::Zero)
            return [ordered]@{ action = 'scroll'; delta = $Delta; sent = $true }
        }
        'drag' {
            if ($X -lt 0 -or $Y -lt 0 -or $ToX -lt 0 -or $ToY -lt 0) {
                throw "INVALID_PARAMS: drag 需要 x/y 与 toX/toY"
            }
            [void][WinMcpInput]::SetCursorPos($X, $Y)
            Start-Sleep -Milliseconds 60
            [WinMcpInput]::mouse_event([uint32]0x0002, 0, 0, 0, [UIntPtr]::Zero)
            $steps = 12
            for ($i = 1; $i -le $steps; $i++) {
                $stepX = $X + [int](($ToX - $X) * $i / $steps)
                $stepY = $Y + [int](($ToY - $Y) * $i / $steps)
                [void][WinMcpInput]::SetCursorPos($stepX, $stepY)
                Start-Sleep -Milliseconds 18
            }
            [WinMcpInput]::mouse_event([uint32]0x0004, 0, 0, 0, [UIntPtr]::Zero)
            return [ordered]@{ action = 'drag'; fromX = $X; fromY = $Y; toX = $ToX; toY = $ToY; sent = $true }
        }
        default {
            throw "INVALID_PARAMS: 不支持 input action=$Action（press|type|click|move|scroll|drag）"
        }
    }
}

# ---------------------------------------------------------------------------
# Desktop control state (policy persistence + idle/foreground evidence)
# ---------------------------------------------------------------------------
function Get-ControlStatePath {
    $root = Join-Path $env:LOCALAPPDATA 'win-mcp'
    if (-not (Test-Path -LiteralPath $root)) { [void](New-Item -ItemType Directory -Path $root -Force) }
    return (Join-Path $root 'desktop-control.json')
}

function Get-ControlPolicyName {
    $path = Get-ControlStatePath
    if (-not (Test-Path -LiteralPath $path)) { return 'balanced' }
    try {
        $raw = Get-Content -LiteralPath $path -Raw -ErrorAction Stop
        $parsed = $raw | ConvertFrom-Json
        $policy = [string]$parsed.policy
        if ($policy -in @('relaxed', 'balanced', 'strict')) { return $policy }
    } catch { }
    return 'balanced'
}

function Set-ControlPolicy {
    param([Parameter(Mandatory)][string]$Policy)

    $normalized = $Policy.ToLowerInvariant()
    if ($normalized -notin @('relaxed', 'balanced', 'strict')) {
        throw "INVALID_PARAMS: policy 只能是 relaxed|balanced|strict（收到 '$Policy'）"
    }
    $previous = Get-ControlPolicyName
    $path = Get-ControlStatePath
    $payload = [ordered]@{
        policy    = $normalized
        updatedAt = (Get-Date).ToString('o')
    }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding utf8
    [ordered]@{ previous = $previous; policy = $normalized; path = $path }
}

function Get-ControlState {
    $idleMs = -1
    try {
        $info = New-Object WINMCP_LASTINPUTINFO
        $info.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($info)
        if ([WinMcpInput]::GetLastInputInfo([ref]$info)) {
            $idleMs = [int]([Environment]::TickCount - [int64]$info.dwTime)
            if ($idleMs -lt 0) { $idleMs = 0 }
        }
    } catch { $idleMs = -1 }

    $cursor = New-Object WINMCP_POINT
    [void][WinMcpInput]::GetCursorPos([ref]$cursor)

    $foreground = [WinMcpInput]::GetForegroundWindow()
    $foregroundInfo = $null
    if ($foreground -ne [IntPtr]::Zero) {
        $buffer = New-Object System.Text.StringBuilder 512
        [void][WinMcpDesktop]::GetWindowText($foreground, $buffer, 512)
        $foregroundProcessId = 0
        [void][WinMcpDesktop]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
        $foregroundInfo = [ordered]@{
            handle    = [int64]$foreground
            title     = $buffer.ToString()
            processId = [int]$foregroundProcessId
        }
    }

    [ordered]@{
        policy        = Get-ControlPolicyName
        idleMs        = $idleMs
        cursor        = [ordered]@{ x = [int]$cursor.X; y = [int]$cursor.Y }
        foreground    = $foregroundInfo
        interactive   = [bool][Environment]::UserInteractive
        capturedAt    = (Get-Date).ToString('o')
    }
}
# ---------------------------------------------------------------------------
# CL-015: wait for a UI condition (server-side polling)
# ---------------------------------------------------------------------------
# Why server-side: every client-side poll costs a tool round-trip plus a full
# snapshot transfer. One call that blocks up to TimeoutMs is dramatically cheaper
# and lets the returned node carry a usable ref from the matching snapshot.
function Test-UiNodeMatch {
    param($Node, [string]$Text, [string]$Role, [string]$AutomationId)

    if ($Role.Length -gt 0 -and [string]$Node.role -ne $Role) { return $false }
    if ($AutomationId.Length -gt 0 -and [string]$Node.automationId -ne $AutomationId) { return $false }
    if ($Text.Length -gt 0) {
        $name = [string]$Node.name
        if ($name.IndexOf($Text, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
    }
    return $true
}

# Lightweight scan used by the wait loop: reads only ControlType/Name/AutomationId.
# The full snapshot probes 7 control patterns + bounds per node, which costs
# seconds on big windows -- far too slow to run every poll.
function Find-UiElementFast {
    param($Element, [int]$Depth, $Context)

    if ($Context.Visited -ge $Context.MaxNodes) {
        $Context.Truncated = $true
        return $null
    }
    $Context.Visited = $Context.Visited + 1

    $controlType = Get-UiaSafe { $Element.Current.ControlType } $null
    $role = ConvertTo-UiaRole $controlType
    $name = [string](Get-UiaSafe { $Element.Current.Name } '')
    $automationId = [string](Get-UiaSafe { $Element.Current.AutomationId } '')

    $candidate = [ordered]@{ role = $role; name = $name; automationId = $automationId }
    if (Test-UiNodeMatch -Node $candidate -Text $Context.Text -Role $Context.Role -AutomationId $Context.AutomationId) {
        return [ordered]@{ role = $role; name = $name; automationId = $automationId; element = $Element }
    }

    if ($Depth -ge $Context.MaxDepth) { return $null }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = Get-UiaSafe { $walker.GetFirstChild($Element) } $null
    while ($null -ne $child) {
        $result = Find-UiElementFast -Element $child -Depth ($Depth + 1) -Context $Context
        if ($null -ne $result) { return $result }
        $child = Get-UiaSafe { $walker.GetNextSibling($child) } $null
    }
    return $null
}

function Wait-UiCondition {
    param(
        [int64]$Handle = 0,
        [string]$Text = '',
        [string]$Role = '',
        [string]$AutomationId = '',
        [bool]$Disappear = $false,
        [int]$TimeoutMs = 10000,
        [int]$PollMs = 250,
        [int]$MaxNodes = 400,
        [int]$MaxDepth = 8
    )

    if ($TimeoutMs -lt 100) { $TimeoutMs = 100 }
    if ($TimeoutMs -gt 60000) { $TimeoutMs = 60000 }
    if ($PollMs -lt 100) { $PollMs = 100 }
    if ($PollMs -gt 5000) { $PollMs = 5000 }
    if ([string]::IsNullOrEmpty($Text) -and [string]::IsNullOrEmpty($Role) -and [string]::IsNullOrEmpty($AutomationId)) {
        throw 'INVALID_PARAMS: wait 至少需要一个条件（text / role / automationId）'
    }

    Initialize-Uia
    $root = Get-UiaWindowRoot -Handle $Handle
    $meta = Get-UiaWindowMeta -Root $root

    $started = [DateTime]::UtcNow
    $polls = 0
    $lastVisited = 0

    while ($true) {
        $polls = $polls + 1
        $context = @{
            Text = $Text; Role = $Role; AutomationId = $AutomationId
            MaxNodes = $MaxNodes; MaxDepth = $MaxDepth
            Visited = 0; Truncated = $false
        }
        $found = Find-UiElementFast -Element $root -Depth 0 -Context $context
        $lastVisited = $context.Visited
        $elapsed = [int]([DateTime]::UtcNow - $started).TotalMilliseconds

        if ($Disappear -and $null -eq $found) {
            return [ordered]@{
                matched = $true; condition = 'disappear'; waitedMs = $elapsed; polls = $polls
                visited = $lastVisited; window = $meta
            }
        }

        if (-not $Disappear -and $null -ne $found) {
            # 命中后再做一次完整快照，把 ref 交给调用方直接使用
            $snapshot = Get-UiTree -Handle $meta.handle -MaxDepth $MaxDepth -MaxNodes ([Math]::Max($MaxNodes, 600)) -EnableRendererSettle $false
            $matchedNode = $null
            foreach ($node in $snapshot.nodes) {
                if (Test-UiNodeMatch -Node $node -Text $Text -Role $Role -AutomationId $AutomationId) {
                    $matchedNode = $node
                    break
                }
            }
            return [ordered]@{
                matched    = $true
                condition  = 'appear'
                waitedMs   = $elapsed
                polls      = $polls
                visited    = $lastVisited
                window     = $meta
                snapshotId = $snapshot.snapshotId
                ref        = if ($null -ne $matchedNode) { [string]$matchedNode.ref } else { $null }
                node       = $matchedNode
            }
        }

        if ($elapsed -ge $TimeoutMs) {
            throw "TIMEOUT: 等待 ${TimeoutMs}ms 未满足条件（polls=$polls, visited=$lastVisited, 条件 text='$Text' role='$Role' id='$AutomationId' disappear=$Disappear, 窗口 '$($meta.title)'）"
        }

        Start-Sleep -Milliseconds $PollMs
    }
}

# ---------------------------------------------------------------------------
# CL-017: cross-request watch (no events required)
# ---------------------------------------------------------------------------
# 背景（实测记录）：.NET 的 UIA 事件在本机环境下不回调 —— STA 进程 + WinForms
# 消息泵 + C# 计数器委托都试过，10 秒内 hits 始终为 0（覆盖"桌面根作用域"与
# "窗口作用域 + 真实菜单弹出"两种触发）。因此这里不依赖事件，而是提供
# "arm 一次 + 反复 status" 的跨请求等待：不受单次请求 60s 上限约束，
# 每次 status 只做一次轻量扫描（命中早退，实测 ~86ms/窗口）。

$script:UiWatches = @{}
$script:UiWatchLimit = 32

# 轻量扫描（只读 ControlType/Name/AutomationId，命中即返回）：
# watch 每次 status 都调它，必须便宜；完整快照只在命中后做一次。
function Find-UiQuick {
    param($Root, [string]$Text, [string]$Role, [string]$AutomationId, [int]$MaxNodes, [int]$MaxDepth)

    $context = @{
        Text = $Text; Role = $Role; AutomationId = $AutomationId
        MaxNodes = $MaxNodes; MaxDepth = $MaxDepth
        Visited = 0; Truncated = $false
    }
    $found = Find-UiElementFast -Element $Root -Depth 0 -Context $context
    return [ordered]@{ element = $found; visited = $context.Visited }
}

function Remove-ExpiredUiWatches {
    $now = [DateTime]::UtcNow
    $expired = @()
    foreach ($key in $script:UiWatches.Keys) {
        if ($now -gt $script:UiWatches[$key].ExpiresAt) { $expired += $key }
    }
    foreach ($key in $expired) { $script:UiWatches.Remove($key) }
}

# 从命中元素向上找所属顶层窗口：快照要在这个窗口范围内做，
# 否则 -1（整个桌面）会把所有窗口的子树都走一遍——实测可超过 30 秒。
function Get-UiOwnerWindowHandle {
    param($Element)

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $cursor = $Element
    for ($i = 0; $i -lt 24; $i++) {
        $handle = 0
        try { $handle = [int64]$cursor.Current.NativeWindowHandle } catch { $handle = 0 }
        $role = 'generic'
        try { $role = ConvertTo-UiaRole $cursor.Current.ControlType } catch { $role = 'generic' }
        if ($role -eq 'window' -and $handle -ne 0) { return $handle }
        $parent = $null
        try { $parent = $walker.GetParent($cursor) } catch { $parent = $null }
        if ($null -eq $parent) {
            if ($handle -ne 0) { return $handle }
            return 0
        }
        $cursor = $parent
    }
    return 0
}

function Start-UiWatch {
    param(
        [int64]$Handle = 0,
        [string]$Text = '',
        [string]$Role = '',
        [string]$AutomationId = '',
        [bool]$Disappear = $false,
        [int]$MaxNodes = 400,
        [int]$MaxDepth = 8,
        [int]$TtlMinutes = 30
    )

    if ([string]::IsNullOrEmpty($Text) -and [string]::IsNullOrEmpty($Role) -and [string]::IsNullOrEmpty($AutomationId)) {
        throw 'INVALID_PARAMS: watch 至少需要一个条件（text / role / automationId）'
    }
    if ($TtlMinutes -lt 1) { $TtlMinutes = 1 }
    if ($TtlMinutes -gt 240) { $TtlMinutes = 240 }

    Initialize-Uia
    $root = Get-UiaWindowRoot -Handle $Handle
    $meta = Get-UiaWindowMeta -Root $root

    Remove-ExpiredUiWatches
    while ($script:UiWatches.Count -ge $script:UiWatchLimit) {
        $oldestKey = $null
        $oldestAt = [DateTime]::MaxValue
        foreach ($key in $script:UiWatches.Keys) {
            if ($script:UiWatches[$key].CreatedAt -lt $oldestAt) {
                $oldestAt = $script:UiWatches[$key].CreatedAt
                $oldestKey = $key
            }
        }
        if ($null -eq $oldestKey) { break }
        $script:UiWatches.Remove($oldestKey)
    }

    $watchId = [guid]::NewGuid().ToString()
    $script:UiWatches[$watchId] = @{
        Id           = $watchId
        Root         = $root
        Handle       = $Handle
        Meta         = $meta
        Text         = $Text
        Role         = $Role
        AutomationId = $AutomationId
        Disappear    = $Disappear
        MaxNodes     = $MaxNodes
        MaxDepth     = $MaxDepth
        CreatedAt    = [DateTime]::UtcNow
        ExpiresAt    = [DateTime]::UtcNow.AddMinutes($TtlMinutes)
        Checks       = 0
    }

    $probe = Find-UiQuick -Root $root -Text $Text -Role $Role -AutomationId $AutomationId -MaxNodes $MaxNodes -MaxDepth $MaxDepth
    $script:UiWatches[$watchId].Checks = 1
    $satisfied = if ($Disappear) { $null -eq $probe.element } else { $null -ne $probe.element }

    [ordered]@{
        watchId      = $watchId
        window       = $meta
        condition    = [ordered]@{ text = $Text; role = $Role; automationId = $AutomationId; disappear = $Disappear }
        alreadyMet   = $satisfied
        visited      = $probe.visited
        expiresAt    = $script:UiWatches[$watchId].ExpiresAt.ToString('o')
        nextStep     = '反复调用 desktop.ui.watch { action: "status", watchId } 直到 matched=true；用完 action: "cancel"'
    }
}

function Get-UiWatchStatus {
    param([Parameter(Mandatory)][string]$WatchId)

    $watch = $script:UiWatches[$WatchId]
    if ($null -eq $watch) {
        throw "INVALID_PARAMS: 未知 watchId '$WatchId'（可能已过期或被取消）"
    }
    if ([DateTime]::UtcNow -gt $watch.ExpiresAt) {
        $script:UiWatches.Remove($WatchId)
        throw "TIMEOUT: watch $WatchId 已过期（超过 TTL），请重新 arm"
    }

    $watch.Checks = $watch.Checks + 1
    $probe = Find-UiQuick -Root $watch.Root -Text $watch.Text -Role $watch.Role -AutomationId $watch.AutomationId -MaxNodes $watch.MaxNodes -MaxDepth $watch.MaxDepth
    $satisfied = if ($watch.Disappear) { $null -eq $probe.element } else { $null -ne $probe.element }
    $waitedMs = [int]([DateTime]::UtcNow - $watch.CreatedAt).TotalMilliseconds

    if (-not $satisfied) {
        return [ordered]@{
            watchId  = $WatchId
            matched  = $false
            waitedMs = $waitedMs
            checks   = $watch.Checks
            visited  = $probe.visited
            window   = $watch.Meta
        }
    }

    $script:UiWatches.Remove($WatchId)

    $result = [ordered]@{
        watchId   = $WatchId
        matched   = $true
        waitedMs  = $waitedMs
        checks    = $watch.Checks
        visited   = $probe.visited
        window    = $watch.Meta
        condition = if ($watch.Disappear) { 'disappear' } else { 'appear' }
    }

    if (-not $watch.Disappear -and $null -ne $probe.element) {
        # 优先在命中元素所属的窗口里做快照；watch 如果是 -1（桌面根），
        # 直接用桌面根会退化成"扫全桌面"，实测能超过 30 秒。
        $snapshotHandle = $watch.Handle
        if ($snapshotHandle -le 0) {
            $ownerHandle = Get-UiOwnerWindowHandle -Element $probe.element
            if ($ownerHandle -gt 0) { $snapshotHandle = $ownerHandle }
        }
        $snapshot = Get-UiTree -Handle $snapshotHandle -MaxDepth $watch.MaxDepth -MaxNodes ([Math]::Max($watch.MaxNodes, 600)) -EnableRendererSettle $false
        $matchedNode = $null
        foreach ($node in $snapshot.nodes) {
            if (Test-UiNodeMatch -Node $node -Text $watch.Text -Role $watch.Role -AutomationId $watch.AutomationId) {
                $matchedNode = $node
                break
            }
        }
        $result.snapshotId = $snapshot.snapshotId
        $result.ref = if ($null -ne $matchedNode) { [string]$matchedNode.ref } else { $null }
        $result.node = $matchedNode
    }

    return $result
}

function Stop-UiWatch {
    param([Parameter(Mandatory)][string]$WatchId)

    if (-not $script:UiWatches.ContainsKey($WatchId)) {
        return [ordered]@{ watchId = $WatchId; stopped = $false; reason = 'not found (already matched or expired)' }
    }
    $script:UiWatches.Remove($WatchId)
    [ordered]@{ watchId = $WatchId; stopped = $true }
}

function Get-UiWatchList {
    Remove-ExpiredUiWatches
    $items = New-Object System.Collections.ArrayList
    foreach ($key in $script:UiWatches.Keys) {
        $watch = $script:UiWatches[$key]
        [void]$items.Add([ordered]@{
            watchId      = $watch.Id
            window       = $watch.Meta
            text         = $watch.Text
            role         = $watch.Role
            automationId = $watch.AutomationId
            disappear    = $watch.Disappear
            checks       = $watch.Checks
            createdAt    = $watch.CreatedAt.ToString('o')
            expiresAt    = $watch.ExpiresAt.ToString('o')
        })
    }
    [ordered]@{ items = @($items.ToArray()); count = $items.Count }
}
