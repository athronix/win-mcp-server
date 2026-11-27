/**
 * @win-mcp/core — win-mcp-servers 共享底座
 *
 * 分层：contracts（类型）→ registry（能力模型）→ 安全与治理（classify/policy/approval/audit/guard/taskmgr）
 *      → transport（MCP 网关）
 * 约束：本包不依赖任何 Windows-only API；平台能力通过参数/注入点提供。
 */
export * from './contracts/index.js';

export * from './registry/cap.js';
export * from './registry/registry.js';

export * from './classify/vocab.js';
export * from './classify/parser.js';
export * from './classify/command.js';

export * from './policy/glob.js';
export * from './policy/defaults.js';
export * from './policy/engine.js';

export * from './approval/hash.js';
export * from './approval/store.js';
export * from './approval/policy-control.js';
export * from './approval/gate.js';

export * from './plan/store.js';

export * from './bridge/protocol.js';
export * from './bridge/bridge.js';
export * from './bridge/ast.js';
export * from './bridge/errors.js';

export * from './desktop/control-policy.js';
export * from './desktop/consent.js';
export * from './desktop/gate.js';
export * from './desktop/io.js';
export * from './desktop/ref.js';

export * from './audit/chain.js';

export * from './guard/expect.js';
export * from './guard/ledger.js';

export * from './taskmgr/semaphore.js';

export * from './transport/gateway.js';

export * from './util/ids.js';