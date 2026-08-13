/**
 * 规范化 JSON 序列化（键按字典序），保证语义相同的对象哈希一致，
 * 与属性书写顺序无关，作为 manifest 与目录快照的稳定输入。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
