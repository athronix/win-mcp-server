#!/usr/bin/env node
/**
 * CL-013 真机冒烟：planId 三分支（真实 winget）+ backupId 回滚（真实注册表写入再还原）。
 *
 * 设计原则：
 * - winget 只跑 plan，不执行安装（PLAN 走的是只读 list）
 * - 注册表只写 HKCU 下的临时键，结束后回滚并删除
 * - 用能力 handler 直接调用，验证的是"能力面"而不是底层函数
 */
import { writeSync } from 'node:fs';
import { PowerShellBridge } from '../packages/core/dist/index.js';
import { appsCapabilities } from '../packages/servers/dist/apps/capabilities.js';
import { systemCapabilities } from '../packages/servers/dist/system/capabilities.js';

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

const ctx = (risk) => ({ traceId: 'smoke-plan', risk });

function handlerOf(specs, id) {
  const spec = specs.find((item) => item.id === id);
  if (spec?.handler === undefined) throw new Error(`缺少能力 ${id}`);
  return spec.handler;
}

const apps = appsCapabilities(bridge);
const system = systemCapabilities(bridge);

const ABSENT_ID = 'WinMcp.SmokeDefinitelyNotInstalled';
const TEST_KEY = 'HKCU:\\Software\\WinMcpSmokeTest';
const TEST_NAME = 'Probe';

