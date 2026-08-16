/** 优先读取 RFC 5987 filename*，跨源不可见或格式异常时使用安全回退名。 */
export function downloadFileName(response: Response, fallback: string): string {
  const header = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  let candidate: string | undefined;
  if (encoded !== undefined) {
    try {
      candidate = decodeURIComponent(encoded);
    } catch {
      candidate = undefined;
    }
  }
  candidate ??= /filename="([^"]+)"/i.exec(header)?.[1];
  const baseName = candidate?.split(/[\\/]/).pop()?.trim();
  return baseName || fallback;
}
