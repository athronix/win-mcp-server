import type { RiskLevel } from '../contracts/risk.js';

/** 自动批准：仅跳过"人工确认"这一步，不绕过任何黑名单/白名单/进程保护/风险封顶 */
export interface AutoApproveConfig {
  readonly enabled: boolean;
  /** 可自动批准的最高风险：L2 自动、L3 仍需人工审批 */
  readonly maxRisk: 'L2' | 'L3';
}

export interface PolicyConfig {
  readonly pathDenylist: readonly string[];
  readonly pathAllowlist: readonly string[];
  readonly commandDenylist: readonly string[];
  readonly commandAllowlist: readonly string[];
  readonly processDenylist: readonly string[];
  readonly registryWriteAllowlist: readonly string[];
  readonly registryReadAllowlist: readonly string[];
  readonly defaultMaxRisk: RiskLevel;
  readonly approvalTimeoutMs: number;
  readonly autoApprove: AutoApproveConfig;
  /** 关闭路径白名单校验（企业内网调试用；默认不关闭） */
  readonly disablePathAllowlist?: boolean;
}

/**
 * 默认策略基线（拒绝优先，deny by default）
 * 移植自本地 core/dist/policy/defaults.js:7-79，进程保护名改为本项目进程
 */
export const DEFAULT_POLICY: PolicyConfig = {
  pathDenylist: [
    'C:\\Windows\\**',
    'C:\\Program Files\\**',
    'C:\\Program Files (x86)\\**',
    'C:\\ProgramData\\**',
    'C:\\System Volume Information\\**',
    'C:\\Recovery\\**',
    'C:\\Boot*',
    'C:\\bootmgr*',
    'C:\\hiberfil*',
    'C:\\pagefile*',
    'C:\\swapfile*',
    '\\\\?\\**',
    '\\\\*',
  ],
  pathAllowlist: ['C:\\Users\\**', 'C:\\Temp\\**', 'C:\\tmp\\**', 'D:\\Data\\**'],
  commandDenylist: [
    '\\bformat\\b',
    '\\bdiskpart\\b',
    '\\bbcdedit\\b',
    '\\bdel\\s+/s\\s+/q',
    '\\brm\\s+-rf\\s+/',
    '\\bcipher\\s+/w',
    '\\breg\\s+delete\\s+HKLM\\\\SYSTEM',
    '\\bnet\\s+user\\b.*\\/add',
    '\\bnet\\s+localgroup\\b.*\\/add',
    '\\btakeown\\b',
    '\\bicacls\\b.*\\bgrant\\b.*:\\(F\\)',
    '\\-enc(odedcommand)?\\b',
    '\\-e\\s+[A-Za-z0-9+/]{100,}={0,2}',
    'FromBase64String',
    'Invoke-Expression',
    '\\biex\\b',
  ],
  commandAllowlist: [],
  processDenylist: [
    'lsass',
    'csrss',
    'winlogon',
    'services',
    'smss',
    'wininit',
    'ntoskrnl',
    'system',
    'win-mcp-servers',
    'win-mcp-core',
  ],
  registryWriteAllowlist: ['HKCU:\\**', 'HKEY_CURRENT_USER\\**'],
  registryReadAllowlist: [
    'HKCU:\\**',
    'HKEY_CURRENT_USER\\**',
    'HKLM:\\SOFTWARE\\**',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\**',
  ],
  defaultMaxRisk: 'L1',
  approvalTimeoutMs: 120_000,
  autoApprove: { enabled: false, maxRisk: 'L2' },
};

function union(
  base: readonly string[] | undefined,
  override: readonly string[] | undefined,
): string[] {
  return Array.from(new Set([...(base ?? []), ...(override ?? [])]));
}

/** 合并用户配置与默认配置：数组并集（用户无法删除红线），标量用户优先 */
export function mergePolicy(base: PolicyConfig, override?: Partial<PolicyConfig>): PolicyConfig {
  if (override === undefined) return base;
  const merged: PolicyConfig = {
    pathDenylist: union(base.pathDenylist, override.pathDenylist),
    pathAllowlist: union(base.pathAllowlist, override.pathAllowlist),
    commandDenylist: union(base.commandDenylist, override.commandDenylist),
    commandAllowlist: union(base.commandAllowlist, override.commandAllowlist),
    processDenylist: union(base.processDenylist, override.processDenylist),
    registryWriteAllowlist: union(base.registryWriteAllowlist, override.registryWriteAllowlist),
    registryReadAllowlist: union(base.registryReadAllowlist, override.registryReadAllowlist),
    defaultMaxRisk: override.defaultMaxRisk ?? base.defaultMaxRisk,
    approvalTimeoutMs: override.approvalTimeoutMs ?? base.approvalTimeoutMs,
    autoApprove: {
      enabled: override.autoApprove?.enabled ?? base.autoApprove.enabled,
      maxRisk: override.autoApprove?.maxRisk ?? base.autoApprove.maxRisk,
    },
  };
  const disablePathAllowlist = override.disablePathAllowlist ?? base.disablePathAllowlist;
  return disablePathAllowlist === undefined ? merged : { ...merged, disablePathAllowlist };
}