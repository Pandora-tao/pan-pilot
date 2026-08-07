import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ModelClient } from "../src/model/model-client.js";

/*
 * 控制台页面是纯静态 HTML，测试只验证路由可达且由服务端同源提供；
 * 页面内的 fetch 调用走 /v1/*，由其他路由测试覆盖。
 */
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
      expect(response.body).toContain("/v1/capabilities");
      expect(response.body).toContain("</html>");
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

    // 任意网页来源不放行，浏览器拿不到 CORS 头。
    const evilSite = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { origin: "https://evil.example" },
    });
    expect(evilSite.statusCode).toBe(200);
    expect(evilSite.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("references only element ids that exist in the page", async () => {
    const app = buildAppWithFakeModel();
    const response = await app.inject({ method: "GET", url: "/console" });
    const html = response.body;

    const usedIds = [...html.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]);
    const definedIds = new Set(
      [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
    );

    expect(usedIds.length).toBeGreaterThan(10);
    for (const id of usedIds) {
      expect(definedIds.has(id), `页面 JS 引用了不存在的 id="${id}"`).toBe(true);
    }
  });
});