try {
  // ---------- planId 三分支 ----------
  const noChangePlan = await handlerOf(apps, 'apps.winget.plan')(
    { operation: 'uninstall', ids: [ABSENT_ID] },
    ctx('L1'),
  );
  const plan1 = noChangePlan.data.plan;
  check(
    'PL-01',
    '未安装 + uninstall → no-changes',
    plan1.status === 'no-changes' && noChangePlan.data.planId.length > 8,
    `status=${plan1.status} planId=${noChangePlan.data.planId.slice(0, 8)}…`,
  );

  const applyNoChange = await handlerOf(apps, 'apps.winget.apply')(
    { planId: noChangePlan.data.planId, operation: 'uninstall', ids: [ABSENT_ID], confirm: true },
    ctx('L2'),
  );
  check('PL-02', 'no-changes 计划执行 → 零动作', applyNoChange.data.executed === 0 && applyNoChange.data.status === 'no-changes', JSON.stringify(applyNoChange.data.status));

  let reuseCode = '';
  try {
    await handlerOf(apps, 'apps.winget.apply')(
      { planId: noChangePlan.data.planId, operation: 'uninstall', ids: [ABSENT_ID], confirm: true },
      ctx('L2'),
    );
  } catch (error) {
    reuseCode = error?.toolError?.code ?? '';
  }
  check('PL-03', 'planId 一次性（复用 → PLAN_NOT_FOUND）', reuseCode === 'PLAN_NOT_FOUND', reuseCode);

  const blockedPlan = await handlerOf(apps, 'apps.winget.plan')(
    { operation: 'install', ids: ['Visual Studio Code'] },
    ctx('L1'),
  );
  check(
    'PL-04',
    '显示名（含空格）→ blocked 且给出原因',
    blockedPlan.data.plan.status === 'blocked' && blockedPlan.data.plan.blockers.length > 0,
    blockedPlan.data.plan.blockers.join('；'),
  );

  let blockedCode = '';
  try {
    await handlerOf(apps, 'apps.winget.apply')(
      { planId: blockedPlan.data.planId, operation: 'install', ids: ['Visual Studio Code'], confirm: true },
      ctx('L2'),
    );
  } catch (error) {
    blockedCode = error?.toolError?.code ?? '';
  }
  check('PL-05', 'blocked 计划执行 → PLAN_BLOCKED（不执行任何项）', blockedCode === 'PLAN_BLOCKED', blockedCode);

  const readyPlan = await handlerOf(apps, 'apps.winget.plan')(
    { operation: 'install', ids: [ABSENT_ID] },
    ctx('L1'),
  );
  check(
    'PL-06',
    '未安装 + install → ready（带 unverified 提示）',
    readyPlan.data.plan.status === 'ready' && readyPlan.data.plan.changes.length === 1,
    `status=${readyPlan.data.plan.status} unverified=${readyPlan.data.plan.unverified.length}`,
  );

  let mismatchCode = '';
  try {
    await handlerOf(apps, 'apps.winget.apply')(
      { planId: readyPlan.data.planId, operation: 'install', ids: [ABSENT_ID, 'Other.Package'], confirm: true },
      ctx('L2'),
    );
  } catch (error) {
    mismatchCode = error?.toolError?.code ?? '';
  }
  check('PL-07', '参数与预览不一致 → PLAN_MISMATCH', mismatchCode === 'PLAN_MISMATCH', mismatchCode);

  // ---------- 已装检测：精确模式 ----------
  const state = await bridge.call('module', {
    module: 'apps',
    function: 'Get-WingetInstalledState',
    args: { IdsJson: JSON.stringify([ABSENT_ID]), Mode: 'exact' },
  });
  check(
    'PL-08',
    '已装检测走 winget list --id 精确模式',
    state.source === 'winget-list-exact' && state.packages[0]?.installed === false,
    `source=${String(state.source)} installed=${String(state.packages[0]?.installed)} exitCode=${String(state.packages[0]?.exitCode)}`,
  );

  const bulk = await bridge.call('module', {
    module: 'apps',
    function: 'Get-WingetInstalledState',
    args: { IdsJson: JSON.stringify([ABSENT_ID]), Mode: 'bulk' },
  });
  check('PL-09', 'bulk 模式仍可用（作为降级路径）', bulk.source === 'winget-list-substring', String(bulk.source));

  // ---------- backupId 回滚 ----------
  const write1 = await handlerOf(system, 'system.registry.write')(
    { path: TEST_KEY, name: TEST_NAME, value: 'v1', type: 'String' },
    ctx('L2'),
  );
  const backupId1 = write1.data.backupId;
  check(
    'BK-01',
    '写入自动生成 backupId（原值不存在）',
    typeof backupId1 === 'string' && write1.data.previousExists === false,
    `backupId=${String(backupId1).slice(0, 8)}… previousExists=${write1.data.previousExists}`,
  );

  const write2 = await handlerOf(system, 'system.registry.write')(
    { path: TEST_KEY, name: TEST_NAME, value: 'v2', type: 'String' },
    ctx('L2'),
  );
  check('BK-02', '覆盖写入记录 previousExists=true', write2.data.previousExists === true, String(write2.data.previousExists));

  const restore2 = await handlerOf(system, 'system.backup.restore')({ backupId: write2.data.backupId }, ctx('L2'));
  const afterRestore2 = await bridge.call('module', {
    module: 'system',
    function: 'Get-RegistryValue',
    args: { Path: TEST_KEY, Name: TEST_NAME },
  });
  check(
    'BK-03',
    '回滚第二份 → 恢复到 v1',
    restore2.data.restoredCount === 1 && afterRestore2.value === 'v1',
    `value=${String(afterRestore2.value)}`,
  );

  const restore1 = await handlerOf(system, 'system.backup.restore')({ backupId: backupId1 }, ctx('L2'));
  const afterRestore1 = await bridge.call('module', {
    module: 'system',
    function: 'Get-RegistryValue',
    args: { Path: TEST_KEY, Name: TEST_NAME },
  });
  check(
    'BK-04',
    '回滚第一份 → 值被删除（精确还原"原本不存在"）',
    restore1.data.restored[0]?.action === 'removed-value' && afterRestore1.exists === false,
    `action=${String(restore1.data.restored[0]?.action)} exists=${String(afterRestore1.exists)}`,
  );

  let pathCode = '';
  try {
    await handlerOf(system, 'system.backup.restore')({ backupId: 'C:\\Windows\\win.ini' }, ctx('L2'));
  } catch (error) {
    pathCode = error?.toolError?.code ?? '';
  }
  check('BK-05', '只接受 GUID（路径注入被拒）', pathCode === 'INVALID_PARAMS', pathCode);

  let missingCode = '';
  try {
    await handlerOf(system, 'system.backup.restore')({ backupId: '00000000-0000-0000-0000-000000000000' }, ctx('L2'));
  } catch (error) {
    missingCode = error?.toolError?.code ?? '';
  }
  check('BK-06', '不存在的备份 → BACKUP_NOT_FOUND', missingCode === 'BACKUP_NOT_FOUND', missingCode);

  const listed = await handlerOf(system, 'system.backup.list')({ maxItems: 5 }, ctx('L0'));
  check('BK-07', '备份列表可读', listed.data.count >= 2, `count=${listed.data.count} root=${listed.data.root}`);
} catch (error) {
  check('XX-00', '冒烟未抛异常', false, error instanceof Error ? error.message : String(error));
} finally {
  await bridge.call('invoke', {
    command: "Remove-Item -LiteralPath 'HKCU:\\Software\\WinMcpSmokeTest' -Recurse -Force -ErrorAction SilentlyContinue; 'cleaned'",
    timeoutMs: 10_000,
  });
  await bridge.stop();
}

log(`\n计划/回滚冒烟结果：${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);