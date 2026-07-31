import Fastify, { type FastifyBaseLogger } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { ChatAgent } from "./agent/chat-agent.js";
import { DeepSeekClient } from "./model/deepseek-client.js";
import type { ModelClient } from "./model/model-client.js";
import { registerCapabilitiesRoute } from "./routes/capabilities-route.js";
import { registerChatRoute } from "./routes/chat-route.js";
import { registerHealthRoute } from "./routes/health-route.js";

export interface BuildAppOptions {
  modelClient?: ModelClient;
  apiToken?: string;
  logChatContent?: boolean;
  loggerInstance?: FastifyBaseLogger;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = options.loggerInstance
    ? Fastify({ loggerInstance: options.loggerInstance })
    : Fastify({ logger: true });
  const modelClient = options.modelClient ?? new DeepSeekClient();
  const apiToken = options.apiToken ?? process.env.PAN_PILOT_API_TOKEN ?? "";
  const logChatContent = options.logChatContent
    ?? isEnabled(process.env.PAN_PILOT_LOG_CHAT_CONTENT);
  const chatAgent = new ChatAgent(modelClient);

  if (logChatContent) {
    app.log.warn(
      { event: "pan_pilot.chat.content_logging_enabled" },
      "PanPilot chat content logging is enabled; prompts and replies may contain private data",
    );
  }

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/") || !apiToken) return;
    const provided = request.headers.authorization ?? "";
    const expected = `Bearer ${apiToken}`;
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length
        || !timingSafeEqual(providedBuffer, expectedBuffer)) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        message: "PanPilot API token 不正确",
      });
    }
  });

  registerHealthRoute(app);
  registerCapabilitiesRoute(app);
  registerChatRoute(app, chatAgent, { logChatContent });

  return app;
}

function isEnabled(value: string | undefined): boolean {
  return value !== undefined
    && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
