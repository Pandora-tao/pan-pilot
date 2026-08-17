import {
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const PASSPORT_VERSION = "pp1";
export const DEFAULT_CONSOLE_PASSPORT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

interface PassportPayload {
  v: 1;
  iat: number;
  exp: number;
  nonce: string;
}

export interface ConsoleAuthOptions {
  apiToken: string;
  password: string;
  passportTtlMs?: number;
  now?: () => number;
}

/**
 * 控制台密码只用于换取短格式签名通行证；原始 API token 始终留在服务端。
 * 通行证使用 API token 与当前密码共同派生的 HMAC 密钥，修改任一配置都会使旧通行证失效。
 */
export class ConsoleAuth {
  private readonly apiToken: string;
  private readonly password: string;
  private readonly passportTtlMs: number;
  private readonly now: () => number;
  private readonly signingKey: Buffer;

  constructor(options: ConsoleAuthOptions) {
    this.apiToken = options.apiToken;
    this.password = options.password;
    this.passportTtlMs = options.passportTtlMs ?? DEFAULT_CONSOLE_PASSPORT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.signingKey = createHmac("sha256", this.apiToken)
      .update("panpilot-console-passport\0")
      .update(this.password)
      .digest();
  }

  get configured(): boolean {
    return this.apiToken.length > 0 && this.password.length > 0;
  }

  verifyPassword(candidate: string): boolean {
    return this.configured && secureStringEqual(candidate, this.password);
  }

  issuePassport(): { passport: string; expiresAt: string } {
    if (!this.configured) {
      throw new Error("Console password authentication is not configured");
    }
    const issuedAt = Math.floor(this.now() / 1_000);
    const expiresAt = Math.floor((this.now() + this.passportTtlMs) / 1_000);
    const payload: PassportPayload = {
      v: 1,
      iat: issuedAt,
      exp: expiresAt,
      nonce: randomBytes(16).toString("base64url"),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const unsigned = `${PASSPORT_VERSION}.${encodedPayload}`;
    const signature = this.sign(unsigned);
    return {
      passport: `${unsigned}.${signature}`,
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    };
  }

  /** 后端仍可继续使用原始 API token；浏览器使用签名通行证。 */
  verifyCredential(candidate: string): boolean {
    return (this.apiToken.length > 0 && secureStringEqual(candidate, this.apiToken))
      || this.verifyPassport(candidate);
  }

  verifyPassport(passport: string): boolean {
    if (!this.configured) return false;
    const parts = passport.split(".");
    if (parts.length !== 3 || parts[0] !== PASSPORT_VERSION) return false;
    const [, encodedPayload, providedSignature] = parts;
    if (!encodedPayload || !providedSignature
        || !/^[A-Za-z0-9_-]+$/.test(encodedPayload)
        || !/^[A-Za-z0-9_-]+$/.test(providedSignature)) {
      return false;
    }
    const unsigned = `${PASSPORT_VERSION}.${encodedPayload}`;
    if (!secureStringEqual(providedSignature, this.sign(unsigned))) return false;

    try {
      const payload = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf8"),
      ) as Partial<PassportPayload>;
      const now = Math.floor(this.now() / 1_000);
      return payload.v === 1
        && Number.isInteger(payload.iat)
        && Number.isInteger(payload.exp)
        && typeof payload.nonce === "string"
        && payload.nonce.length >= 16
        && (payload.iat as number) <= now + 60
        && (payload.exp as number) > now;
    } catch {
      return false;
    }
  }

  private sign(unsigned: string): string {
    return createHmac("sha256", this.signingKey).update(unsigned).digest("base64url");
  }
}

/** 对任意长度字符串先做固定长度摘要，再使用恒定时间比较。 */
function secureStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
