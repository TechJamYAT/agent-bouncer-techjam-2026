import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Agent, AgentRun, AuthorizationDecision, User } from "./types";

interface RuntimeProcessWindowProps {
  agent: Agent;
  currentUser: User;
  run: AgentRun;
  decisions: AuthorizationDecision[];
  onClose: () => void;
  onRefresh: () => void;
}

type ProcessState = "running" | "success" | "denied" | "failed" | "neutral";

interface ProcessStage {
  id: string;
  title: string;
  detail: string;
  state: ProcessState;
  time: string | null;
}

const terminalStatuses = new Set<AgentRun["status"]>(["completed", "failed", "cancelled"]);

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function timeLabel(value: string | null): string {
  if (!value) return "等待中";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function runStateLabel(status: AgentRun["status"]): string {
  if (status === "queued") return "等待 Runtime";
  if (status === "running") return "后端处理中";
  if (status === "completed") return "处理完成";
  if (status === "cancelled") return "已取消";
  return "处理失败";
}

export function RuntimeProcessWindow({
  agent,
  currentUser,
  run,
  decisions,
  onClose,
  onRefresh,
}: RuntimeProcessWindowProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState(() => ({
    x: Math.max(12, window.innerWidth - 454),
    y: 110,
  }));
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const isTerminal = terminalStatuses.has(run.status);
  const runDecisions = decisions
    .filter((decision) => decision.runId === run.id)
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const grantDecisions = runDecisions.filter(
    (decision) => decision.action === "grant:create" || decision.action === "grant:revoke",
  );
  const readDecisions = runDecisions.filter((decision) => decision.action === "resource:read");
  const hasDeniedRead = readDecisions.some((decision) => decision.decision === "deny");

  const stages: ProcessStage[] = [
    {
      id: "accepted",
      title: "请求进入 Launchpad",
      detail: `后端已创建 Run ${shortId(run.id)}，并绑定当前对话。`,
      state: "success",
      time: run.createdAt,
    },
    {
      id: "identity",
      title: "注入运行身份",
      detail: run.startedAt
        ? `${currentUser.displayName} → ${agent.name}；短期凭证仅对当前 Run 有效。`
        : "等待 Runtime 启动并签发当前 Run 的短期凭证。",
      state: run.startedAt ? "success" : "running",
      time: run.startedAt,
    },
    ...(grantDecisions.some((decision) => decision.action === "grant:create")
      ? [{
          id: "grant",
          title: "附加资料授权",
          detail: grantDecisions.some((decision) => decision.action === "grant:revoke")
            ? "本次运行的临时资料授权已撤销。"
            : "资料所有者已授予仅限本次运行的读取权限。",
          state: "success" as const,
          time: grantDecisions.at(-1)?.occurredAt ?? null,
        }]
      : []),
    {
      id: "knowledge",
      title: "资料库访问与策略判断",
      detail: readDecisions.length > 0
        ? `Bouncer 已记录 ${readDecisions.length} 次读取判断；${hasDeniedRead ? "其中存在拒绝。" : "全部允许。"}`
        : isTerminal
          ? "后端未收到资料库读取请求；不能把 Agent 正文中的尝试描述视为已完成鉴权。"
          : "等待 Agent 调用受保护资料库；只有抵达后端的请求才会留下权限证据。",
      state: readDecisions.length > 0
        ? hasDeniedRead ? "denied" : "success"
        : isTerminal ? "neutral" : "running",
      time: readDecisions.at(-1)?.occurredAt ?? null,
    },
    {
      id: "result",
      title: "结束运行并销毁凭证",
      detail: run.status === "completed"
        ? "回复已写入对话，Run 短期凭证已销毁。"
        : run.status === "failed"
          ? "运行失败，Run 短期凭证已销毁。"
          : run.status === "cancelled"
            ? "运行已取消，Run 短期凭证已销毁。"
            : "运行结束后，后端会立即销毁本次短期凭证。",
      state: run.status === "completed"
        ? "success"
        : run.status === "failed" || run.status === "cancelled"
          ? "failed"
          : "running",
      time: run.completedAt,
    },
  ];

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const width = Math.min(430, window.innerWidth - 24);
    setPosition({
      x: Math.min(
        Math.max(12, window.innerWidth - width - 12),
        Math.max(12, drag.current.originX + event.clientX - drag.current.startX),
      ),
      y: Math.min(
        Math.max(12, window.innerHeight - 88),
        Math.max(12, drag.current.originY + event.clientY - drag.current.startY),
      ),
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  return (
    <aside
      className={`runtime-process-window ${collapsed ? "is-collapsed" : ""}`}
      style={{ left: position.x, top: position.y }}
      role="dialog"
      aria-modal="false"
      aria-label="后端执行过程"
    >
      <header
        className="runtime-process-handle"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div>
          <span className="eyebrow">LIVE BACKEND TRACE · 拖动移动</span>
          <h2>后端执行过程</h2>
        </div>
        <span className={`runtime-process-status status-${run.status}`}>
          <i />{runStateLabel(run.status)}
        </span>
        <div className="runtime-process-actions">
          <button type="button" onClick={onRefresh} title="刷新后端过程">↻</button>
          <button type="button" onClick={() => setCollapsed((value) => !value)} title={collapsed ? "展开" : "收起"}>
            {collapsed ? "▢" : "—"}
          </button>
          <button type="button" onClick={onClose} aria-label="关闭后端过程">×</button>
        </div>
      </header>

      {!collapsed && <div className="runtime-process-body">
        <div className="runtime-process-boundary">
          <span>运行边界</span>
          <strong>{currentUser.displayName} → {agent.name}</strong>
          <code>Run {shortId(run.id)} · bouncer-v1</code>
        </div>

        <div className="runtime-process-timeline">
          {stages.map((stage) => (
            <article className={`runtime-process-stage stage-${stage.state}`} key={stage.id}>
              <span className="runtime-process-node" aria-hidden="true" />
              <div>
                <header><strong>{stage.title}</strong><time>{timeLabel(stage.time)}</time></header>
                <p>{stage.detail}</p>
                {stage.id === "knowledge" && readDecisions.length > 0 && (
                  <div className="runtime-process-decisions">
                    {readDecisions.map((decision) => (
                      <div className={`runtime-process-decision decision-${decision.decision}`} key={decision.id}>
                        <span>{decision.decision === "allow" ? "允许" : "拒绝"}</span>
                        <strong>{decision.targetLabel}</strong>
                        <code>{decision.reasonCode}</code>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>

        <footer className="runtime-process-footer">
          <span>仅展示后端状态、主体和决策结果</span>
          <strong>不会展示密钥或私有资料内容</strong>
        </footer>
      </div>}
    </aside>
  );
}
