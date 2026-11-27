import type { CapabilityPolicy } from '../contracts/capability.js';
import { makeError, type ToolError } from '../contracts/errors.js';
import type { RiskLevel } from '../contracts/risk.js';
import { riskAtLeast } from '../contracts/risk.js';
import { DEFAULT_POLICY, type PolicyConfig } from './defaults.js';
import {
  collectStringValues,
  expandEnvVars,
  globToRegex,
  isCommandishKey,
  looksLikeCommandValue,
  looksLikeRegistryPath,
  normalizePath,
  pathCandidates,
  pathMatchesAny,
  type StringValue,
} from './glob.js';

export interface PolicyRequest {
  capabilityId: string;
  params: Record<string, unknown>;
  risk: RiskLevel;
  approved: boolean;
  maxRisk?: RiskLevel;
  forceApproval?: boolean;
  capabilityPolicy?: CapabilityPolicy;
  /**
   * 可选的路径证据（来自 AST 解析）。一旦提供，命令型参数不再用正则从原文抽路径，
   * 而是只信任该证据——否则注释、here-string 里的路径文本会被误判为真实操作目标。
   */
  pathEvidence?: readonly string[];
  /** 纯分析能力（不执行任何操作）：跳过路径/命令策略检查，仅保留能力 ID 校验 */
  analysisOnly?: boolean;
}

export interface PolicyVerdict {
  allowed: boolean;
  matchedRule: string;
  requiresApproval: boolean;
  autoApproved?: boolean;
  error?: ToolError;
}

const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const WRITE_ACTION_PATTERN = /\.(write|set|create|delete|remove)(?:\.|$)/i;
const PROCESS_KEY_PATTERN = /\b(process|name|processName|target)\b/i;

/**
 * 策略引擎（FR-103）
 * 判定顺序：拒绝优先，黑名单最先；审批闸在最后。
 */
export class PolicyEngine {
  readonly #cfg: PolicyConfig;
  readonly #pathDenyRe: readonly RegExp[];
  readonly #pathAllowRe: readonly RegExp[];
  readonly #cmdDenyRe: readonly RegExp[];
  readonly #cmdAllowRe: readonly RegExp[];
  readonly #env: Record<string, string | undefined>;

  constructor(
    config: PolicyConfig = DEFAULT_POLICY,
    opts: { env?: Record<string, string | undefined> } = {},
  ) {
    this.#cfg = config;
    this.#env = opts.env ?? process.env;
    this.#pathDenyRe = config.pathDenylist.map(globToRegex);
    this.#pathAllowRe = config.pathAllowlist.map(globToRegex);
    this.#cmdDenyRe = config.commandDenylist.map((p) => new RegExp(p, 'i'));
    this.#cmdAllowRe = config.commandAllowlist.map((p) => new RegExp(p, 'i'));
  }

  get config(): PolicyConfig {
    return this.#cfg;
  }

