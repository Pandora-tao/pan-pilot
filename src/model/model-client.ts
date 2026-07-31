export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelCompletion {
  content: string;
  model: string;
  totalTokens?: number;
}

export interface ModelClient {
  complete(messages: readonly ModelMessage[]): Promise<ModelCompletion>;
}
