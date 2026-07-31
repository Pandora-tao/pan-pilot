import { buildApp } from "./app.js";

const app = buildApp();

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

await app.listen({ host, port });
