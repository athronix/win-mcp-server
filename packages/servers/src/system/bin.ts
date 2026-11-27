#!/usr/bin/env node
import { runServer } from '../shared/runner.js';
import { systemCapabilities } from './capabilities.js';

const VERSION = '0.10.0';

const INSTRUCTIONS = [
  'win-mcp-system：Windows 系统操作（系统信息/服务/进程/事件日志/任务计划/注册表/启动项/网络）。',
  '只读工具（risk=L0）直接执行。写操作（服务控制、结束进程、写注册表）风险 L2：首次调用返回 APPROVAL_REQUIRED 与 approvalId，此时系统状态未改变。',
  '收到 APPROVAL_REQUIRED 时，必须把 approval.impact 与 approval.preview 展示给用户；仅在用户明确批准后，用完全相同的参数加 __approvalId 重发一次。参数任何变化都会作废审批。',
  '受保护进程（lsass/csrss/winlogon 等）与系统关键路径会被策略直接拒绝（POLICY_DENIED），审批无法绕过。',
  '注册表写入默认只允许 HKCU；HKLM 需在部署配置中显式放行。写入前自动备份原值并返回 backupId。',
  '回滚：system.backup.restore 只接受 backupId（GUID），不接受路径；逆序恢复，原本不存在的值会被删除而不是写默认值；空注册表键保留。system.backup.list 可查最近备份。',
].join('');

await runServer({
  name: 'win-mcp-system',
  version: VERSION,
  instructions: INSTRUCTIONS,
  buildCapabilities: ({ bridge }) => systemCapabilities(bridge),
});