  evaluate(req: PolicyRequest): PolicyVerdict {
    // 1. 能力 ID 必须合法（未注册由 registry 层拦截）
    if (!CAPABILITY_ID_PATTERN.test(req.capabilityId)) {
      return this.#deny('capability:invalid-id', `非法能力 ID：${req.capabilityId}`);
    }

    // 纯分析能力（如 shell.analyze）只做解析、不执行，跳过路径/命令检查；
    // 使用该标记的能力必须保证 handler 无副作用。
    if (req.analysisOnly === true) {
      return { allowed: true, matchedRule: 'allow:analysis-only', requiresApproval: false };
    }

    const values = collectStringValues(req.params);
    const evidence = req.pathEvidence;

    // 命令型 vs 路径型参数的判定（AST 证据只替代命令型参数的路径来源）
    const isCommandish = (key: string, value: string): boolean =>
      isCommandishKey(key) || looksLikeCommandValue(value);

    const candidatesFor = (key: string, value: string): string[] => {
      if (evidence === undefined) return pathCandidates(key, value);
      if (isCommandish(key, value)) {
        return evidence.filter((item) => !looksLikeRegistryPath(item));
      }
      return pathCandidates(key, value);
    };

    // 2. 路径黑名单（最高优先级）
    const capabilityPathDeny = (req.capabilityPolicy?.pathDenylist ?? []).map(globToRegex);
    for (const { key, value } of values) {
      for (const candidate of candidatesFor(key, value)) {
        const p = normalizePath(expandEnvVars(candidate, this.#env));
        const denyRes = [...this.#pathDenyRe, ...capabilityPathDeny];
        if (pathMatchesAny(p, denyRes)) {
          return this.#deny('pathDenylist', `路径命中黑名单，已拒绝：${candidate}`, {
            path: candidate,
          });
        }
      }
    }

    // 3. 命令黑名单（最高优先级）
    const capabilityCmdDeny = (req.capabilityPolicy?.commandDenylist ?? []).map(
      (p) => new RegExp(p, 'i'),
    );
    for (const { key, value } of values) {
      if (!isCommandishKey(key) && !looksLikeCommandValue(value)) continue;
      for (const re of [...this.#cmdDenyRe, ...capabilityCmdDeny]) {
        if (re.test(value)) {
          return this.#deny('commandDenylist', '命令命中黑名单，已拒绝', {
            param: key,
            rule: re.source,
          });
        }
      }
    }

    // 3b. 命令白名单（仅当配置非空时启用）
    if (this.#cmdAllowRe.length > 0) {
      for (const { key, value } of values) {
        if (!isCommandishKey(key) && !looksLikeCommandValue(value)) continue;
        if (!this.#cmdAllowRe.some((re) => re.test(value))) {
          return this.#deny('commandAllowlist:miss', '命令不在白名单内，已拒绝', { param: key });
        }
      }
    }

    // 4. 路径白名单（拒绝优先）
    if (this.#cfg.disablePathAllowlist !== true) {
      const capabilityPathAllow = (req.capabilityPolicy?.pathAllowlist ?? []).map(globToRegex);
      const allowRes = [...this.#pathAllowRe, ...capabilityPathAllow];
      if (allowRes.length > 0) {
        for (const { key, value } of values) {
          for (const candidate of candidatesFor(key, value)) {
            const p = normalizePath(expandEnvVars(candidate, this.#env));
            if (!pathMatchesAny(p, allowRes)) {
              return this.#deny('pathAllowlist:miss', `路径不在白名单内，已拒绝：${candidate}`, {
                path: candidate,
              });
            }
          }
        }
      }
    }

    // 4b. 注册表读写范围
    const registryValues: StringValue[] = [];
    for (const { key, value } of values) {
      if (evidence !== undefined && isCommandish(key, value)) continue;
      if (looksLikeRegistryPath(value)) registryValues.push({ key, value });
    }
    if (evidence !== undefined) {
      for (const item of evidence) {
        if (looksLikeRegistryPath(item)) registryValues.push({ key: 'command', value: item });
      }
    }
    if (registryValues.length > 0) {
      const isWrite = WRITE_ACTION_PATTERN.test(req.capabilityId);
      const allowList = isWrite
        ? (req.capabilityPolicy?.registryWriteAllowlist ?? this.#cfg.registryWriteAllowlist)
        : this.#cfg.registryReadAllowlist;
      const allowRes = allowList.map(globToRegex);
      for (const { value } of registryValues) {
        if (!allowRes.some((re) => re.test(normalizePath(value)))) {
          return this.#deny(
            isWrite ? 'registryWriteAllowlist:miss' : 'registryReadAllowlist:miss',
            `注册表路径不在允许范围内：${value}`,
            { path: value, mode: isWrite ? 'write' : 'read' },
          );
        }
      }
    }

    // 4c. 进程黑名单
    const processDeny = new Set([
      ...this.#cfg.processDenylist,
      ...(req.capabilityPolicy?.processDenylist ?? []),
    ]);
    for (const { key, value } of values) {
      if (!PROCESS_KEY_PATTERN.test(key)) continue;
      const normalized = value.trim().toLowerCase().replace(/\.exe$/, '');
      if (processDeny.has(normalized)) {
        return this.#deny('processDenylist', `受保护进程，禁止操作：${value}`, { process: value });
      }
    }

    // 5. 超出本次委派允许的最高风险（仅显式声明 maxRisk 时封顶）
    if (
      req.maxRisk !== undefined &&
      riskAtLeast(req.risk, 'L2') &&
      !riskAtLeast(req.maxRisk, req.risk)
    ) {
      return this.#deny(
        `maxRisk:${req.maxRisk}`,
        `操作风险 ${req.risk} 超出本次委派允许上限 ${req.maxRisk}`,
        { risk: req.risk, maxRisk: req.maxRisk },
      );
    }

    // 6. 审批闸
    if (riskAtLeast(req.risk, 'L2') && !req.approved) {
      const auto = req.forceApproval === true ? undefined : this.#cfg.autoApprove;
      const autoApproved =
        auto?.enabled === true && riskAtLeast(auto.maxRisk ?? 'L2', req.risk);
      if (!autoApproved) {
        return {
          allowed: false,
          matchedRule: 'approval-required',
          requiresApproval: true,
          error: makeError(
            'APPROVAL_REQUIRED',
            `风险等级 ${req.risk} 需人工审批后执行`,
            { risk: req.risk },
          ),
        };
      }
      return {
        allowed: true,
        matchedRule: 'allow:auto-approved',
        requiresApproval: false,
        autoApproved: true,
      };
    }

    // 7. 通过
    return { allowed: true, matchedRule: 'allow:policy-passed', requiresApproval: false };
  }

  #deny(
    matchedRule: string,
    message: string,
    details?: Record<string, unknown>,
  ): PolicyVerdict {
    return {
      allowed: false,
      matchedRule,
      requiresApproval: false,
      error: makeError('POLICY_DENIED', message, { rule: matchedRule, ...details }),
    };
  }
}