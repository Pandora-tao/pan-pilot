/**
 * 对外声明当前 Agent 真正支持的能力。
 *
 * `reserved` 表示协议位置已经预留，但服务端还没有实现对应能力；
 * 客户端因此可以提前识别边界，而不是通过调用失败来猜测。
 */
export const agentCapabilities = {
  apiVersion: "v1",
  capabilities: {
    chat: {
      status: "available",
      // /v1/chat 的 stream: true 已实现为 SSE 输出。
      streaming: true,
    },
    tools: {
      // 工具白名单已接入 ChatAgent 循环，/v1/chat 会执行注册的工具。
      status: "available",
    },
    memory: {
      status: "reserved",
    },
    planning: {
      status: "reserved",
    },
  },
} as const;
