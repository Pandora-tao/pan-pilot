import { CalendarPlus, ChevronDown, ChevronUp, Pause, Pencil, Play, Power, RefreshCw, RotateCcw, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient } from "../../api";
import { Modal } from "../../components/Modal";
import { StatusBadge } from "../../components/StatusBadge";
import { ViewHeader } from "../../components/ViewHeader";
import type {
  ModelsResponse,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTasksResponse,
  TaskSchedule,
} from "../../types";

interface TasksViewProps {
  client: ApiClient;
  modelCatalog: ModelsResponse | null;
  toast: (message: string) => void;
  onCountChange: (count: number) => void;
}

export function TasksView({ client, modelCatalog, toast, onCountChange }: TasksViewProps) {
  const [data, setData] = useState<ScheduledTasksResponse | null>(null);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [editor, setEditor] = useState<ScheduledTask | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);
  const [busy, setBusy] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async (quiet = false) => {
    try {
      const [nextData, nextRuns] = await Promise.all([
        client.scheduledTasks(),
        client.scheduledTaskRuns(undefined, 50),
      ]);
      setData(nextData);
      setRuns(nextRuns);
      onCountChange(nextData.tasks.length);
    } catch (error) {
      if (!quiet) toast("任务状态获取失败：" + errorMessage(error));
    }
  }, [client, onCountChange, toast]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function action(key: string, fn: () => Promise<unknown>, message: string): Promise<boolean> {
    setBusy(key);
    try {
      await fn();
      await refresh(true);
      toast(message);
      return true;
    } catch (error) {
      toast("操作失败：" + errorMessage(error));
      return false;
    } finally {
      setBusy("");
    }
  }

  const timeZone = data?.serverTimeZone ?? "正在读取服务器时区";
  return (
    <section className="view active">
      <ViewHeader
        title="任务"
        description={`按服务器本地时间运行独立 Agent。当前时区：${timeZone}`}
        actions={(
          <>
            <button type="button" onClick={() => void refresh()}>
              <RefreshCw aria-hidden="true" size={16} />刷新
            </button>
            <button className="primary" type="button" onClick={() => setEditor("new")}>
              <CalendarPlus aria-hidden="true" size={16} />新建任务
            </button>
          </>
        )}
      />

      <section className="surface section-stack task-section">
        <div className="section-head">
          <div><h3>计划任务</h3><p>全局串行执行；同一任务不会重叠。</p></div>
          <span className="section-count">{data?.tasks.length ?? 0}</span>
        </div>
        {data?.tasks.length ? (
          <div className="task-grid">
            {data.tasks.map((task) => {
              const active = task.latestRun !== undefined
                && ["queued", "running", "pausing", "paused", "needs_confirmation"]
                  .includes(task.latestRun.status);
              return (
                <article className="task-card" key={task.id}>
                  <div className="task-card-top">
                    <div>
                      <div className="record-name">{task.name}<StatusBadge status={task.enabled ? "available" : "disabled"} label={task.enabled ? "已启用" : "已停用"} /></div>
                      <p className="task-schedule">{scheduleLabel(task.schedule)}</p>
                    </div>
                    {task.latestRun && <StatusBadge status={task.latestRun.status} />}
                  </div>
                  <div className="next-run-label">下次运行</div>
                  <div className="next-run-time">{task.nextRunAt ? formatDate(task.nextRunAt) : "—"}</div>
                  <div className="task-model">模型 · {modelLabel(modelCatalog, task.modelId)}</div>
                  {task.latestRun && (
                    <div className="task-latest">最近结果 · {formatDate(task.latestRun.finishedAt ?? task.latestRun.queuedAt)}{task.latestRun.error ? ` · ${task.latestRun.error}` : ""}</div>
                  )}
                  <div className="item-actions task-actions">
                    {task.latestRun && ["queued", "running"].includes(task.latestRun.status) ? (
                      <button className="small primary" type="button" disabled={busy !== ""} onClick={() => void action(`pause-${task.id}`, () => client.pauseScheduledTaskRun(task.latestRun!.id), `任务 ${task.name} 已请求暂停`)}>
                        <Pause aria-hidden="true" size={14} />暂停运行
                      </button>
                    ) : task.latestRun?.status === "paused" ? (
                      <button className="small primary" type="button" disabled={busy !== ""} onClick={() => void action(`resume-${task.id}`, () => client.resumeScheduledTaskRun(task.latestRun!.id), `任务 ${task.name} 已恢复执行`)}>
                        <Play aria-hidden="true" size={14} />恢复运行
                      </button>
                    ) : (
                      <button className="small primary" type="button" disabled={busy !== "" || active} onClick={() => void action(`run-${task.id}`, () => client.runScheduledTask(task.id), `任务 ${task.name} 已加入队列`)}>
                        <Play aria-hidden="true" size={14} />立即运行
                      </button>
                    )}
                    <button className="small" type="button" disabled={busy !== ""} onClick={() => void action(`toggle-${task.id}`, () => client.setScheduledTaskEnabled(task.id, !task.enabled), `任务已${task.enabled ? "停用" : "启用"}`)}>
                      <Power aria-hidden="true" size={14} />{task.enabled ? "停用" : "启用"}
                    </button>
                    <button className="small" type="button" disabled={busy !== "" || active} onClick={() => setEditor(task)}><Pencil aria-hidden="true" size={14} />编辑</button>
                    <button className="small danger" type="button" disabled={busy !== "" || active} onClick={() => setDeleteTarget(task)}><Trash2 aria-hidden="true" size={14} />删除</button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : <div className="empty-tip">还没有任务。创建后会按服务器时区自动运行。</div>}
      </section>

      <section className="surface section-stack task-section">
        <div className="section-head">
          <div><h3>运行历史</h3><p>全局最近 50 条；结果正文和安全工具摘要可展开查看。</p></div>
          <span className="section-count">{runs.length}</span>
        </div>
        {runs.length ? <div className="run-list">{runs.map((run) => {
          const open = expanded.has(run.id);
          return (
            <article className="run-row" key={run.id}>
              <button className="run-summary" type="button" onClick={() => setExpanded((current) => toggleSet(current, run.id))}>
                <span>{open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
                <strong>{run.task.name}</strong>
                <StatusBadge status={run.status} />
                <span className="run-trigger">{run.trigger === "manual" ? "手动" : "计划"}</span>
                <time>{formatDate(run.finishedAt ?? run.queuedAt)}</time>
              </button>
              {open && (
                <div className="run-detail">
                  <div className="run-facts">
                    <span>模型 {run.model ?? run.task.modelId}</span>
                    {run.steps !== undefined && <span>{run.steps} 步</span>}
                    {run.totalTokens !== undefined && <span>{run.totalTokens} Tokens</span>}
                    {run.context !== undefined && (
                      <span>上下文压缩 {run.context.compactions} 次 · 摘要 {run.context.summarizedMessages} 条</span>
                    )}
                    {run.scheduledFor && <span>计划于 {formatDate(run.scheduledFor)}</span>}
                  </div>
                  {run.error && <div className="record-error">{run.error}</div>}
                  <RunControls run={run} busy={busy !== ""} action={action} client={client} />
                  {run.content && <pre className="run-content">{run.content}</pre>}
                  {run.toolExecutions?.length ? (
                    <div className="tool-list">{run.toolExecutions.map((tool) => <span className={`tool-chip ${tool.status}`} key={`${run.id}-${tool.id}-${tool.name}`}>{tool.name} · {tool.status === "success" ? "成功" : "失败"}</span>)}</div>
                  ) : null}
                </div>
              )}
            </article>
          );
        })}</div> : <div className="empty-tip">还没有运行记录。</div>}
      </section>

      <TaskEditor
        task={editor}
        timeZone={timeZone}
        models={modelCatalog}
        busy={busy !== ""}
        onClose={() => setEditor(null)}
        onSave={(input) => void action("save", () => editor === "new" ? client.createScheduledTask(input) : client.updateScheduledTask(editor!.id, input), editor === "new" ? "任务已创建" : "任务已更新").then((saved) => { if (saved) setEditor(null); })}
      />
      <Modal open={deleteTarget !== null} title="删除任务" onClose={() => setDeleteTarget(null)} footer={(
        <><button type="button" onClick={() => setDeleteTarget(null)}>取消</button><button className="danger" type="button" disabled={busy !== ""} onClick={() => deleteTarget && void action("delete", () => client.deleteScheduledTask(deleteTarget.id), `任务 ${deleteTarget.name} 已删除`).then((deleted) => { if (deleted) setDeleteTarget(null); })}>确认删除</button></>
      )}><p>删除后不会再触发，已有运行历史仍会保留。</p></Modal>
    </section>
  );
}

function RunControls({
  run,
  busy,
  action,
  client,
}: {
  run: ScheduledTaskRun;
  busy: boolean;
  action: (key: string, fn: () => Promise<unknown>, message: string) => Promise<boolean>;
  client: ApiClient;
}) {
  if (run.status === "queued" || run.status === "running") {
    return (
      <div className="item-actions task-actions">
        <button className="small" type="button" disabled={busy} onClick={() => void action(`pause-${run.id}`, () => client.pauseScheduledTaskRun(run.id), "任务已请求暂停；当前步骤完成后生效") }>
          <Pause aria-hidden="true" size={14} />暂停
        </button>
      </div>
    );
  }
  if (run.status === "paused") {
    return (
      <div className="item-actions task-actions">
        <button className="small primary" type="button" disabled={busy} onClick={() => void action(`resume-${run.id}`, () => client.resumeScheduledTaskRun(run.id), "任务已从检查点恢复") }>
          <Play aria-hidden="true" size={14} />恢复
        </button>
      </div>
    );
  }
  if (run.status === "needs_confirmation") {
    return (
      <div className="item-actions task-actions">
        <button className="small danger" type="button" disabled={busy} title="可能重复执行中断时的工具" onClick={() => void action(`retry-${run.id}`, () => client.resolveScheduledTaskRunRecovery(run.id, "retry"), "任务已从上一个安全检查点重试") }>
          <RotateCcw aria-hidden="true" size={14} />确认重试
        </button>
        <button className="small" type="button" disabled={busy} onClick={() => void action(`terminate-${run.id}`, () => client.resolveScheduledTaskRunRecovery(run.id, "terminate"), "任务已终止") }>
          <Square aria-hidden="true" size={14} />终止
        </button>
      </div>
    );
  }
  return null;
}

function TaskEditor({ task, timeZone, models, busy, onClose, onSave }: {
  task: ScheduledTask | "new" | null;
  timeZone: string;
  models: ModelsResponse | null;
  busy: boolean;
  onClose: () => void;
  onSave: (input: ScheduledTaskInput) => void;
}) {
  const initial = useMemo(() => task && task !== "new" ? toInput(task) : defaultInput(models), [models, task]);
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  if (!task) return null;
  const availableModels = models?.models.filter((model) => model.status === "available") ?? [];
  return (
    <Modal open title={task === "new" ? "新建任务" : "编辑任务"} onClose={onClose} footer={(
      <><button type="button" onClick={onClose}>取消</button><button className="primary" type="button" disabled={busy || !draft.name.trim() || !draft.prompt.trim() || !draft.modelId} onClick={() => onSave(draft)}>保存任务</button></>
    )}>
      <form className="task-form" onSubmit={(event) => event.preventDefault()}>
        <div className="time-zone-note">所有时间按服务器时区 <strong>{timeZone}</strong> 解释。</div>
        <label className="field"><span>名称</span><input value={draft.name} maxLength={200} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="field"><span>提示词</span><textarea value={draft.prompt} maxLength={10_000} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} placeholder="描述到点后 Agent 要完整执行的工作" /></label>
        <label className="field"><span>模型</span><select value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}>{availableModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
        <label className="field"><span>规则类型</span><select value={draft.schedule.type} onChange={(event) => setDraft({ ...draft, schedule: defaultSchedule(event.target.value as TaskSchedule["type"]) })}><option value="once">单次</option><option value="daily">每天</option><option value="weekly">每周</option><option value="cron">Cron</option></select></label>
        <ScheduleFields schedule={draft.schedule} onChange={(schedule) => setDraft({ ...draft, schedule })} />
        <label className="check-field"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />创建后立即启用</label>
      </form>
    </Modal>
  );
}

function ScheduleFields({ schedule, onChange }: { schedule: TaskSchedule; onChange: (schedule: TaskSchedule) => void }) {
  if (schedule.type === "once") return <label className="field"><span>服务器本地时间</span><input type="datetime-local" value={schedule.at} onChange={(event) => onChange({ ...schedule, at: event.target.value })} /></label>;
  if (schedule.type === "daily") return <label className="field"><span>每天时间</span><input type="time" value={schedule.time} onChange={(event) => onChange({ ...schedule, time: event.target.value })} /></label>;
  if (schedule.type === "weekly") return <div className="schedule-pair"><label className="field"><span>星期</span><select value={schedule.weekday} onChange={(event) => onChange({ ...schedule, weekday: Number(event.target.value) })}>{["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((label, value) => <option key={label} value={value}>{label}</option>)}</select></label><label className="field"><span>时间</span><input type="time" value={schedule.time} onChange={(event) => onChange({ ...schedule, time: event.target.value })} /></label></div>;
  return <label className="field"><span>五字段 Cron（分 时 日 月 周）</span><input value={schedule.expression} onChange={(event) => onChange({ ...schedule, expression: event.target.value })} placeholder="0 9 * * 1-5" /></label>;
}

function defaultInput(models: ModelsResponse | null): ScheduledTaskInput { return { name: "", prompt: "", modelId: models?.models.find((model) => model.status === "available")?.id ?? "", enabled: true, schedule: defaultSchedule("daily") }; }
function toInput(task: ScheduledTask): ScheduledTaskInput { return { name: task.name, prompt: task.prompt, modelId: task.modelId, enabled: task.enabled, schedule: structuredClone(task.schedule) }; }
function defaultSchedule(type: TaskSchedule["type"]): TaskSchedule { if (type === "once") return { type, at: "" }; if (type === "daily") return { type, time: "09:00" }; if (type === "weekly") return { type, weekday: 1, time: "09:00" }; return { type, expression: "0 9 * * 1-5" }; }
function scheduleLabel(schedule: TaskSchedule): string { if (schedule.type === "once") return `单次 · ${schedule.at}`; if (schedule.type === "daily") return `每天 · ${schedule.time}`; if (schedule.type === "weekly") return `${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][schedule.weekday]} · ${schedule.time}`; return `Cron · ${schedule.expression}`; }
function modelLabel(models: ModelsResponse | null, id: string): string { return models?.models.find((model) => model.id === id)?.label ?? id; }
function formatDate(value: string): string { return new Date(value).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function toggleSet(current: Set<string>, id: string): Set<string> { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
