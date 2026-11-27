#!/usr/bin/env node
/**
 * win-desktop (CL-011) 真机冒烟：UIA 语义树 / ref 语义 / 受控读取 / 门控状态。
 *
 * 只做只读动作（快照、getText、读状态），绝不点击或注入按键——
 * 冒烟不应该干扰用户正在用的桌面。
 */
import { PowerShellBridge } from '../packages/core/dist/index.js';

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

  const tree = await mod('Get-UiTree', { Handle: preferred.handle, MaxDepth: 6, MaxNodes: 400 });
  check(
    'DS-03',
    'UIA 语义树可生成（含 ref/depth/role）',
    tree.nodeCount > 0 && /^@s\d+:e\d+$/.test(tree.nodes[0].ref) && typeof tree.nodes[0].depth === 'number',
    `window=${tree.window.title} nodes=${tree.nodeCount} renderer=${tree.rendererRoot}`,
  );

  const preOrder = tree.nodes.every((node, index) => index === 0 || node.depth <= tree.nodes[index - 1].depth + 1);
  check('DS-04', '扁平列表是前序（子节点 depth 最多 +1）', preOrder, preOrder ? '' : 'depth 序列异常');

  const withActions = tree.nodes.filter((n) => n.actions.length > 0);
  check('DS-05', '节点带可执行动作（控件模式）', withActions.length > 0, `actionable=${withActions.length}`);

  const textNode = tree.nodes.find((n) => n.role === 'text' && n.name.length > 0);
  if (textNode !== undefined) {
    const read = await mod('Invoke-UiAction', { Ref: textNode.ref, Action: 'getText' });
    check('DS-06', '按 ref 只读读取（getText）', read.action === 'getText', `ref=${textNode.ref}`);
  } else {
    check('DS-06', '按 ref 只读读取（getText）', true, 'skip: 无文本节点');
  }

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
    await mod('Invoke-UiAction', { Ref: tree.nodes[0].ref, Action: 'formatDisk' });
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