import { PowerShellBridge } from '../packages/core/dist/index.js';

const bridge = new PowerShellBridge({ onDiagnostic: (l) => process.stderr.write(`[d] ${l}\n`) });
await bridge.start();

const mod = (fn, args = {}) =>
  bridge.call('module', { module: 'desktop', function: fn, args }, { timeoutMs: 60000 });

try {
  const state = await mod('Get-ControlState');
  console.log('control-state:', JSON.stringify(state));

  const tree = await mod('Get-UiTree', { Handle: 0, MaxDepth: 6, MaxNodes: 120 });
  console.log('snapshotId:', tree.snapshotId, 'window:', JSON.stringify(tree.window), 'nodes:', tree.nodeCount, 'truncated:', tree.truncated);
  for (const n of tree.nodes.slice(0, 18)) {
    console.log(`  ${n.ref} d${n.depth} ${n.role} "${n.name}" actions=[${n.actions.join(',')}] states=[${n.states.join(',')}]`);
  }

  const focusable = tree.nodes.find((n) => n.actions.includes('setValue') || n.actions.includes('click'));
  if (focusable) {
    const r = await mod('Invoke-UiAction', { Ref: focusable.ref, Action: 'focus', AllowMouseFallback: false });
    console.log('focus result:', JSON.stringify(r));
  } else {
    console.log('no actionable node found in sample');
  }

  // 故意用裸 ref 与过期快照，验证错误码透传
  for (const bad of ['@e3', '@s999:e1']) {
    try {
      await mod('Invoke-UiAction', { Ref: bad, Action: 'focus' });
      console.log(`unexpected ok for ${bad}`);
    } catch (e) {
      console.log(`expected failure ${bad}: code=${e.code} msg=${e.message.slice(0, 120)}`);
    }
  }
} finally {
  await bridge.stop();
}