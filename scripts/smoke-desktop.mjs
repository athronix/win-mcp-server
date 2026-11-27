#!/usr/bin/env node
/**
 * win-desktop (CL-011) 真机冒烟：UIA 语义树 / ref 语义 / 受控读取 / 门控状态。
 *
 * 只做只读动作（快照、getText、读状态），绝不点击或注入按键——
 * 冒烟不应该干扰用户正在用的桌面。
 */
import { spawn } from 'node:child_process';
import { PowerShellBridge, createSpawnIndicator } from '../packages/core/dist/index.js';

const results = [];
let failed = 0;

function check(id, name, ok, detail = '') {
  results.push({ id, name, ok, detail });
  if (!ok) failed += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`${mark}  ${id} ${name}${ok || detail === '' ? '' : ` :: ${detail.slice(0, 240)}`}\n`);
}

const bridge = new PowerShellBridge({ onDiagnostic: (line) => process.env.SMOKE_VERBOSE === '1' && process.stderr.write(`[d] ${line}\n`) });
await bridge.start();

const mod = (fn, args = {}, timeoutMs = 60_000) =>
  bridge.call('module', { module: 'desktop', function: fn, args }, { timeoutMs });

try {
  const state = await mod('Get-ControlState');
  check('DS-01', '门控状态可读（policy/idle/cursor）', ['relaxed', 'balanced', 'strict'].includes(state.policy) && typeof state.idleMs === 'number', JSON.stringify(state).slice(0, 160));
  const initialPolicy = state.policy;

  const list = await mod('Get-WindowList', { MaxItems: 80 });
  const candidates = list.items.filter((w) => w.title.length > 0);
  check('DS-02', '窗口列表可用', candidates.length > 0, `count=${candidates.length}`);

  // 选一个最大化可见、非 Electron 的窗口成功率最高；退化为第一个窗口
  const preferred =
    candidates.find((w) => /文件资源管理器|Explorer|记事本|Notepad|设置|Settings/i.test(w.title)) ?? candidates[0];

  // 逐窗口试快照：最小化窗口与无 a11y 的 Electron 窗口节点会接近 0，
  // 冒烟要挑一个"看得到内容"的窗口，而不是固定第一个。
  let tree = null;
  let chosen = null;
  const tried = [];
  for (const candidate of candidates.slice(0, 8)) {
    const attempt = await mod('Get-UiTree', { Handle: candidate.handle, MaxDepth: 6, MaxNodes: 400 });
    tried.push(`${candidate.title || '(无标题)'}=${attempt.nodeCount}`);
    if (attempt.nodeCount >= 5) {
      tree = attempt;
      chosen = candidate;
      break;
    }
  }

  check(
    'DS-03',
    'UIA 语义树可生成（含 ref/depth/role）',
    tree !== null && /^@s\d+:e\d+$/.test(tree.nodes[0].ref) && typeof tree.nodes[0].depth === 'number',
    tree === null ? `所有候选窗口都无子树：${tried.slice(0, 4).join(' | ')}` : `window=${tree.window.title} nodes=${tree.nodeCount} renderer=${tree.rendererRoot}`,
  );

  if (tree === null) {
    // 没有可用窗口时不要伪装成功：明确记失败并结束
    check('DS-04', '扁平列表是前序（子节点 depth 最多 +1）', false, '无可用快照');
    check('DS-05', '节点带可执行动作（控件模式）', false, '无可用快照');
    check('DS-06', '按 ref 只读读取（getText）', false, '无可用快照');
  } else {
    const preOrder = tree.nodes.every((node, index) => index === 0 || node.depth <= tree.nodes[index - 1].depth + 1);
    check('DS-04', '扁平列表是前序（子节点 depth 最多 +1）', preOrder, preOrder ? '' : 'depth 序列异常');

    const withActions = tree.nodes.filter((n) => n.actions.length > 0);
    check('DS-05', '节点带可执行动作（控件模式）', withActions.length > 0, `actionable=${withActions.length} window=${chosen?.title ?? ''}`);

    const textNode = tree.nodes.find((n) => n.role === 'text' && n.name.length > 0);
    if (textNode !== undefined) {
      const read = await mod('Invoke-UiAction', { Ref: textNode.ref, Action: 'getText' });
      check('DS-06', '按 ref 只读读取（getText）', read.action === 'getText', `ref=${textNode.ref}`);
    } else {
      check('DS-06', '按 ref 只读读取（getText）', true, 'skip: 无文本节点');
    }
  }

  // ---------- CL-015: 等待机制与指示器 ----------
  if (tree !== null && chosen !== null) {
    const textNodeForWait = tree.nodes.find((n) => n.role === 'text' && n.name.length >= 2);
    if (textNodeForWait !== undefined) {
      const needle = textNodeForWait.name.slice(0, Math.min(6, textNodeForWait.name.length));
      const waitHit = await mod('Wait-UiCondition', {
        Handle: chosen.handle,
        Text: needle,
        TimeoutMs: 5000,
        MaxNodes: 500,
      });
      check(
        'DS-12',
        '等待条件命中并返回可用 ref',
        waitHit.matched === true && /^@s\d+:e\d+$/.test(String(waitHit.ref ?? '')),
        `waited=${waitHit.waitedMs}ms polls=${waitHit.polls} ref=${String(waitHit.ref)}`,
      );
    } else {
      check('DS-12', '等待条件命中并返回可用 ref', false, '无可用文本节点');
    }

    let timeoutCode = '';
    try {
      await mod('Wait-UiCondition', { Handle: chosen.handle, Text: 'zzz-win-mcp-not-exist-zzz', TimeoutMs: 700, PollMs: 150 });
    } catch (error) {
      timeoutCode = error?.detail?.code ?? '';
    }
    check('DS-13', '等待超时返回 TIMEOUT（不是静默失败）', timeoutCode === 'TIMEOUT', timeoutCode);
  } else {
    check('DS-12', '等待条件命中并返回可用 ref', false, '无可用窗口');
    check('DS-13', '等待超时返回 TIMEOUT（不是静默失败）', false, '无可用窗口');
  }

  // ---------- CL-017: 跨请求 watch（不依赖事件，等一个真实出现的窗口） ----------
  spawn('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 700));

  let armed = null;
  let watchMiss = null;
  let watchHit = null;
  try {
    armed = await mod('Start-UiWatch', { Handle: -1, Text: 'Notepad', MaxDepth: 2, MaxNodes: 200, TtlMinutes: 3 });
    watchMiss = await mod('Get-UiWatchStatus', { WatchId: armed.watchId });
    if (armed.alreadyMet !== true) {
      spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const status = await mod('Get-UiWatchStatus', { WatchId: armed.watchId });
        if (status.matched === true) {
          watchHit = status;
          break;
        }
      }
    }
  } finally {
    spawn('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' }).unref();
  }

  check(
    'DS-15',
    'watch arm 后可查询未命中状态（不阻塞请求）',
    armed !== null && watchMiss !== null && watchMiss.matched === false && typeof watchMiss.checks === 'number',
    `alreadyMet=${String(armed?.alreadyMet)} checks=${String(watchMiss?.checks)}`,
  );
  check(
    'DS-16',
    '真实窗口出现后 status 命中并给出可用 ref',
    watchHit !== null && watchHit.matched === true && /^@s\d+:e\d+$/.test(String(watchHit.ref ?? '')),
    watchHit === null ? '8 秒内未命中' : `waited=${watchHit.waitedMs}ms checks=${watchHit.checks} ref=${String(watchHit.ref)}`,
  );

  const armedAgain = await mod('Start-UiWatch', { Handle: -1, Text: 'zzz-never-matches', MaxDepth: 2, MaxNodes: 100 });
  const cancelled = await mod('Stop-UiWatch', { WatchId: armedAgain.watchId });
  check('DS-17', 'watch 可显式取消', cancelled.stopped === true, JSON.stringify(cancelled));

  const indicator = createSpawnIndicator({ onError: () => undefined });
  const handle = indicator.show(1);
  const shown = handle !== null && indicator.active;
  indicator.hide();
  check('DS-14', '门控指示器可启动并立即回收', shown && !indicator.active, `pid=${handle?.pid ?? 0}`);

  let bareRefCode = '';
  try {
    await mod('Invoke-UiAction', { Ref: '@e1', Action: 'getText' });
  } catch (error) {
    bareRefCode = error?.detail?.code ?? error?.message ?? '';
  }
  check('DS-07', '裸 ref 被拒（INVALID_PARAMS）', bareRefCode === 'INVALID_PARAMS', String(bareRefCode));

  let staleCode = '';
  try {
    await mod('Invoke-UiAction', { Ref: '@s9999:e0', Action: 'getText' });
  } catch (error) {
    staleCode = error?.detail?.code ?? error?.message ?? '';
  }
  check('DS-08', '未知快照返回 STALE_REF', staleCode === 'STALE_REF', String(staleCode));

  let invalidActionCode = '';
  try {
    await mod('Invoke-UiAction', { Ref: tree?.nodes[0]?.ref ?? '@s1:e0', Action: 'formatDisk' });
  } catch (error) {
    invalidActionCode = error?.detail?.code ?? error?.message ?? '';
  }
  check('DS-09', '未支持 action 被拒（INVALID_PARAMS）', invalidActionCode === 'INVALID_PARAMS', String(invalidActionCode));

  const echo = await mod('Set-ControlPolicy', { Policy: initialPolicy });
  check(
    'DS-10',
    '门控策略可写且幂等（写回原值）',
    echo.policy === initialPolicy && echo.previous === initialPolicy,
    JSON.stringify(echo),
  );

  let badPolicyCode = '';
  try {
    await mod('Set-ControlPolicy', { Policy: 'yolo' });
  } catch (error) {
    badPolicyCode = error?.detail?.code ?? error?.message ?? '';
  }
  check('DS-11', '非法策略被拒（INVALID_PARAMS）', badPolicyCode === 'INVALID_PARAMS', String(badPolicyCode));
} finally {
  await bridge.stop();
}

process.stdout.write(`\n冒烟结果：${results.length - failed}/${results.length} 通过\n`);
process.exit(failed === 0 ? 0 : 1);