# PanPilot 工具插件（声明式 v1）

每个插件是 `plugins/<name>/manifest.json` 一个文件，`<name>` 必须与
`manifest.name` 一致。服务启动或 `POST /v1/plugins/reload` 时全量扫描。

## manifest 字段

- `apiVersion`：固定 `"v1"`。
- `name`：小写字母开头，只含小写字母、数字、下划线。
- `description`：给模型的工具说明。
- `parameters`：标准 JSON Schema（`type: "object"`），http 插件用它校验入参。
- `executor`：二选一：
  - `{ "type": "builtin", "ref": "<内置实现名>" }`：引用框架内已有实现，
    参数校验以该实现自身的 zod schema 为准（`parameters` 是同源生成的声明快照）。
  - `{ "type": "http", "method", "url", "headers", "timeoutMs", "responsePath" }`：
    零代码声明一个 HTTP-JSON 工具。`url` 与 `headers` 值支持 `${param}`（入参）
    与 `${env:VAR}`（进程环境变量，密钥不落盘）；`responsePath` 用点路径提取
    响应字段（如 `data.items[0].title`），缺省返回整个 JSON。
- `enabled`：默认 `true`；可用 `/v1/plugins/:name/disable|enable` 切换，
  用户选择会写回 manifest，重启后保持状态。

## http 插件示例

```json
{
  "apiVersion": "v1",
  "name": "weather",
  "description": "查询指定城市当前天气",
  "parameters": {
    "type": "object",
    "properties": { "city": { "type": "string" } },
    "required": ["city"]
  },
  "executor": {
    "type": "http",
    "method": "GET",
    "url": "https://api.example.com/weather?city=${city}",
    "headers": { "Authorization": "Bearer ${env:WEATHER_API_KEY}" },
    "timeoutMs": 10000,
    "responsePath": "data"
  }
}
```

## 安全边界

- http 插件只允许 `https`，且 url 的 host 部分必须是静态值（不允许模板
  占位符，防止模型动态指定 SSRF 目标）；host 必须精确命中
  `PAN_PILOT_PLUGIN_ALLOWED_HOSTS` 白名单（逗号分隔，可含端口）。
  **默认拒绝**：未配置白名单时，http 插件在加载期与安装时都会被拒绝。
- `${env:NAME}` 引用的环境变量名必须命中
  `PAN_PILOT_PLUGIN_ALLOWED_ENV_VARS` 白名单；**默认拒绝全部引用**，
  插件永远读不到任意 `process.env`。密钥值只存在进程环境变量里，不进 manifest。
- http 请求显式 `redirect: "error"`：白名单 host 的 3xx 重定向不会被跟随
  到任意地址/私网。
- 每次请求有超时（默认 10s）与 1MB 响应体上限；响应必须是 JSON。
- 本阶段不支持脚本执行器：manifest 不能携带可执行代码。
- 插件名不能遮蔽内置工具名；同名目录必须用标准的 builtin 自引用。

## 用户安装与管理

Agent 对模型暴露 `list_plugins` 和 `suggest_plugin`：前者只读，后者只把经过
校验的 manifest 放入待安装列表，绝不写盘或启用。用户通过控制台或 HTTP 接口
决定安装或忽略：

```text
GET    /v1/plugins/suggestions               列出待安装建议（脱敏预览）
POST   /v1/plugins/suggestions/:id/install   安装选中的建议
DELETE /v1/plugins/suggestions/:id           忽略建议
POST   /v1/plugins/install                   直接安装 { manifest }
POST   /v1/plugins/:name/enable|disable      直接启停并写回 manifest
POST   /v1/plugins/reload                    原子重载
```

安装采用 create-only 写入，不覆盖同名插件；落盘后重新校验并原子重载，失败会
删除本次新文件并保留旧注册表。未配置 `PAN_PILOT_API_TOKEN` 时所有副作用接口
fail-closed 返回 503。

## 重载语义

- 启动加载为尽力而为：坏插件进入 `GET /v1/plugins` 的错误状态，其余照常生效。
- `POST /v1/plugins/reload` 是原子操作：任一插件失败则整体保留旧注册表，
  执行失败时响应携带本次尝试结果（`applied: false` 与逐插件错误）。
