/** 模型层使用的最小消息格式，避免上层直接依赖某个厂商 SDK 的类型。 */
export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 将不同模型厂商的返回值归一化为 Agent 关心的字段。 */
export interface ModelCompletion {
  content: string;
  model: string;
  totalTokens?: number;
}

/**
 * 模型适配端口。
 *
 * Agent 只认识这个接口；真实运行时可接 DeepSeek，测试时则可传入内存中的假实现。
 */
export interface ModelClient {
  complete(messages: readonly ModelMessage[]): Promise<ModelCompletion>;
}
