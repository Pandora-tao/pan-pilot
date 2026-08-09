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
- `enabled`：默认 `true`；运行时可用 `/v1/plugins/:name/disable|enable` 切换，
  状态只保存在内存，重启后回到 manifest 默认值。

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
  **默认拒绝**：未配置白名单时，http 插件在加载期与草案期都会被拒绝。
- `${env:NAME}` 引用的环境变量名必须命中
  `PAN_PILOT_PLUGIN_ALLOWED_ENV_VARS` 白名单；**默认拒绝全部引用**，
  插件永远读不到任意 `process.env`。密钥值只存在进程环境变量里，不进 manifest。
- http 请求显式 `redirect: "error"`：白名单 host 的 3xx 重定向不会被跟随
  到任意地址/私网。
- 每次请求有超时（默认 10s）与 1MB 响应体上限；响应必须是 JSON。
- 本阶段不支持脚本执行器：manifest 不能携带可执行代码。
- 插件名不能遮蔽内置工具名；同名目录必须用标准的 builtin 自引用。

## Agent 自服务闭环（审批）

Agent 对模型暴露三个管理工具（同属声明式插件，见 `plugins/list_plugins`、
`plugins/create_plugin` 与 `plugins/reload_plugins`）：

- `list_plugins`：只读返回脱敏插件状态，不需要审批；
- `create_plugin`：只校验并规范化 manifest，生成待审批草案
  （approvalId / 内容哈希 / 有效期 / 预览与风险摘要），**不落盘、不启用**。
- `reload_plugins`：只创建全量重载审批草案（绑定当前插件目录快照），
  绝不直接重载。

批准与执行只走受鉴权 HTTP API，模型没有批准自己的工具：

```text
POST /v1/plugins/approvals                   创建草案 { action }
GET  /v1/plugins/approvals                   列出审批（脱敏预览）
POST /v1/plugins/approvals/:id/approve       批准（必须带 64 位动作哈希）
POST /v1/plugins/approvals/:id/reject        拒绝/取消
POST /v1/plugins/approvals/:id/execute       一次性执行（必须带哈希 + 未过期）
```

安全约束：

- approve/execute 的 hash 缺失或格式错误返回 400，与动作哈希不符返回 409；
- 审批动作在存储边界深拷贝隔离（调用方拿不到内部引用），且批准/执行前
  服务会重新哈希动作本体，任何篡改都会在批准/执行时被拒绝；
- 未配置 `PAN_PILOT_API_TOKEN` 时 approve/reject/execute 返回 503
  （fail-closed），匿名只能创建草案，无法批准或执行任何动作；
- create 与 reload 草案都绑定创建时的插件目录快照哈希、启停草案绑定目标
  插件 manifest 指纹：批准后目录/内容发生变化会在执行前被拒绝
  （`PLUGIN_DIR_CHANGED`），create/reload 的全量重载不会顺带加载
  批准后换入的插件。
- 所有插件变更执行共用进程内全局互斥锁：不同审批不会交错进入
  「快照校验 → 写入 → 重载」临界区，另一个审批正在执行时返回 409
  `APPROVAL_CONCURRENT`。

支持的动作（`action` 的 discriminated union）：

- `{ "type": "create_plugin", "manifest": {...} }`：新建插件；
- `{ "type": "reload_plugins" }`：全量重载并原子重建注册表；
- `{ "type": "set_plugin_enabled", "plugin": "<name>", "enabled": true|false }`：
  运行时启停（仅内存态）。

执行语义：

- create_plugin 只写入 `PAN_PILOT_PLUGINS_DIR/<name>/manifest.json`，create-only
  不覆盖；临时文件 + 原子建链，防路径穿越与 TOCTOU；重载失败自动回滚新文件并
  保留旧注册表；
- 审批绑定不可变的规范化动作哈希：批准/执行时哈希不符、已拒绝、已过期、
  已执行（重放）都会被拒绝；同一 id 的并发执行只有一个成功；
- 审批记录保存在进程内存（`ApprovalStore` 接口），重启后全部失效，需要
  重新创建草案。

`POST /v1/plugins/reload` 与 `/v1/plugins/:name/enable|disable` 是兼容入口，
现在只创建对应草案，不再直接生效。

## 重载语义

- 启动加载为尽力而为：坏插件进入 `GET /v1/plugins` 的错误状态，其余照常生效。
- `POST /v1/plugins/reload` 是原子操作：任一插件失败则整体保留旧注册表，
  执行失败时响应携带本次尝试结果（`applied: false` 与逐插件错误）。
