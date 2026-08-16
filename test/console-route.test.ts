import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";

/* Vite 控制台由服务端同源托管，业务 API 仍由其他路由测试覆盖。 */
describe("console page", () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function buildAppWithFakeModel() {
    const modelClient: ModelClient = {
      complete: async () => ({
        content: "",
        toolCalls: [],
        model: "test-model",
      }),
      completeStream: async function* () {},
    };
    const app = buildApp({ modelClient });
    apps.push(app);
    return app;
  }

  it("serves the single-file console at / and /console", async () => {
    const app = buildAppWithFakeModel();

    for (const url of ["/", "/console"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("PanPilot 控制台");
      expect(response.body).toContain("/console/assets/");
      expect(response.body).toContain("</html>");
    }
  });

  it("serves hashed Vite assets with immutable caching", async () => {
    const app = buildAppWithFakeModel();
    const page = await app.inject({ method: "GET", url: "/console" });
    const assetUrls = [...page.body.matchAll(/(?:src|href)="(\/console\/assets\/[^"]+)"/g)]
      .map((match) => match[1]!);

    expect(assetUrls.length).toBeGreaterThanOrEqual(2);
    for (const url of assetUrls) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toContain("immutable");
      expect(response.headers["content-type"]).toMatch(/javascript|css/);
    }
  });

  it("allows cross-origin calls from file:// and localhost pages only", async () => {
    const app = buildAppWithFakeModel();

    // file:// 页面（Origin: null）与非流式 API 请求都放行。
    const filePage = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { origin: "null" },
    });
    expect(filePage.statusCode).toBe(200);
    expect(filePage.headers["access-control-allow-origin"]).toBe("null");

    // localhost 静态服务器来源放行，并处理预检请求。
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/chat",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(preflight.headers["access-control-allow-headers"]).toContain("authorization");
    expect(preflight.headers["access-control-expose-headers"]).toContain("content-disposition");

    // 任意网页来源不放行，浏览器拿不到 CORS 头。
    const evilSite = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { origin: "https://evil.example" },
    });
    expect(evilSite.statusCode).toBe(200);
    expect(evilSite.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not expose source modules or allow asset path traversal", async () => {
    const app = buildAppWithFakeModel();
    const source = await app.inject({
      method: "GET",
      url: "/console/src/main.tsx",
    });
    expect(source.statusCode).toBe(404);

    const traversal = await app.inject({
      method: "GET",
      url: "/console/%2e%2e/package.json",
    });
    expect([400, 404]).toContain(traversal.statusCode);
  });
});
