import {
  CAPABILITY_DOMAINS,
  type Capability,
  type CapabilityPolicy,
  type CapabilitySpec,
  type Domain,
  type ToolAnnotations,
} from '../contracts/capability.js';
import { riskAtLeast } from '../contracts/risk.js';

const ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/** 破坏性路径操作的命令黑名单兜底（与调用方 policy 并集，不可删除） */
const DESTRUCTIVE_COMMAND_GUARD = ['\\bdel\\s+/s\\s+/q', '\\brm\\s+-rf'];

export class InvalidCapabilityIdError extends Error {
  constructor(id: string, reason: string) {
    super(`INVALID_CAPABILITY_ID: ${id}（${reason}）`);
    this.name = 'InvalidCapabilityIdError';
  }
}

/** 三段式能力 ID：<domain>.<group>.<action>，全小写，段内 [a-z0-9-] */
export function assertCapabilityId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new InvalidCapabilityIdError(String(id), '必须是非空字符串');
  }
  if (!ID_PATTERN.test(id)) {
    throw new InvalidCapabilityIdError(id, '必须形如 domain.group.action，全小写，段内仅 a-z0-9-');
  }
  const domain = id.split('.')[0] as Domain;
  if (!(CAPABILITY_DOMAINS as readonly string[]).includes(domain)) {
    throw new InvalidCapabilityIdError(id, `未知域 ${domain}，允许：${CAPABILITY_DOMAINS.join('/')}`);
  }
}

function mergeCommandDenylist(base: string[] | undefined, extra: readonly string[]): string[] {
  const merged = [...extra, ...(base ?? [])];
  return Array.from(new Set(merged));
}

function normalizePolicy(spec: CapabilitySpec): CapabilityPolicy | undefined {
  const policy: CapabilityPolicy = { ...(spec.policy ?? {}) };
  if (spec.destructivePath) {
    policy.commandDenylist = mergeCommandDenylist(policy.commandDenylist, DESTRUCTIVE_COMMAND_GUARD);
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

function normalizeAnnotations(spec: CapabilitySpec): ToolAnnotations {
  const readOnlyHint = spec.annotations?.readOnlyHint ?? spec.risk === 'L0';
  // 静态风险与只读语义冲突属于能力定义错误，启动期即失败（fail-fast）
  if (readOnlyHint && spec.risk !== 'L0') {
    throw new Error(
      `INVALID_CAPABILITY_DEFINITION: ${spec.id} 声明 risk=${spec.risk} 却标记 readOnlyHint=true`,
    );
  }
  const annotations: ToolAnnotations = {
    title: spec.annotations?.title ?? spec.name,
    readOnlyHint,
    destructiveHint: spec.annotations?.destructiveHint ?? riskAtLeast(spec.risk, 'L2'),
    idempotentHint: spec.annotations?.idempotentHint ?? spec.idempotent === true,
    openWorldHint: spec.annotations?.openWorldHint ?? false,
  };
  return annotations;
}

/** 能力归一化：补齐默认值 + 校验 + 注解读导（FR-101） */
export function cap(spec: CapabilitySpec): Capability {
  assertCapabilityId(spec.id);
  if (spec.name.trim().length === 0) throw new Error(`INVALID_CAPABILITY_DEFINITION: ${spec.id} name 为空`);
  if (spec.description.trim().length === 0) {
    throw new Error(`INVALID_CAPABILITY_DEFINITION: ${spec.id} description 为空`);
  }
  const domain = spec.id.split('.')[0] as Domain;
  const policy = normalizePolicy(spec);
  const capability: Capability = {
    id: spec.id,
    domain,
    name: spec.name,
    description: spec.description,
    risk: spec.risk,
    inputSchema: spec.inputSchema ?? {},
    ...(spec.handler !== undefined ? { handler: spec.handler } : {}),
    idempotent: spec.idempotent ?? false,
    requiresSession: spec.requiresSession ?? false,
    destructive: spec.destructive ?? false,
    destructivePath: spec.destructivePath ?? false,
    dynamicRisk: spec.dynamicRisk ?? false,
    policyControl: spec.policyControl ?? false,
    timeoutMs: spec.timeoutMs ?? 30_000,
    snapshot: spec.snapshot ?? 'none',
    ...(policy !== undefined ? { policy } : {}),
    annotations: normalizeAnnotations(spec),
  };
  return Object.freeze(capability);
}

/** 按域分组（返回只读视图顺序与入参一致） */
export function groupByDomain(caps: readonly Capability[]): Map<Domain, Capability[]> {
  const map = new Map<Domain, Capability[]>();
  for (const item of caps) {
    const bucket = map.get(item.domain);
    if (bucket === undefined) map.set(item.domain, [item]);
    else bucket.push(item);
  }
  return map;
}