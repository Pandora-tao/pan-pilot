/** 中文文件名用 RFC 5987 filename* 传递，同时保留 ASCII fallback。 */
export function attachmentHeader(name: string): string {
  const asciiFallback = name.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
