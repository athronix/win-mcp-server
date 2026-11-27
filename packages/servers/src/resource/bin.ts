#!/usr/bin/env node
import { runServer } from '../shared/runner.js';
import { resourceCapabilities } from './capabilities.js';

const VERSION = '0.11.0';

const INSTRUCTIONS = [
  'win-mcp-resource：资源与存储（指标 / 磁盘空间 / 清理分析 / 清理执行）。',
  '推荐顺序：resource.metrics.get 与 resource.disk.space 看现状 → resource.cleanup.analyze 看可清理量 → 用户确认后再 resource.cleanup.execute。',
  'cleanup.execute 为 L2：首次调用返回 APPROVAL_REQUIRED（未删除任何文件），需用户明确批准后原样重发并带 __approvalId。',
  '清理只作用于当前用户 TEMP 根目录下的文件，不递归删目录、不触碰系统目录；返回 deleted/failed/freedMB。',
  '调优（资源优化）：resource.tune.catalog 看可用项 → resource.tune.plan 建快照拿 planId（快照在第一次修改前落盘）→ resource.tune.apply（L2，confirm=true）→ 不满意用 resource.tune.rollback + snapshotId 一键回滚。',
  '调优目录是硬编码白名单（5 项），不支持任意注册表写入；需要管理员的项在未提权时会被计划标为 blocker，不会静默跳过。',
  '回滚逆序执行，原本不存在的值会被删除而不是写默认值；电源方案恢复到快照时方案。latest-snapshot.json 只在第一次写入，保证"优化前基线"不被覆盖。',
].join('');

await runServer({
  name: 'win-mcp-resource',
  version: VERSION,
  instructions: INSTRUCTIONS,
  buildCapabilities: ({ bridge }) => resourceCapabilities(bridge),
});