import type {
  ModelClient,
  ModelCompletion,
  ModelMessage,
} from "../model/model-client.js";

/**
 * Agent 应用层：隔离 HTTP 协议与具体模型厂商。
 *
 * 当前里程碑只有一次模型调用；后续的工具选择、执行和最大轮次控制
 * 应继续收敛在这一层，而不是写进路由或 DeepSeek 适配器。
 */
export class ChatAgent {
  // 依赖接口而非 DeepSeekClient，便于切换模型，也便于测试时注入假实现。
  constructor(private readonly modelClient: ModelClient) {}

  async chat(messages: readonly ModelMessage[]): Promise<ModelCompletion> {
    return this.modelClient.complete(messages);
  }
}
