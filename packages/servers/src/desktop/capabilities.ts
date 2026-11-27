import { z } from 'zod';
import {
  DesktopControlGate,
  ToolFailure,
  createBridgeControlIo,
  createSpawnConsentRunner,
  createSpawnIndicator,
  remoteErrorToToolError,
  type CapabilitySpec,
  type PowerShellBridge,
} from '@win-mcp/core';

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function consentSeconds(): number {
  const raw = process.env['WIN_MCP_DESKTOP_CONSENT_SECONDS'];
  if (raw === undefined) return 10;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 60 ? parsed : 10;
}

/** 把桥的领域错误还原成带错误码的 ToolFailure（否则审批闸只能看到 INTERNAL） */
export function guard<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error: unknown) => {
    throw ToolFailure.from(remoteErrorToToolError(error));
  });
}

/**
 * win-desktop：截图、窗口、剪贴板 + UIA 语义树 + 受控输入 + 桌面门控
 *
 * 门控按 CursorTouch 的三档策略表判定；未登记的能力按 direct 处理（fail closed）。
 * 门控在 handler 内执行，因此只在审批通过后才征求桌面控制同意。
 */
export function desktopCapabilities(bridge: PowerShellBridge): CapabilitySpec[] {
  const call = <T>(fn: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    bridge.call<T>('module', { module: 'desktop', function: fn, args }, timeoutMs !== undefined ? { timeoutMs } : {});

  const gate = new DesktopControlGate({
    io: createBridgeControlIo(bridge),
    consent: createSpawnConsentRunner(),
    indicator: createSpawnIndicator({
      onError: (message) => process.stderr.write(`[win-desktop][indicator] ${message}\n`),
    }),
    consentSeconds: consentSeconds(),
    onEvent: (event, detail) => {
      process.stderr.write(`[win-desktop][control] ${event} ${JSON.stringify(detail)}\n`);
    },
  });

  return [
    {
      id: 'desktop.screen.capture',
      name: '截屏',
      description:
        '截取所有显示器（虚拟屏幕）并保存为 PNG 到 %TEMP%，返回文件路径与尺寸；maxWidth 可按宽度等比缩小（只读 L0）。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 30_000,
      inputSchema: {
        maxWidth: z.number().int().min(320).max(7680).optional().describe('按宽度等比缩放，省略则原尺寸'),
      },
      async handler(params) {
        return {
          data: await guard(call('Get-ScreenCapture', { MaxWidth: num(params.maxWidth, 0) })),
        };
      },
    },
    {
      id: 'desktop.window.list',
      name: '窗口列表',
      description: '列出可见且有标题的顶层窗口（句柄/标题/进程名），支持标题模糊过滤（只读 L0）。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 20_000,
      inputSchema: {
        filter: z.string().optional().describe('按窗口标题模糊过滤'),
        maxItems: z.number().int().min(1).max(500).optional().describe('最多返回条数，默认 100'),
      },
      async handler(params) {
        return {
          data: await guard(
            call('Get-WindowList', {
              Filter: str(params.filter),
              MaxItems: num(params.maxItems, 100),
            }),
          ),
        };
      },
    },
    {
      id: 'desktop.window.control',
      name: '窗口控制',
      description:
        '对指定窗口执行 minimize/maximize/restore/activate/close（L2，需审批）。handle 来自 desktop.window.list。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 20_000,
      inputSchema: {
        handle: z.number().int().describe('窗口句柄（来自 desktop.window.list）'),
        action: z
          .enum(['minimize', 'maximize', 'restore', 'activate', 'close'])
          .describe('窗口操作'),
      },
      async handler(params) {
        return {
          data: await guard(
            call('Set-WindowState', {
              Handle: num(params.handle, 0),
              Action: str(params.action),
            }),
          ),
        };
      },
    },
    {
      id: 'desktop.clipboard.get',
      name: '读剪贴板',
      description: '读取剪贴板文本（只读 L0）。非文本内容返回空字符串。',
      risk: 'L0',
      idempotent: true,
      inputSchema: {},
      async handler() {
        return { data: await guard(call('Get-ClipboardContent')) };
      },
    },
    {
      id: 'desktop.clipboard.set',
      name: '写剪贴板',
      description: '写入剪贴板文本（L1，用户域可逆写）。会覆盖用户当前剪贴板内容。',
      risk: 'L1',
      inputSchema: {
        text: z.string().describe('要写入的文本（可为空字符串以清空）'),
      },
      async handler(params) {
        return { data: await guard(call('Set-ClipboardContent', { Text: str(params.text) })) };
      },
    },

    // ---------------- CL-011: UIA 语义树 / 受控输入 / 桌面门控 ----------------
    {
      id: 'desktop.ui.snapshot',
      name: 'UIA 语义树快照',
      description:
        '读取窗口的无障碍语义树（UIA），返回带 ref 的扁平节点列表（depth 表示层级）。ref 形如 @s3:e12，只在本次快照内有效。' +
        '这是桌面自动化的第一步：先快照 → 再按 ref 操作 → UI 变化后重新快照。只读 L0。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 30_000,
      inputSchema: {
        handle: z.number().int().optional().describe('窗口句柄，省略则取前台窗口'),
        maxDepth: z.number().int().min(1).max(20).optional().describe('最大深度，默认 8'),
        maxNodes: z.number().int().min(20).max(3000).optional().describe('最大节点数，默认 600'),
        includeOffscreen: z.boolean().optional().describe('是否包含屏幕外元素，默认 false'),
        filter: z.string().optional().describe('按元素名称过滤（保留路径上的容器）'),
      },
      async handler(params) {
        return {
          data: await guard(
            call('Get-UiTree', {
              Handle: num(params.handle, 0),
              MaxDepth: num(params.maxDepth, 8),
              MaxNodes: num(params.maxNodes, 600),
              IncludeOffscreen: bool(params.includeOffscreen, false),
              Filter: str(params.filter),
            }),
          ),
        };
      },
    },
    {
      id: 'desktop.ui.act',
      name: '按 ref 操作元素',
      description:
        '对快照里的 ref 执行 click/doubleClick/rightClick/setValue/focus/toggle/expand/collapse/select/scrollIntoView/getText。' +
        '优先用 UIA 控件模式（invoke/toggle/value 等），无模式时才回退鼠标。L2 需审批；受桌面门控约束。' +
        '返回 via 说明用了哪种路径，resolved 说明 ref 是活体命中还是重新识别。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 30_000,
      inputSchema: {
        ref: z.string().describe('元素 ref（@s<snapshot>:e<N>，来自 desktop.ui.snapshot）'),
        action: z
          .enum([
            'click',
            'doubleClick',
            'rightClick',
            'setValue',
            'focus',
            'toggle',
            'expand',
            'collapse',
            'select',
            'scrollIntoView',
            'getText',
          ])
          .describe('操作类型'),
        text: z.string().optional().describe('setValue 时要写入的文本'),
        allowMouseFallback: z
          .boolean()
          .optional()
          .describe('无控件模式时是否允许回退到物理鼠标点击，默认 true；设为 false 则严格语义操作'),
      },
      async handler(params) {
        const args = { ref: str(params.ref), action: str(params.action) };
        const { result, probe } = await gate.run('desktop.ui.act', args, async () =>
          guard(
            call('Invoke-UiAction', {
              Ref: args.ref,
              Action: args.action,
              Text: str(params.text),
              AllowMouseFallback: bool(params.allowMouseFallback, true),
            }),
          ),
        );
        return {
          data: { ...(result as Record<string, unknown>), control: probe },
          warnings: probe.consent === 'timeout' ? ['同意倒计时无应答，已按策略自动放行'] : [],
        };
      },
    },
    {
      id: 'desktop.input.send',
      name: '键盘鼠标注入',
      description:
        '发送按键组合（press，如 Ctrl+Shift+Esc）、文本（type，Unicode 直送，不受输入法影响）、' +
        '鼠标点击/移动/滚轮/拖拽。L2 需审批；受桌面门控约束。' +
        '注意：坐标是物理像素（已按 DPI 感知校正）；press 的组合键受限，Win+L 等系统锁屏键会立即中断会话。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 30_000,
      inputSchema: {
        action: z.enum(['press', 'type', 'click', 'move', 'scroll', 'drag']).describe('输入类型'),
        chord: z.string().optional().describe('press 的组合键，如 Ctrl+A / Alt+F4 / Ctrl+Shift+Esc'),
        text: z.string().optional().describe('type 要输入的文本'),
        x: z.number().int().optional().describe('屏幕 X 坐标（物理像素）'),
        y: z.number().int().optional().describe('屏幕 Y 坐标（物理像素）'),
        toX: z.number().int().optional().describe('drag 终点 X'),
        toY: z.number().int().optional().describe('drag 终点 Y'),
        button: z.enum(['left', 'right', 'middle']).optional().describe('鼠标键，默认 left'),
        count: z.number().int().min(1).max(3).optional().describe('点击次数，默认 1'),
        delta: z.number().int().optional().describe('滚轮增量，正数向上，一格 120'),
      },
      async handler(params) {
        const args = { action: str(params.action) };
        const { result, probe } = await gate.run('desktop.input.send', args, async () =>
          guard(
            call('Send-UiInput', {
              Action: args.action,
              Chord: str(params.chord),
              Text: str(params.text),
              X: num(params.x, -1),
              Y: num(params.y, -1),
              ToX: num(params.toX, -1),
              ToY: num(params.toY, -1),
              Button: str(params.button, 'left'),
              Count: num(params.count, 1),
              Delta: num(params.delta, 0),
            }),
          ),
        );
        return {
          data: { ...(result as Record<string, unknown>), control: probe },
          warnings: probe.consent === 'timeout' ? ['同意倒计时无应答，已按策略自动放行'] : [],
        };
      },
    },
    {
      id: 'desktop.ui.wait',
      name: '等待 UI 条件',
      description:
        '在服务端等待某个元素出现/消失（L0，只读）。条件：text（名称包含）/ role / automationId，可组合。' +
        '命中时返回匹配节点的 ref 与所在快照 id，可直接用于 desktop.ui.act；超时抛 TIMEOUT。' +
        '比调用方反复快照便宜得多——一次调用完成等待，只回传一个节点。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 70_000,
      inputSchema: {
        handle: z.number().int().optional().describe('窗口句柄，省略则取前台窗口'),
        text: z.string().optional().describe('元素名称包含该字符串（不区分大小写）'),
        role: z.string().optional().describe('角色精确匹配，如 button / textbox'),
        automationId: z.string().optional().describe('AutomationId 精确匹配'),
        disappear: z.boolean().optional().describe('true 表示等待该条件消失，默认 false'),
        timeoutMs: z.number().int().min(100).max(60000).optional().describe('最长等待，默认 10000'),
        pollMs: z.number().int().min(100).max(5000).optional().describe('轮询间隔，默认 250'),
        maxNodes: z.number().int().min(20).max(1500).optional().describe('每轮最多遍历节点，默认 400'),
        maxDepth: z.number().int().min(1).max(20).optional().describe('每轮最大深度，默认 8'),
      },
      async handler(params) {
        return {
          data: await guard(
            call(
              'Wait-UiCondition',
              {
                Handle: num(params.handle, 0),
                Text: str(params.text),
                Role: str(params.role),
                AutomationId: str(params.automationId),
                Disappear: bool(params.disappear, false),
                TimeoutMs: num(params.timeoutMs, 10_000),
                PollMs: num(params.pollMs, 250),
                MaxNodes: num(params.maxNodes, 400),
                MaxDepth: num(params.maxDepth, 8),
              },
              num(params.timeoutMs, 10_000) + 10_000,
            ),
          ),
        };
      },
    },
    {
      id: 'desktop.ui.watch',
      name: '跨请求等待（arm/status）',
      description:
        '先 arm 一次记住条件，之后反复 status 查询——不受单次请求 60 秒上限约束，适合等下载/编译/长任务（L0 只读）。' +
        '每次 status 只做一次轻量扫描（命中早退），mat条件满足时自动移除并返回可用 ref。' +
        '注意：handle=-1 表示整个桌面，扫描量远大于单窗口，能给出具体窗口句柄就别用 -1。' +
        '（本机实测 .NET UIA 事件回调不触发，所以这里是"按需重查"而非事件推送，但语义与事件订阅等效且不会卡死。）',
      risk: 'L0',
      timeoutMs: 60_000,
      inputSchema: {
        action: z.enum(['arm', 'status', 'cancel', 'list']).describe('arm 建立 / status 查询 / cancel 取消 / list 列出'),
        watchId: z.string().optional().describe('status/cancel 必填（arm 返回）'),
        handle: z.number().int().optional().describe('窗口句柄，省略=前台窗口，-1=整个桌面（昂贵）'),
        text: z.string().optional().describe('元素名称包含该字符串'),
        role: z.string().optional().describe('角色精确匹配，如 window / button'),
        automationId: z.string().optional().describe('AutomationId 精确匹配'),
        disappear: z.boolean().optional().describe('true 表示等条件消失'),
        maxNodes: z.number().int().min(20).max(3000).optional().describe('每轮扫描上限，默认 400'),
        maxDepth: z.number().int().min(1).max(20).optional().describe('每轮最大深度，默认 8'),
        ttlMinutes: z.number().int().min(1).max(240).optional().describe('watch 存活时长，默认 30 分钟'),
      },
      async handler(params) {
        const action = str(params.action, 'status');
        if (action === 'list') {
          return { data: await guard(call('Get-UiWatchList')) };
        }
        if (action === 'cancel') {
          return { data: await guard(call('Stop-UiWatch', { WatchId: str(params.watchId) })) };
        }
        if (action === 'status') {
          const watchId = str(params.watchId);
          if (watchId.length === 0) {
            throw new ToolFailure('INVALID_PARAMS', 'action=status 需要 watchId（来自 arm 的返回值）');
          }
          return { data: await guard(call('Get-UiWatchStatus', { WatchId: watchId })) };
        }

        // arm
        const armed = await guard(
          call('Start-UiWatch', {
            Handle: num(params.handle, 0),
            Text: str(params.text),
            Role: str(params.role),
            AutomationId: str(params.automationId),
            Disappear: bool(params.disappear, false),
            MaxNodes: num(params.maxNodes, 400),
            MaxDepth: num(params.maxDepth, 8),
            TtlMinutes: num(params.ttlMinutes, 30),
          }),
        );
        const armedData = armed as { alreadyMet?: boolean; watchId?: string };
        return {
          data: armedData,
          ...(armedData.alreadyMet === true
            ? { warnings: ['条件在 arm 时就已满足：直接调 action=status 取 ref，或改用 desktop.ui.wait'] }
            : {}),
        };
      },
    },
    {
      id: 'desktop.control.state',
      name: '桌面控制状态',
      description:
        '读取当前桌面门控策略、租约剩余时间、空闲毫秒、前台窗口与光标位置（只读 L0，永不需要门控）。',
      risk: 'L0',
      idempotent: true,
      inputSchema: {},
      async handler() {
        return {
          data: { control: await gate.status(), desktop: await guard(call('Get-ControlState')) },
        };
      },
    },
    {
      id: 'desktop.control.policy',
      name: '设置桌面门控策略',
      description:
        '调整桌面门控三档策略：relaxed（仅直接输入需授权）/ balanced（直接输入+可能干扰）/ strict（几乎全部需授权）。' +
        '放权会显著提高 AI 静默干扰用户的风险，因此固定 L3 强制人工审批（不受 autoApprove 影响）。',
      risk: 'L3',
      destructive: true,
      inputSchema: {
        policy: z.enum(['relaxed', 'balanced', 'strict']).describe('目标策略'),
      },
      async handler(params) {
        const policy = str(params.policy, 'balanced');
        const normalized = policy === 'relaxed' || policy === 'strict' ? policy : 'balanced';
        return { data: { control: await gate.setPolicy(normalized) } };
      },
    },
  ];
}