import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "./i18n";
import type { Agent, AgentRun, AuthorizationDecision, User } from "./types";

interface AuthorizationEvidenceWindowProps {
  agent: Agent;
  currentUser: User;
  decisions: AuthorizationDecision[];
  runs: AgentRun[];
  onClose: () => void;
  onRefresh: () => void;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function actionLabel(action: string, t: (zh: string, en: string) => string): string {
  if (action === "resource:read") return t("读取资源", "Read resource");
  if (action === "resource:process") return t("密封处理", "Sealed process");
  if (action === "resource:disclose") return t("当前对话原文交付", "Disclose to conversation");
  if (action === "resource:forward") return t("转发资料", "Forward resource");
  if (action === "grant:create") return t("授予权限", "Grant access");
  if (action === "grant:revoke") return t("撤销权限", "Revoke access");
  return action;
}

export function AuthorizationEvidenceWindow({
  agent,
  currentUser,
  decisions,
  runs,
  onClose,
  onRefresh,
}: AuthorizationEvidenceWindowProps) {
  const { t } = useI18n();
  const [position, setPosition] = useState(() => ({
    x: Math.max(16, window.innerWidth - 610),
    y: 92,
  }));
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const allows = decisions.filter((item) => item.decision === "allow").length;
  const denies = decisions.filter((item) => item.decision === "deny").length;
  const runtimeDecisions = decisions.filter(
    (item) => ["resource:read", "resource:process", "resource:disclose", "resource:forward"].includes(item.action) &&
      item.runId !== null,
  ).length;

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
    const width = Math.min(580, window.innerWidth - 24);
    const maxX = Math.max(12, window.innerWidth - width - 12);
    const maxY = Math.max(12, window.innerHeight - 110);
    setPosition({
      x: Math.min(maxX, Math.max(12, drag.current.originX + event.clientX - drag.current.startX)),
      y: Math.min(maxY, Math.max(12, drag.current.originY + event.clientY - drag.current.startY)),
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  return (
    <aside
      className="authorization-evidence-window"
      style={{ left: position.x, top: position.y }}
      role="dialog"
      aria-modal="false"
      aria-label={t("权限证据", "Authorization evidence")}
    >
      <header
        className="authorization-evidence-handle"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div>
          <span className="eyebrow">BOUNCER MIDDLEWARE · {t("拖动此处移动", "DRAG TO MOVE")}</span>
          <h2>{t("权限证据", "Authorization evidence")}</h2>
        </div>
        <div className="authorization-evidence-actions">
          <button type="button" onClick={onRefresh} title={t("刷新权限证据", "Refresh authorization evidence")}>↻</button>
          <button type="button" onClick={onClose} aria-label={t("关闭权限证据", "Close authorization evidence")}>×</button>
        </div>
      </header>

      <div className="authorization-evidence-summary">
        <div><span>{t("人类主体", "Human principal")}</span><strong>{currentUser.displayName}</strong><code>@{currentUser.username}</code></div>
        <span className="authorization-evidence-arrow">→</span>
        <div><span>{t("Agent 主体", "Agent principal")}</span><strong>{agent.name}</strong><code>{shortId(agent.id)}</code></div>
      </div>

      <div className="authorization-evidence-counts">
        <span className="evidence-allow">{t(`${allows} 次允许`, `${allows} allowed`)}</span>
        <span className="evidence-deny">{t(`${denies} 次拒绝`, `${denies} denied`)}</span>
        <span className="evidence-runtime">{t(`${runtimeDecisions} 次 Runtime 调用`, `${runtimeDecisions} Runtime calls`)}</span>
        <small>{t("策略 bouncer-v1 · 后端强制执行", "Policy bouncer-v1 · backend enforced")}</small>
      </div>

      <div className="authorization-evidence-list">
        {decisions.length > 0 ? decisions.map((decision) => {
          const run = decision.runId
            ? runs.find((item) => item.id === decision.runId) ?? null
            : null;
          const origin = ["resource:read", "resource:process", "resource:disclose", "resource:forward"].includes(decision.action)
            ? decision.runId ? t("Runtime 工具", "Runtime tool") : t("控制面测试", "Control-plane test")
            : decision.taskId ? t("任务授权流程", "Task authorization flow") : t("控制面授权流程", "Control-plane authorization flow");
          const credentialActive = run?.status === "queued" || run?.status === "running";
          return <article className={`authorization-evidence-card evidence-card-${decision.decision}`} key={decision.id}>
            <div className="authorization-evidence-card-head">
              <span>{actionLabel(decision.action, t)}</span>
              <strong>{decision.decision === "allow" ? t("允许", "Allow") : t("拒绝", "Deny")}</strong>
            </div>
            <h3>{decision.targetLabel}</h3>
            <p>
              {decision.initiatingHumanName} → {decision.executingAgentName ?? t("平台", "Platform")}
              {decision.targetOwnerName ? t(` · 资源主体：${decision.targetOwnerName}`, ` · resource principal: ${decision.targetOwnerName}`) : ""}
            </p>
            <div className="authorization-evidence-context">
              <span>{origin}</span>
              {decision.runId && <code>Run {shortId(decision.runId)}</code>}
              {run && <span className={`run-status run-status-${run.status}`}>{run.status}</span>}
              {run && <span className={`credential-state credential-state-${credentialActive ? "active" : "destroyed"}`}>
                {credentialActive ? t("短期凭证生效中", "Short-lived credential active") : t("短期凭证已销毁", "Short-lived credential destroyed")}
              </span>}
              {decision.taskId && <code>Task {shortId(decision.taskId)}</code>}
            </div>
            <footer>
              <code>{decision.reasonCode}</code>
              <time>{new Date(decision.occurredAt).toLocaleString()}</time>
            </footer>
          </article>
        }) : (
          <div className="authorization-evidence-empty">
            <strong>{t("还没有权限证据", "No authorization evidence yet")}</strong>
            <p>{t("让 Agent 读取一份私人资料，允许或拒绝的后端决定会出现在这里。", "Ask an Agent to access a private resource; the backend allow or deny decision will appear here.")}</p>
          </div>
        )}
      </div>
    </aside>
  );
}
