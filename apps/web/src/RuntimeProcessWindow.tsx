import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type {
  Agent,
  AgentRun,
  AuthorizationDecision,
  RuntimeToolEvent,
  User,
} from "./types";

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
  emptyTimeLabel?: string;
  requests: ProcessRequestDetail[];
}

interface ProcessRequestDetail {
  id: string;
  title: string;
  kind: "actual" | "attempt" | "internal" | "expected";
  command: string | null;
  method: string | null;
  path: string;
  body: Record<string, string> | null;
  response: string;
}

const terminalStatuses = new Set<AgentRun["status"]>(["completed", "failed", "cancelled"]);

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function timeLabel(value: string | null, emptyLabel = "等待中"): string {
  if (!value) return emptyLabel;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function requestForToolEvent(event: RuntimeToolEvent): ProcessRequestDetail {
  const action = event.operation === "assess" ? "process" : event.operation;
  return {
    id: `tool-${event.operation}-${event.occurredAt}`,
    title: `Agent Runtime 已调用 vault.${event.operation}`,
    kind: "attempt",
    command: `node .launchpad/tools/vault.mjs ${event.operation} [REDACTED_ARGUMENTS]`,
    method: event.operation === "list" ? "GET" : "POST",
    path: event.operation === "list"
      ? "/api/runtime/resources"
      : `/api/runtime/resources/${action}`,
    body: event.operation === "list" ? null : { arguments: "[REDACTED]" },
    response: event.status === "failed"
      ? `Runtime 工具退出 ${event.exitCode ?? "unknown"}；没有关联到后端策略决策`
      : "Runtime 工具已结束，但没有关联到后端策略决策",
  };
}

function runStateLabel(status: AgentRun["status"]): string {
  if (status === "queued") return "等待 Runtime";
  if (status === "running") return "后端处理中";
  if (status === "completed") return "处理完成";
  if (status === "cancelled") return "已取消";
  return "处理失败";
}

function requestForDecision(decision: AuthorizationDecision): ProcessRequestDetail {
  const fallbackPath = decision.action === "resource:process"
    ? "/api/runtime/resources/process"
    : decision.action === "resource:disclose"
      ? "/api/runtime/resources/disclose"
      : "/api/runtime/resources/read";
  const fallbackCommand = decision.action === "resource:process"
    ? 'node .launchpad/tools/vault.mjs assess --owner <username> --title "[PROTECTED_TITLE]"'
    : decision.action === "resource:disclose"
      ? 'node .launchpad/tools/vault.mjs disclose --owner <username> [--title "[PROTECTED_TITLE]"]'
      : 'node .launchpad/tools/vault.mjs read --owner <username> --title "[PROTECTED_TITLE]"';
  const evidence = decision.requestEvidence;
  return {
    id: decision.id,
    title: `${decision.executingAgentName ?? "Agent"} 发出的实际请求`,
    kind: "actual",
    command: evidence?.command ?? fallbackCommand,
    method: evidence?.method ?? "POST",
    path: evidence?.path ?? fallbackPath,
    body: evidence?.body ?? {
      ownerUsername: "<username>",
      title: "[PROTECTED_TITLE]",
    },
    response: `${evidence?.responseStatus ?? (decision.decision === "allow" ? 200 : 403)} · ${decision.decision === "allow" ? "ALLOW" : "DENY"} · ${decision.reasonCode}`,
  };
}

function RequestDetails({ requests }: { requests: ProcessRequestDetail[] }) {
  const hasActual = requests.some((request) => request.kind === "actual");
  const attemptCount = requests.filter((request) => request.kind === "attempt").length;
  return (
    <details className="runtime-process-request-details">
      <summary>
        <span>查看请求代码与格式</span>
        <em>{hasActual
          ? `${requests.filter((request) => request.kind === "actual").length} 个实际请求`
          : attemptCount > 0
            ? `${attemptCount} 次 Runtime 尝试`
            : "默认折叠"}</em>
      </summary>
      <div className="runtime-process-request-list">
        {requests.map((request) => (
          <section className={`runtime-process-request request-${request.kind}`} key={request.id}>
            <header>
              <strong>{request.title}</strong>
              <span>{request.kind === "actual"
                ? "实际发生"
                : request.kind === "attempt"
                  ? "Runtime 尝试·无策略证据"
                  : request.kind === "internal"
                    ? "内部调用"
                    : "预期格式·未发生"}</span>
            </header>
            {request.command && <pre><code>{request.command}</code></pre>}
            <div className="runtime-process-http-line">
              {request.method && <b>{request.method}</b>}
              <code>{request.path}</code>
            </div>
            {request.body && <pre><code>{JSON.stringify(request.body, null, 2)}</code></pre>}
            <small>{request.response}</small>
          </section>
        ))}
      </div>
    </details>
  );
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
  const accessDecisions = runDecisions.filter(
    (decision) => decision.action === "resource:read" || decision.action === "resource:process",
  );
  const disclosureDecisions = runDecisions.filter(
    (decision) => decision.action === "resource:disclose",
  );
  const hasDeniedAccess = accessDecisions.some((decision) => decision.decision === "deny");
  const accessRequests = accessDecisions.map(requestForDecision);
  const disclosureRequests = disclosureDecisions.map(requestForDecision);
  const accessToolEvents = (run.runtimeToolEvents ?? []).filter(
    (event) => event.operation === "read" || event.operation === "assess",
  );
  const disclosureToolEvents = (run.runtimeToolEvents ?? []).filter(
    (event) => event.operation === "disclose",
  );
  const requiredAccess = (run.middlewareEvidenceRequirements ?? []).some(
    (requirement) =>
      requirement.action === "resource:read" || requirement.action === "resource:process",
  );
  const requiredDisclosure = (run.middlewareEvidenceRequirements ?? []).some(
    (requirement) => requirement.action === "resource:disclose",
  );
  const evidenceMissing = run.middlewareEvidenceStatus === "missing";

  const stages: ProcessStage[] = [
    {
      id: "accepted",
      title: "请求进入 Launchpad",
      detail: `后端已创建 Run ${shortId(run.id)}，并绑定当前对话。`,
      state: "success",
      time: run.createdAt,
      requests: [{
        id: "accepted-request",
        title: "浏览器提交任务",
        kind: "actual",
        command: `fetch("/api/agents/${agent.id}/messages", { method: "POST", body: JSON.stringify(payload) })`,
        method: "POST",
        path: `/api/agents/${agent.id}/messages`,
        body: { content: "[本次对话内容]", resourceReferences: "[已附加资源引用]" },
        response: `202 Accepted · Run ${shortId(run.id)}`,
      }],
    },
    {
      id: "identity",
      title: "注入运行身份",
      detail: run.startedAt
        ? `${currentUser.displayName} → ${agent.name}；短期凭证仅对当前 Run 有效。`
        : "等待 Runtime 启动并签发当前 Run 的短期凭证。",
      state: run.startedAt ? "success" : "running",
      time: run.startedAt,
      requests: [{
        id: "identity-request",
        title: "Launchpad 启动 Agent Runtime",
        kind: "internal",
        command: "runner.run({ prompt, workspacePath, runtimeEnvironment })",
        method: null,
        path: "AgentRunner.run",
        body: {
          LAUNCHPAD_RUN_ID: shortId(run.id),
          LAUNCHPAD_AGENT_ID: shortId(agent.id),
          LAUNCHPAD_RUNTIME_TOKEN: "[REDACTED_RUN_TOKEN]",
        },
        response: run.startedAt ? "Runtime 已接收运行身份" : "等待 Runtime 启动",
      }],
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
          requests: [{
            id: "grant-request",
            title: "控制面附加临时授权",
            kind: "internal" as const,
            command: "policy.attachRunOrTaskGrant({ resourceId, agentId, scope })",
            method: null,
            path: "Bouncer grant boundary",
            body: { resourceId: "[PROTECTED_RESOURCE_ID]", agentId: shortId(agent.id), scope: "run_or_task" },
            response: grantDecisions.at(-1)?.reasonCode ?? "授权已记录",
          }],
        }]
      : []),
    {
      id: "knowledge",
      title: "私有资料读取或密封处理",
      detail: accessDecisions.length > 0
        ? `Bouncer 已记录 ${accessDecisions.length} 次真实后端访问；${hasDeniedAccess ? "其中存在拒绝。" : "全部允许。"}`
        : accessToolEvents.length > 0
          ? "Agent 已调用 vault，但工具或传输在策略决策前失败；这不是一次授权拒绝。"
        : isTerminal
          ? requiredAccess && evidenceMissing
            ? "证据契约未满足：Run 已结束，但后端没有收到要求的资料读取或密封处理请求。"
            : "本次 Run 没有产生资料读取或密封处理决策；不能把 Agent 正文中的描述视为已完成鉴权。"
          : "等待 Agent 调用受保护资料库；只有抵达后端的请求才会留下权限证据。",
      state: accessDecisions.length > 0
        ? hasDeniedAccess ? "denied" : "success"
        : accessToolEvents.length > 0 || isTerminal && requiredAccess && evidenceMissing
          ? "failed"
          : isTerminal ? "neutral" : "running",
      time: accessDecisions.at(-1)?.occurredAt ?? accessToolEvents.at(-1)?.occurredAt ?? null,
      emptyTimeLabel: isTerminal ? requiredAccess ? "未触发" : "未发生" : undefined,
      requests: accessRequests.length > 0
        ? accessRequests
        : accessToolEvents.length > 0
          ? accessToolEvents.map(requestForToolEvent)
          : [{
        id: "knowledge-expected",
        title: "Agent 资料读取/密封处理格式",
        kind: "expected",
        command: 'node .launchpad/tools/vault.mjs assess --owner <username> --title "[PROTECTED_TITLE]"',
        method: "POST",
        path: "/api/runtime/resources/process",
        body: { ownerUsername: "<username>", title: "[PROTECTED_TITLE]", operation: "launch-risk-check" },
        response: isTerminal ? "本次 Run 未发出该请求" : "等待 Agent 发出请求",
      }],
    },
    {
      id: "disclosure",
      title: "向当前用户披露资料",
      detail: disclosureDecisions.length > 0
        ? disclosureDecisions.some((decision) => decision.decision === "deny")
          ? "Agent 发起了真实披露请求；后端独立鉴权后拒绝向当前用户转发。"
          : "Agent 发起了真实披露请求，当前用户通过独立鉴权。"
        : disclosureToolEvents.length > 0
          ? "Agent 已调用披露工具，但没有形成后端披露策略决策；这不是一次有效拒绝。"
        : isTerminal
          ? requiredDisclosure && evidenceMissing
            ? "证据契约未满足：Agent 没有发起要求的真实披露请求。"
            : "本次 Run 没有发起披露请求。"
          : "若用户要求复制、转发或展示私有资料，Agent 必须调用披露接口。",
      state: disclosureDecisions.length > 0
        ? disclosureDecisions.some((decision) => decision.decision === "deny") ? "denied" : "success"
        : disclosureToolEvents.length > 0 || isTerminal && requiredDisclosure && evidenceMissing
          ? "failed"
          : isTerminal ? "neutral" : "running",
      time: disclosureDecisions.at(-1)?.occurredAt ?? disclosureToolEvents.at(-1)?.occurredAt ?? null,
      emptyTimeLabel: isTerminal ? requiredDisclosure ? "未触发" : "未发生" : undefined,
      requests: disclosureRequests.length > 0
        ? disclosureRequests
        : disclosureToolEvents.length > 0
          ? disclosureToolEvents.map(requestForToolEvent)
          : [{
        id: "disclosure-expected",
        title: "Agent 披露请求格式",
        kind: "expected",
        command: 'node .launchpad/tools/vault.mjs disclose --owner <username> [--title "[PROTECTED_TITLE]"]',
        method: "POST",
        path: "/api/runtime/resources/disclose",
        body: { ownerUsername: "<username>", title: "[可省略或已脱敏]" },
        response: isTerminal ? "本次 Run 未发出该请求" : "等待 Agent 发出请求",
      }],
    },
    {
      id: "result",
      title: "结束运行并销毁凭证",
      detail: run.status === "completed"
        ? run.middlewareEvidenceStatus === "satisfied"
          ? "回复已写入对话，middleware 证据契约已满足，Run 短期凭证已销毁。"
          : "回复已写入对话，Run 短期凭证已销毁。"
        : run.status === "failed"
          ? run.middlewareEvidenceStatus === "missing"
            ? "运行因缺少真实 middleware 证据而失败；凭证已销毁，可从任务页重试该步骤。"
            : "运行失败，Run 短期凭证已销毁。"
          : run.status === "cancelled"
            ? "运行已取消，Run 短期凭证已销毁。"
            : "运行结束后，后端会立即销毁本次短期凭证。",
      state: run.status === "completed"
        ? "success"
        : run.status === "failed" || run.status === "cancelled"
          ? "failed"
          : "running",
      time: run.completedAt,
      requests: [{
        id: "result-request",
        title: "控制面提交运行结果",
        kind: "internal",
        command: "store.mutate(run => finalize(run)); runtimeCredentials.delete(tokenHash)",
        method: null,
        path: "Run finalization",
        body: { status: run.status, output: "[REDACTED_CONVERSATION_OUTPUT]", runtimeToken: "[REVOKED]" },
        response: isTerminal ? `Run ${run.status}` : "等待 Run 结束",
      }],
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
                <header><strong>{stage.title}</strong><time>{timeLabel(stage.time, stage.emptyTimeLabel ?? "等待中")}</time></header>
                <p>{stage.detail}</p>
                {(stage.id === "knowledge" || stage.id === "disclosure") && (
                  <div className="runtime-process-decisions">
                    {(stage.id === "knowledge" ? accessDecisions : disclosureDecisions).map((decision) => (
                      <div className={`runtime-process-decision decision-${decision.decision}`} key={decision.id}>
                        <span>{decision.decision === "allow" ? "允许" : "拒绝"}</span>
                        <strong>{decision.targetLabel}</strong>
                        <code>{decision.reasonCode}</code>
                      </div>
                    ))}
                  </div>
                )}
                <RequestDetails requests={stage.requests} />
              </div>
            </article>
          ))}
        </div>

        <footer className="runtime-process-footer">
          <span>可展开查看脱敏后的实际请求格式</span>
          <strong>不会展示密钥或私有资料内容</strong>
        </footer>
      </div>}
    </aside>
  );
}
