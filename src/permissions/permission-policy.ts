import { matchesGlob } from "../utils/glob.js";
import { realpathOfExistingAncestor } from "../tools/fspath.js";

/**
 * 授权策略：敏感路径识别 + 终端命令分类。
 *
 * 敏感判定基于真实路径（realpath 最深深存在祖先），符号链接无法绕过；
 * 通过 PAN_PILOT_SENSITIVE_PATHS / PAN_PILOT_SENSITIVE_PATHS_FILE 可追加规则。
 */

const DEFAULT_SENSITIVE_PATTERNS: readonly string[] = [
  // SSH / GPG
  "**/.ssh/**",
  "**/.gnupg/**",
  // 云凭据
  "**/.aws/**",
  "**/.azure/**",
  "**/.config/gcloud/**",
  "**/.kube/**",
  "**/.config/oci/**",
  // 系统密钥存储 / 浏览器凭据
  "**/Library/Keychains/**",
  "**/.local/share/keyrings/**",
  "**/AppData/Local/Google/Chrome/User Data/**",
  "**/AppData/Roaming/Mozilla/Firefox/**",
  "**/Library/Application Support/Google/Chrome/**",
  "**/Library/Application Support/Firefox/**",
  "**/Library/Application Support/BraveSoftware/**",
  "**/Library/Application Support/com.apple.Terminal/**",
  // 敏感配置文件与私钥
  "**/.env",
  "**/.env.*",
  "**/.netrc",
  "**/.pgpass",
  "**/*id_rsa*",
  "**/*id_dsa*",
  "**/*id_ecdsa*",
  "**/*id_ed25519*",
  "**/*.pem",
  "**/*.key",
  "**/credentials.json",
  "**/service-account.json",
];

/** 终端严格只读白名单：只有这些命令的单条简单形式自动放行。 */
const TERMINAL_READONLY_ALLOW = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "echo", "printf",
  "which", "basename", "dirname", "stat", "date", "uname",
  "uptime", "whoami", "grep", "find", "du", "df", "cksum",
]);

/** 已知破坏性命令：每次授权、不可永久放行。 */
const TERMINAL_DESTRUCTIVE = new Set([
  "rm", "rmdir", "kill", "pkill", "killall", "chmod", "chown",
  "chgrp", "shutdown", "reboot", "halt", "poweroff", "mkfs",
  "dd", "sudo", "su", "passwd", "useradd", "usermod", "groupadd",
  "systemctl", "crontab", "mysql", "psql",
]);

/** 组合命令 / 重定向 / 脚本解释器 / 命令替换等一律询问（其 shell 元字符单独检测）。 */
const COMMAND_METACHARACTERS = new Set([
  "|", "&", ";", "<", ">", "$", "`", "(", ")", "{", "}",
  "*", "?", "[", "]", "~", "=", "\n", "\r", "\\",
]);

export interface TerminalCommandClass {
  action: "allow" | "ask";
  /** 是否允许「始终允许」落永久规则；破坏性命令为 false。 */
  permanentlyAllowable: boolean;
  /** 是否命中已知破坏性命令。 */
  destructive: boolean;
}

export interface SensitivePathConfig {
  enabled: boolean;
  patterns: readonly string[];
}

export class PermissionPolicy {
  constructor(
    private readonly extraSensitivePatterns: readonly string[] = [],
  ) {}

  sensitiveConfig(): SensitivePathConfig {
    return {
      enabled: true,
      patterns: [...DEFAULT_SENSITIVE_PATTERNS, ...this.extraSensitivePatterns],
    };
  }

  /** 判断绝对路径（或其真实位置）是否落在敏感集内。 */
  async isSensitivePath(absPath: string): Promise<boolean> {
    const patterns = this.sensitiveConfig().patterns;
    if (patterns.length === 0) return false;
    const candidates: string[] = [normalizeForMatch(absPath)];
    try {
      const real = await realpathOfExistingAncestor(absPath);
      if (real !== absPath) candidates.push(normalizeForMatch(real));
    } catch {
      // 路径不存在时只按规范化形态判定。
    }
    return candidates.some((candidate) =>
      patterns.some((pattern) => matchesGlob(pattern, candidate)));
  }

  /**
   * 终端命令分类：
   * - 严格白名单 + 无 shell 元字符 + 已知只读命令 → 自动允许；
   * - 已知破坏性命令 → 询问且不可永久放行；
   * - 其余（组合 / 重定向 / 脚本解释器 / 未知命令 / 任何修改操作）→ 询问。
   */
  classifyTerminalCommand(command: string): TerminalCommandClass {
    const trimmed = command.trim();
    if (trimmed === "") {
      return { action: "ask", permanentlyAllowable: true, destructive: false };
    }
    const first = firstToken(trimmed);
    const destructive = first !== undefined && TERMINAL_DESTRUCTIVE.has(first);
    if (destructive) {
      return { action: "ask", permanentlyAllowable: false, destructive: true };
    }
    if (hasCommandMeta(trimmed)) {
      return { action: "ask", permanentlyAllowable: true, destructive: false };
    }
    if (first !== undefined && TERMINAL_READONLY_ALLOW.has(first)) {
      return { action: "allow", permanentlyAllowable: false, destructive: false };
    }
    return { action: "ask", permanentlyAllowable: true, destructive: false };
  }
}

/** 规范化用于匹配的路径形态（Windows 反斜杠归一到 `/` 再归一化）。 */
function normalizeForMatch(absPath: string): string {
  return absPath.replaceAll("\\", "/");
}

function firstToken(command: string): string | undefined {
  const match = /^\s*([^\s]+)/.exec(command);
  return match?.[1];
}

/** 探测 shell 元字符：任何组合 / 重定向 / 命令替换形式都不自动放行。 */
function hasCommandMeta(command: string): boolean {
  for (const ch of command) {
    if (COMMAND_METACHARACTERS.has(ch)) return true;
  }
  return false;
}
