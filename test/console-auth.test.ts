import { describe, expect, it } from "vitest";
import { ConsoleAuth } from "../src/auth/console-auth.js";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";

const modelClient: ModelClient = {
  complete: async () => ({ content: "ok", model: "test-model", toolCalls: [] }),
  completeStream: async function* () {
    yield {
      type: "completion",
      completion: { content: "ok", model: "test-model", toolCalls: [] },
    };
  },
};

describe("ConsoleAuth", () => {
  it("exchanges the password for a signed expiring passport", () => {
    let now = Date.parse("2026-08-17T00:00:00.000Z");
    const auth = new ConsoleAuth({
      apiToken: "internal-secret",
      password: "test-password",
      passportTtlMs: 60_000,
      now: () => now,
    });

    expect(auth.verifyPassword("test-password")).toBe(true);
    expect(auth.verifyPassword("wrong")).toBe(false);
    const issued = auth.issuePassport();
    expect(auth.verifyCredential("internal-secret")).toBe(true);
    expect(auth.verifyCredential(issued.passport)).toBe(true);
    expect(issued.passport).not.toContain("internal-secret");
    expect(issued.passport).not.toContain("test-password");

    now += 61_000;
    expect(auth.verifyCredential(issued.passport)).toBe(false);
  });

  it("rejects tampered passports and invalidates them when the password changes", () => {
    const original = new ConsoleAuth({ apiToken: "secret", password: "first" });
    const passport = original.issuePassport().passport;
    const changed = new ConsoleAuth({ apiToken: "secret", password: "second" });

    expect(original.verifyPassport(`${passport}x`)).toBe(false);
    expect(changed.verifyPassport(passport)).toBe(false);
  });
});

describe("console password login route", () => {
  it("keeps the raw API token server-side and accepts the issued passport", async () => {
    const app = buildApp({
      modelClient,
      apiToken: "internal-secret",
      consolePassword: "test-password",
    });

    const anonymous = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(anonymous.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { password: "wrong" },
    });
    expect(wrong.statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { password: "test-password" },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json<{ passport: string; expiresAt: string }>();
    expect(body.passport).toMatch(/^pp1\./);
    expect(body.passport).not.toContain("internal-secret");

    const authenticated = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { authorization: `Bearer ${body.passport}` },
    });
    expect(authenticated.statusCode).toBe(200);
    await app.close();
  });

  it("fails closed when the console password is not configured", async () => {
    const app = buildApp({ modelClient, apiToken: "internal-secret", consolePassword: "" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { password: "anything" },
    });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("rate limits repeated wrong passwords", async () => {
    const app = buildApp({
      modelClient,
      apiToken: "internal-secret",
      consolePassword: "test-password",
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { password: "wrong" },
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { password: "test-password" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    await app.close();
  });
});
