#!/usr/bin/env node
/**
 * 文档-代码一致性门禁（NFR-6）
 *
 * 校验两件事：
 * 1. 关键公开 API 在源码中确实导出
 * 2. 同一批 API 在技术方案文档中有签名/说明
 *
 * 失败即 exit 1（文档与代码不符视为缺陷）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_DIR = 'packages/core/src';
const DOCS = [
  'docs/02-design/TECHNICAL-SOLUTION-core.md',
  'docs/02-design/TECHNICAL-SOLUTION-bridge.md',
];

const KEY_APIS = [
  'riskRank', 'maxRisk', 'riskAtLeast', 'isRiskLevel',
  'makeError', 'isToolError',
  'cap', 'assertCapabilityId', 'groupByDomain', 'CapabilityRegistry',
  'analyzeCommand', 'isInUserScope', 'fallbackParser',
  'globToRegex', 'normalizePath', 'extractPathTokens', 'collectStringValues',
  'DEFAULT_POLICY', 'mergePolicy', 'PolicyEngine',
  'canonicalJson', 'hashParams', 'ApprovalStore', 'evaluatePolicyControl', 'ToolGate',
  'AuditChain', 'redactParams',
  'normalizeAssertions', 'evaluateAssertions', 'EffectLedger',
  'CategorySemaphore',
  'createWinMcpServer', 'registerCapabilityTools', 'toCallResult', 'startStdio', 'startHttp',
  'MAX_INSTRUCTIONS_BYTES',
  'PowerShellBridge', 'BridgeError', 'encodeRequest', 'parseResponseLine',
  'parseWithBridge', 'analyzeCommandWithBridge', 'createBridgeClassifier', 'bridgeErrorToCode',
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const sources = walk(SRC_DIR).map((file) => readFileSync(file, 'utf8')).join('\n');
const doc = DOCS.map((file) => readFileSync(file, 'utf8')).join('\n');

const missingInCode = [];
const missingInDoc = [];
for (const name of KEY_APIS) {
  const codePattern = new RegExp(
    `export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function|class|const|interface|type|abstract\\s+class)\\s+${name}\\b`,
  );
  if (!codePattern.test(sources)) missingInCode.push(name);
  if (!doc.includes(name)) missingInDoc.push(name);
}

if (missingInCode.length > 0) {
  process.stdout.write(`FAIL  以下关键 API 未在源码导出：${missingInCode.join(', ')}\n`);
}
if (missingInDoc.length > 0) {
  process.stdout.write(`FAIL  以下关键 API 未在技术方案文档中出现：${missingInDoc.join(', ')}\n`);
}

if (missingInCode.length === 0 && missingInDoc.length === 0) {
  process.stdout.write(`PASS  文档-代码一致性：${KEY_APIS.length} 个关键 API 全部对齐\n`);
  process.exit(0);
}
process.exit(1);