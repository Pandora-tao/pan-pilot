/**
 * 对外声明当前 Agent 真正支持的能力。
 *
 * `reserved` 表示协议位置已经预留，但服务端还没有实现对应能力；
 * 客户端因此可以提前识别边界，而不是通过调用失败来猜测。
 */
export const agentCapabilities = {
  apiVersion: "v1",
  capabilities: {
    chat: {
      status: "available",
      // /v1/chat 的 stream: true 已实现为 SSE 输出。
      streaming: true,
      contextManagement: true,
      contextCompaction: true,
    },
    tools: {
      // 工具白名单已接入 ChatAgent 循环，/v1/chat 会执行注册的工具。
      status: "available",
    },
    files: {
      // 支持上传 .docx、Agent 编辑后下载修改版文件。
      status: "available",
    },
    media: {
      // 图片已通过真实 Coding Plan 端点验收。音频代码路径已实现，但当前
      // 账号尚未开通标准方舟音频模型，不能将其声明为运行态可用。
      // document/text 表示 read_attachment 可提取 docx/pdf 与文本正文。
      status: "available",
      image: { status: "available" },
      audio: {
        status: "blocked",
        reason: "volcengine_audio_model_not_activated",
      },
      document: { status: "available" },
      text: { status: "available" },
    },
    search: {
      // web_search 工具已接入工具循环（默认 Bing 网页搜索，无 Key）。
      status: "available",
    },
    plugins: {
      // Agent 只生成插件建议；用户可在控制台直接安装、启停和重载。
      status: "available",
      userManaged: true,
      suggestions: true,
    },
    scheduledTasks: {
      status: "available",
      persistence: true,
      pauseResume: true,
      safeCheckpointRecovery: true,
    },
    memory: {
      status: "reserved",
    },
    planning: {
      status: "reserved",
    },
  },
} as const;
