import type { FastifyInstance } from "fastify";
import { agentCapabilities } from "../agent/capabilities.js";

export function registerCapabilitiesRoute(app: FastifyInstance): void {
  app.get("/v1/capabilities", async () => agentCapabilities);
}
