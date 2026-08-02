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
      streaming: false,
    },
    tools: {
      status: "reserved",
    },
    memory: {
      status: "reserved",
    },
    planning: {
      status: "reserved",
    },
  },
} as const;
