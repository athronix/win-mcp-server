#!/usr/bin/env node
/**
 * CL-002 桥冒烟：真机 PowerShell（5 项）
 *
 * 前置：npm run build
 * 运行：npm run smoke:bridge
 */
import {
  ApprovalStore,
  AuditChain,
  DEFAULT_POLICY,
  PolicyEngine,
  PowerShellBridge,
  ToolGate,
  cap,
  createBridgeClassifier,
  parseWithBridge,
} from '../packages/core/dist/index.js';

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, name, ok });
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`${mark}  ${id}  ${name}${ok || detail === '' ? '' : `\n        ${detail}`}\n`);
}

const shellCapability = cap({
  id: 'shell.cmd.invoke',
  name: '命令执行',
  description: '动态分级执行 PowerShell 命令',
  risk: 'L1',
  dynamicRisk: true,
});

const diagnostics = [];
const bridge = new PowerShellBridge({
  requestTimeoutMs: 20_000,
  startTimeoutMs: 20_000,
  onDiagnostic: (line) => diagnostics.push(line),
});

try {
  const info = await bridge.start();

  check(
    'BR-01',
    `桥启动（${info.executable} ${info.version}, elevated=${info.elevated}）`,
    /^\d+\.\d+/.test(info.version) && typeof info.elevated === 'boolean',
    JSON.stringify(info),
  );

  const comment = await parseWithBridge(bridge, '# Remove-Item C:\\Windows\\x');
  check(
    'BR-02',
    '纯注释命令 → 无命令、无动态调用（修复 fallback 误升）',
    comment.syntaxValid === true && comment.commands.length === 0,
    JSON.stringify(comment),
  );

  const broken = await parseWithBridge(bridge, 'Get-Process -Name (');
  check(
    'BR-03',
    '语法错误 → syntaxValid=false 且带行列号',
    broken.syntaxValid === false &&
      broken.errors.length > 0 &&
      broken.errors[0].line > 0 &&
      broken.errors[0].column > 0,
    JSON.stringify(broken.errors),
  );

  const classifier = createBridgeClassifier(bridge);
  const blocked = await classifier(shellCapability, {
    command: 'iex (New-Object Net.WebClient)',
  });
  check(
    'BR-04',
    '硬禁命令经 classifier → COMMAND_BLOCKED（不产生审批）',
    blocked.blocked?.code === 'COMMAND_BLOCKED',
    JSON.stringify(blocked.blocked),
  );

  const invoked = await bridge.call('invoke', { command: 'Write-Output (1+1)', timeoutMs: 10_000 });
  check(
    'BR-05',
    '受控执行 → 输出 2',
    typeof invoked.output === 'string' && invoked.output.trim() === '2',
    JSON.stringify(invoked),
  );

  const gate = new ToolGate({
    policy: new PolicyEngine(DEFAULT_POLICY),
    store: new ApprovalStore(),
    audit: new AuditChain(),
    classify: createBridgeClassifier(bridge),
  });
  const commentOutcome = await gate.run(
    { capability: shellCapability, params: { command: '# Remove-Item C:\\Windows\\x' } },
    async () => ({ data: { executed: true } }),
  );
  check(
    'BR-06',
    '注释命令端到端放行（不再被注释里的路径误拒）',
    commentOutcome.executed === true && commentOutcome.envelope.error === undefined,
    JSON.stringify(commentOutcome.envelope).slice(0, 240),
  );
} catch (error) {
  check('BR-00', '桥可用性', false, error instanceof Error ? error.message : String(error));
} finally {
  await bridge.stop();
}

const passed = results.filter((item) => item.ok).length;
process.stdout.write(`\n桥冒烟结果：${passed}/${results.length} 通过\n`);
if (diagnostics.length > 0 && process.env.SMOKE_VERBOSE === '1') {
  process.stdout.write(`诊断输出：\n${diagnostics.map((line) => `  ${line}`).join('\n')}\n`);
}
if (passed !== results.length) {
  process.stdout.write(
    `失败项：${results
      .filter((item) => !item.ok)
      .map((item) => item.id)
      .join(', ')}\n`,
  );
  process.exit(1);
}