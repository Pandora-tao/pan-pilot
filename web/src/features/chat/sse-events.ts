/**
 * SSE 事件增量解析器（与 DOM 无关，便于单元测试）。
 *
 * 服务端每条事件是一块 `data: {json}\n\n`；网络分片可能把块拆开，
 * 因此按块累积缓冲并逐块解析，无法解析的行安全跳过而不是中断整个流。
 */
export class SseEventParser<T> {
  private buffer = "";

  /** 追加一段解码后的文本，返回本次完整解析出的事件。 */
  push(chunk: string): T[] {
    // 归一化 CRLF，兼容不同代理/服务器的换行风格。
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: T[] = [];
    let separator = this.buffer.indexOf("\n\n");
    while (separator !== -1) {
      const block = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);
      const event = parseSseBlock<T>(block);
      if (event !== undefined) events.push(event);
      separator = this.buffer.indexOf("\n\n");
    }
    return events;
  }
}

/** 从一条 SSE 块（可能含注释/多行）中解析第一个 data 行。 */
export function parseSseBlock<T>(block: string): T | undefined {
  const line = block.split(/\r?\n/).find((entry) => entry.startsWith("data:"));
  if (line === undefined) return undefined;
  const payload = line.slice("data:".length).trimStart();
  try {
    return JSON.parse(payload) as T;
  } catch {
    return undefined;
  }
}
