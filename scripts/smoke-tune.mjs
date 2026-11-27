#!/usr/bin/env node
/**
 * CL-014 真机冒烟：调优目录 / 快照 / 应用 / 一键回滚。
 *
 * 只挑 HKCU 下的 explorer.menu-delay（用户级、可逆），执行后立刻回滚，
 * 并用目录的 currentValue 复核确实回到原值。
 */
import { writeSync } from 'node:fs';
import { PowerShellBridge } from '../packages/core/dist/index.js';
import { resourceCapabilities } from '../packages/servers/dist/resource/capabilities.js';

const results = [];
let failed = 0;
const log = (m) => writeSync(1, `${m}\n`);

function check(id, name, ok, detail = '') {
  results.push({ id, name, ok });
  if (!ok) failed += 1;
  log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${ok || detail === '' ? '' : ` :: ${String(detail).slice(0, 220)}`}`);
}

const bridge = new PowerShellBridge({ onDiagnostic: () => undefined });
await bridge.start();
const specs = resourceCapabilities(bridge);
const handlerOf = (id) => {
  const spec = specs.find((item) => item.id === id);
  if (spec?.handler === undefined) throw new Error(`缺少能力 ${id}`);
  return spec.handler;
};
const L = (risk) => ({ traceId: 'smoke-tune', risk });

const KEY = 'explorer.menu-delay';
let originalValue = '';

try {
  const catalog = await handlerOf('resource.tune.catalog')({}, L('L0'));
  const item = catalog.data.items.find((entry) => entry.key === KEY);
  originalValue = String(item?.currentValue ?? '');
  check(
    'TN-01',
    '目录可读且给出当前值与提权状态',
    catalog.data.count >= 4 && typeof catalog.data.elevated === 'boolean' && item !== undefined,
    `count=${catalog.data.count} elevated=${catalog.data.elevated} current=${originalValue}`,
  );

  const planned = await handlerOf('resource.tune.plan')({ keys: [KEY] }, L('L1'));
  const plan = planned.data.plan;
  check(
    'TN-02',
    '计划建立快照并绑定 planId',
    plan.status === 'ready' && plan.snapshotId.length > 8 && typeof planned.data.planId === 'string',
    `status=${plan.status} snapshot=${String(plan.snapshotId).slice(0, 8)}…`,
  );

  const applied = await handlerOf('resource.tune.apply')(
    { planId: planned.data.planId, keys: [KEY], confirm: true },
    L('L2'),
  );
  const afterApply = await handlerOf('resource.tune.catalog')({}, L('L0'));
  const afterValue = String(afterApply.data.items.find((entry) => entry.key === KEY)?.currentValue ?? '');
  check(
    'TN-03',
    '应用后值变为目标值，且记录 before/after',
    applied.data.appliedCount === 1 && afterValue === '0' && String(applied.data.applied[0]?.previousValue) === originalValue,
    `after=${afterValue} previous=${String(applied.data.applied[0]?.previousValue)} expectOriginal=${originalValue}`,
  );

  const rolled = await handlerOf('resource.tune.rollback')({ snapshotId: plan.snapshotId }, L('L2'));
  const afterRollback = await handlerOf('resource.tune.catalog')({}, L('L0'));
  const restoredValue = String(afterRollback.data.items.find((entry) => entry.key === KEY)?.currentValue ?? '');
  check(
    'TN-04',
    '一键回滚恢复原值',
    rolled.data.restoredCount === 1 && restoredValue === originalValue,
    `restored=${restoredValue} expect=${originalValue} action=${String(rolled.data.restored[0]?.action)}`,
  );

  const blocked = await handlerOf('resource.tune.plan')({ keys: ['system.network-throttling'] }, L('L1'));
  check(
    'TN-05',
    '需要管理员但未提权 → blocked（不静默跳过）',
    blocked.data.plan.status === 'blocked' && blocked.data.plan.blockers[0].includes('管理员'),
    blocked.data.plan.blockers.join('；'),
  );

  const unknown = await handlerOf('resource.tune.plan')({ keys: ['hack.anything'] }, L('L1'));
  check(
    'TN-06',
    '目录外 key → blocked（白名单，无任意写入）',
    unknown.data.plan.status === 'blocked' && unknown.data.plan.blockers[0].includes('未知 key'),
    unknown.data.plan.blockers.join('；'),
  );

  let pathCode = '';
  try {
    await handlerOf('resource.tune.rollback')({ snapshotId: 'C:\\Windows\\win.ini' }, L('L2'));
  } catch (error) {
    pathCode = error?.toolError?.code ?? '';
  }
  check('TN-07', '回滚只接受 GUID（路径注入被拒）', pathCode === 'INVALID_PARAMS', pathCode);

  const blockedApply = await handlerOf('resource.tune.plan')({ keys: ['system.network-throttling'] }, L('L1'));
  let blockedCode = '';
  try {
    await handlerOf('resource.tune.apply')(
      { planId: blockedApply.data.planId, keys: ['system.network-throttling'], confirm: true },
      L('L2'),
    );
  } catch (error) {
    blockedCode = error?.toolError?.code ?? '';
  }
  check('TN-08', 'blocked 计划执行 → PLAN_BLOCKED', blockedCode === 'PLAN_BLOCKED', blockedCode);

  const snapshots = await handlerOf('resource.tune.snapshots')({ maxItems: 5 }, L('L0'));
  check(
    'TN-09',
    '快照列表可读，且首次基线 latest 已写入',
    snapshots.data.count >= 1 && snapshots.data.latest !== null,
    `count=${snapshots.data.count} latest=${String(snapshots.data.latest?.snapshotId).slice(0, 8)}…`,
  );

  let mismatchCode = '';
  const planned2 = await handlerOf('resource.tune.plan')({ keys: [KEY] }, L('L1'));
  try {
    await handlerOf('resource.tune.apply')(
      { planId: planned2.data.planId, keys: ['explorer.visual-effects'], confirm: true },
      L('L2'),
    );
  } catch (error) {
    mismatchCode = error?.toolError?.code ?? '';
  }
  check('TN-10', 'keys 与预览不一致 → PLAN_MISMATCH', mismatchCode === 'PLAN_MISMATCH', mismatchCode);
} catch (error) {
  check('XX-00', '冒烟未抛异常', false, error instanceof Error ? error.message : String(error));
} finally {
  await bridge.stop();
}

log(`\n调优/回滚冒烟结果：${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);