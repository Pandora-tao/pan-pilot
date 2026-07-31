import type {
  ModelClient,
  ModelCompletion,
  ModelMessage,
} from "../model/model-client.js";

export class ChatAgent {
  constructor(private readonly modelClient: ModelClient) {}

  async chat(messages: readonly ModelMessage[]): Promise<ModelCompletion> {
    return this.modelClient.complete(messages);
  }
}
