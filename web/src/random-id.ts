/**
 * 生成 UUID v4 客户端标识。
 *
 * 优先使用 crypto.randomUUID（Safari 15.4+ / Chrome 92+）；老设备（如停在
 * iOS 15.8 的 iPhone 6s/7）没有该 API，降级为 crypto.getRandomValues 手动
 * 构造 v4（Safari 10+ 即支持），避免发送消息等路径静默崩溃。
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
