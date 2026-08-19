/**
 * 轻量统一 diff 生成（纯 JS，无外部依赖）。
 *
 * 用于写入 / 编辑 / 补丁执行前的授权预览。超大输入退化为摘要 diff，
 * 保证预览有界，避免把整个文件内容送进授权请求。
 */

export interface DiffOptions {
  /** diff 预览最大行数；超过则截断并标记 truncated。 */
  maxPreviewLines?: number;
  /** 参与 LCS 计算的最大输入行数；超过则退回摘要 diff。 */
  maxComputeLines?: number;
}

const DEFAULT_MAX_PREVIEW_LINES = 200;
const DEFAULT_MAX_COMPUTE_LINES = 1500;

/**
 * 生成 unified-style diff 预览文本。
 * oldContent/newContent 以换行拆行比较；返回空串表示无差异。
 */
export function generateUnifiedDiff(
  pathLabel: string,
  oldContent: string,
  newContent: string,
  options: DiffOptions = {},
): string {
  const maxPreviewLines = options.maxPreviewLines ?? DEFAULT_MAX_PREVIEW_LINES;
  const maxComputeLines = options.maxComputeLines ?? DEFAULT_MAX_COMPUTE_LINES;
  const before = splitLines(oldContent);
  const after = splitLines(newContent);

  if (before.length === 0 && after.length === 0) return "";

  // 新增 / 删除 / 大文件：生成有界摘要，避免预览过大。
  if (before.length > maxComputeLines || after.length > maxComputeLines) {
    return buildSummaryDiff(pathLabel, before, after);
  }

  const ops = diffLines(before, after);
  if (ops.every((op) => op.kind === "equal")) return "";

  const { oldStart, newStart, oldCount, newCount } = hunkSpan(ops);
  const lines: string[] = [
    `--- a/${pathLabel}`,
    `+++ b/${pathLabel}`,
    `@@ -${span(oldStart, oldCount)} +${span(newStart, newCount)} @@`,
  ];
  let truncated = false;
  let emitted = 0;
  for (const op of ops) {
    if (emitted >= maxPreviewLines) {
      truncated = true;
      break;
    }
    const marker = op.kind === "equal" ? " " : op.kind === "add" ? "+" : "-";
    lines.push(marker + op.text);
    emitted += 1;
  }

  if (truncated) lines.push(`…（diff 过长，仅显示前 ${emitted} 行）`);
  return lines.join("\n");
}

interface DiffOp {
  kind: "equal" | "add" | "remove";
  text: string;
}

/** 基于 LCS 的行级 diff（O(n*m)），返回 add/remove/equal 操作序列。 */
function diffLines(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  // dp[i][j] = before[i..] 与 after[j..] 的最长公共子序列长度。
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = before[i] === after[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: "equal", text: before[i]! });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      ops.push({ kind: "remove", text: before[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", text: after[j]! });
      j += 1;
    }
  }
  while (i < n) ops.push({ kind: "remove", text: before[i++]! });
  while (j < m) ops.push({ kind: "add", text: after[j++]! });
  return ops;
}

/** 计算整个操作序列覆盖的 hunk 起始与计数。 */
function hunkSpan(ops: DiffOp[]): {
  oldStart: number;
  newStart: number;
  oldCount: number;
  newCount: number;
} {
  let oldStart = 1;
  let newStart = 1;
  let seen = false;
  for (const op of ops) {
    if (op.kind === "equal") {
      if (!seen) {
        oldStart += 1;
        newStart += 1;
      }
    } else {
      seen = true;
    }
  }
  const oldCount = ops.filter((op) => op.kind !== "add").length;
  const newCount = ops.filter((op) => op.kind !== "remove").length;
  return { oldStart, newStart, oldCount, newCount };
}

function span(start: number, count: number): string {
  if (count === 0) return `${start - 1},0`;
  if (count === 1) return String(start);
  return `${start},${count}`;
}

/** 大文件 / 纯新增 / 纯删除时的摘要 diff。 */
function buildSummaryDiff(
  pathLabel: string,
  before: string[],
  after: string[],
): string {
  const head = (lines: string[], n: number) =>
    lines.slice(0, n).map((line) => line).join("\n");
  const lines: string[] = [`--- a/${pathLabel}`, `+++ b/${pathLabel}`];
  if (before.length === 0) {
    lines.push(`+ 新增文件（${after.length} 行）`, head(after, 20));
  } else if (after.length === 0) {
    lines.push(`- 删除文件（原 ${before.length} 行）`, head(before, 20));
  } else {
    lines.push(`- 原文件 ${before.length} 行`, `+ 新文件 ${after.length} 行`);
    lines.push("…（文件过大，预览省略，仅展示首部）");
    if (before.length > 0) lines.push(head(before, 8));
    lines.push("…");
    if (after.length > 0) lines.push(head(after, 8));
  }
  return lines.join("\n");
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.replace(/\r\n?/g, "\n").split("\n");
}
