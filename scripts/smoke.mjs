#!/usr/bin/env node
/**
 * P0 冒烟：审批与分级 12 项（对应 TEST-PLAN T-01..T-12）
 *
 * 前置：npm run build
 * 运行：npm run smoke
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`${mark}  ${id}  ${name}${ok || detail === '' ? '' : `\n        ${detail}`}\n`);
}

const demoPath = path.resolve('examples/demo-server.mjs');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [demoPath],
  stderr: 'pipe',
});
transport.stderr?.on('data', (chunk) => {
  const text = chunk.toString().trim();
  if (text.length > 0 && process.env.SMOKE_VERBOSE === '1') process.stderr.write(`[server] ${text}\n`);
});

const client = new Client({ name: 'win-mcp-smoke', version: '0.1.0' });
await client.connect(transport);

async function call(name, args) {
  const raw = await client.callTool({ name, arguments: args });
  return {
    structured: raw.structuredContent ?? {},
    isError: raw.isError === true,
    text: Array.isArray(raw.content) && raw.content[0]?.type === 'text' ? raw.content[0].text : '',
  };
}

try {
  // ---------- T-11 tools/list ----------
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  const expected = [
    'system.info.get',
    'system.service.control',
    'system.file.write',
    'shell.cmd.invoke',
    'meta.policy.set',
  ];
  check(
    'T-11',
    'tools/list 暴露全部 5 个能力',
    expected.every((n) => names.includes(n)) && names.length === expected.length,
    `实际: ${names.join(', ')}`,
  );

  // ---------- T-01 L0 直放 ----------
  const info = await call('system.info.get', {});
  check(
    'T-01',
    'L0 直放（无审批、ok=true）',
    info.structured.ok === true && info.structured.approval === undefined && info.isError === false,
    JSON.stringify(info.structured).slice(0, 200),
  );

  // ---------- T-02 L2 首次拦截 ----------
  const first = await call('system.service.control', { name: 'spooler', action: 'stop' });
  const approvalId = first.structured.approval?.approvalId;
  check(
    'T-02',
    'L2 首次拦截：APPROVAL_REQUIRED 且 isError 未置位、含 impact',
    first.structured.ok === false &&
      first.structured.error?.code === 'APPROVAL_REQUIRED' &&
      first.isError === false &&
      typeof approvalId === 'string' &&
      Array.isArray(first.structured.approval?.impact) &&
      first.structured.approval.impact.length > 0,
    JSON.stringify(first.structured).slice(0, 240),
  );

  // ---------- T-03 原样重发 ----------
  const second = await call('system.service.control', {
    name: 'spooler',
    action: 'stop',
    __approvalId: approvalId,
  });
  check(
    'T-03',
    '原样重发执行成功并落审计',
    second.structured.ok === true &&
      typeof second.structured.auditRef === 'string' &&
      second.isError === false,
    JSON.stringify(second.structured).slice(0, 200),
  );

  // ---------- T-04 改参掉包 ----------
  const first2 = await call('system.service.control', { name: 'spooler', action: 'stop' });
  const tampered = await call('system.service.control', {
    name: 'spooler',
    action: 'start',
    __approvalId: first2.structured.approval?.approvalId,
  });
  check(
    'T-04',
    '改参数 → APPROVAL_MISMATCH 且 isError=true',
    tampered.structured.error?.code === 'APPROVAL_MISMATCH' && tampered.isError === true,
    JSON.stringify(tampered.structured).slice(0, 200),
  );

  // ---------- T-05 二次使用 ----------
  const first3 = await call('system.service.control', { name: 'spooler', action: 'stop' });
  const id3 = first3.structured.approval?.approvalId;
  await call('system.service.control', { name: 'spooler', action: 'stop', __approvalId: id3 });
  const replay = await call('system.service.control', {
    name: 'spooler',
    action: 'stop',
    __approvalId: id3,
  });
  check(
    'T-05',
    '凭证一次性：二次使用被拒',
    replay.structured.error?.code === 'APPROVAL_MISMATCH',
    JSON.stringify(replay.structured).slice(0, 200),
  );

  // ---------- T-06 硬禁不入审批 ----------
  const blocked = await call('shell.cmd.invoke', { command: 'iex (New-Object Net.WebClient)' });
  check(
    'T-06',
    '硬禁命令 COMMAND_BLOCKED，无 approvalId',
    blocked.structured.error?.code === 'COMMAND_BLOCKED' &&
      blocked.structured.approval === undefined &&
      blocked.structured.risk === 'L3',
    JSON.stringify(blocked.structured).slice(0, 240),
  );

  // ---------- T-07 语法错误 ----------
  const syntax = await call('shell.cmd.invoke', { command: 'Get-Process -Name (' });
  check(
    'T-07',
    '语法错误 INVALID_SYNTAX，不入审批',
    syntax.structured.error?.code === 'INVALID_SYNTAX' && syntax.structured.approval === undefined,
    JSON.stringify(syntax.structured).slice(0, 240),
  );

  // ---------- T-08 提权升级 ----------
  const elevated = await call('shell.cmd.invoke', { command: 'Get-Process', runAsAdmin: true });
  check(
    'T-08',
    '提权只读 → 至少 L2 并触发审批',
    elevated.structured.risk === 'L2' &&
      elevated.structured.error?.code === 'APPROVAL_REQUIRED',
    JSON.stringify(elevated.structured).slice(0, 240),
  );

  // ---------- T-09 防自我放权 ----------
  const policySet = await call('meta.policy.set', { enabled: true, maxRisk: 'L3' });
  check(
    'T-09',
    '放权强制 L3 审批且提示不受 autoApprove 影响',
    policySet.structured.error?.code === 'APPROVAL_REQUIRED' &&
      policySet.structured.risk === 'L3' &&
      String(policySet.structured.approval?.impact ?? '').includes('放权操作已强制审批'),
    JSON.stringify(policySet.structured).slice(0, 260),
  );

  // ---------- T-10 黑名单不可审批绕过 ----------
  const denied = await call('system.file.write', { path: 'C:\\Windows\\System32\\x.txt' });
  check(
    'T-10',
    '路径黑名单 POLICY_DENIED，无审批通道',
    denied.structured.error?.code === 'POLICY_DENIED' && denied.structured.approval === undefined,
    JSON.stringify(denied.structured).slice(0, 220),
  );

  // ---------- T-12 /health chainValid ----------
  const port = 18765;
  const httpChild = spawn(process.execPath, [demoPath, '--http', String(port)], {
    stdio: 'ignore',
  });
  let healthOk = false;
  let healthBody = '';
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(150);
      try {
        const response = await fetch(`http://localhost:${port}/health`);
        if (response.ok) {
          const body = await response.json();
          healthBody = JSON.stringify(body);
          healthOk = body.chainValid === true && body.capabilities === expected.length;
          break;
        }
      } catch {
        // 服务尚未就绪，继续重试
      }
    }
  } finally {
    httpChild.kill('SIGTERM');
  }
  check('T-12', '/health 返回 chainValid=true 且能力数正确', healthOk, healthBody.slice(0, 240));
} finally {
  await client.close();
}

const passed = results.filter((item) => item.ok).length;
const total = results.length;
process.stdout.write(`\n冒烟结果：${passed}/${total} 通过\n`);
if (passed !== total) {
  process.stdout.write(
    `失败项：${results
      .filter((item) => !item.ok)
      .map((item) => item.id)
      .join(', ')}\n`,
  );
  process.exit(1);
}