import type { ZodRawShape } from 'zod';
import type { RiskLevel } from './risk.js';

/** 业务域白名单 — 与 6 个对外 server + meta 一一对应（FR-101） */
export const CAPABILITY_DOMAINS = [
  'system',
  'apps',
  'browser',
  'desktop',
  'resource',
  'shell',
  'meta',
] as const;

export type Domain = (typeof CAPABILITY_DOMAINS)[number];

/** 副作用态：none 无副作用 / committed 已生效 / unknown 效果未知（禁止盲重试） */
export type EffectState = 'none' | 'committed' | 'unknown';

/** 能力级策略（与全局策略并集，无法删除全局红线） */
export interface CapabilityPolicy {
  pathDenylist?: string[];
  pathAllowlist?: string[];
  commandDenylist?: string[];
  commandAllowlist?: string[];
  processDenylist?: string[];
  registryWriteAllowlist?: string[];
  registryReadAllowlist?: string[];
}

/** MCP 工具注解（与 SDK ToolAnnotations 结构兼容，避免 core 依赖 SDK） */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface HandlerContext {
  traceId: string;
  risk: RiskLevel;
}

export interface Artifact {
  kind: string;
  name: string;
  mime?: string;
}

export interface CapabilityResult {
  data?: unknown;
  artifacts?: Artifact[];
  effectState?: EffectState;
  backupStatus?: 'confirmed' | 'unconfirmed';
  warnings?: string[];
}

export type CapabilityHandler = (
  params: Record<string, unknown>,
  ctx: HandlerContext,
) => Promise<CapabilityResult>;

/** 能力声明（注册时传入） */
export interface CapabilitySpec {
  id: string;
  name: string;
  description: string;
  risk: RiskLevel;
  inputSchema?: ZodRawShape;
  handler?: CapabilityHandler;
  idempotent?: boolean;
  requiresSession?: boolean;
  destructive?: boolean;
  /** 声明为破坏性路径操作：自动附加 del /s /q、rm -rf 的命令黑名单兜底 */
  destructivePath?: boolean;
  /** 动态风险：静态 risk 仅作保守上限，真实风险由运行时预检决定 */
  dynamicRisk?: boolean;
  /** 策略自管理能力：放权必须强制人工审批（绕过 autoApprove） */
  policyControl?: boolean;
  /** 纯分析能力（无副作用，如命令预检）：跳过路径/命令策略检查 */
  analysisOnly?: boolean;
  timeoutMs?: number;
  snapshot?: 'none' | 'before';
  policy?: CapabilityPolicy;
  annotations?: Partial<ToolAnnotations>;
}

/** 归一化后的能力（默认值已补齐） */
export interface Capability {
  readonly id: string;
  readonly domain: Domain;
  readonly name: string;
  readonly description: string;
  readonly risk: RiskLevel;
  readonly inputSchema: ZodRawShape;
  readonly handler?: CapabilityHandler;
  readonly idempotent: boolean;
  readonly requiresSession: boolean;
  readonly destructive: boolean;
  readonly destructivePath: boolean;
  readonly dynamicRisk: boolean;
  readonly policyControl: boolean;
  readonly analysisOnly: boolean;
  readonly timeoutMs: number;
  readonly snapshot: 'none' | 'before';
  readonly policy?: CapabilityPolicy;
  readonly annotations: ToolAnnotations;
}