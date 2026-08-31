import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "./i18n";
import type {
  AccessRequest,
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
  accessRequests: AccessRequest[];
  onClose: () => void;
  onRefresh: () => void;
}

type ProcessState = "running" | "waiting" | "success" | "denied" | "failed" | "neutral";

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

function timeLabel(value: string | null, emptyLabel: string): string {
  if (!value) return emptyLabel;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function requestForToolEvent(
  event: RuntimeToolEvent,
  t: (zh: string, en: string) => string,
): ProcessRequestDetail {
  const action = event.operation === "assess"
    ? "process"
    : event.operation === "request-forward"
      ? "forward-request"
      : event.operation;
  return {
    id: `tool-${event.operation}-${event.occurredAt}`,
    title: t(`Agent Runtime 已调用 vault.${event.operation}`, `Agent Runtime called vault.${event.operation}`),
    kind: "attempt",
    command: `node .launchpad/tools/vault.mjs ${event.operation} [REDACTED_ARGUMENTS]`,
    method: event.operation === "list" ? "GET" : "POST",
    path: event.operation === "list"
      ? "/api/runtime/resources"
      : `/api/runtime/resources/${action}`,
    body: event.operation === "list" ? null : { arguments: "[REDACTED]" },
    response: event.status === "failed"
      ? t(`Runtime 工具退出 ${event.exitCode ?? "unknown"}；没有关联到后端策略决策`, `Runtime tool exited ${event.exitCode ?? "unknown"}; no backend policy decision was linked`)
      : t("Runtime 工具已结束，但没有关联到后端策略决策", "Runtime tool finished without a linked backend policy decision"),
  };
}

function runStateLabel(run: AgentRun, t: (zh: string, en: string) => string): string {
  if (run.middlewareEvidenceStatus === "satisfied") return t("证据已满足", "Evidence satisfied");
  if (run.middlewareEvidenceStatus === "missing") return t("证据缺失", "Evidence missing");
  if (run.status === "queued") return t("等待 Runtime", "Waiting for Runtime");
  if (run.status === "running") return t("后端处理中", "Backend processing");
  if (run.status === "waiting_for_approval") return t("等待人工审批", "Waiting for approval");
  if (run.status === "completed") return t("运行完成", "Run completed");
  if (run.status === "cancelled") return t("已取消", "Cancelled");
  return t("处理失败", "Failed");
}

function requestForDecision(
  decision: AuthorizationDecision,
  t: (zh: string, en: string) => string,
  linkedRequest?: AccessRequest,
): ProcessRequestDetail {
  const fallbackPath = decision.action === "resource:list"
    ? "/api/runtime/resources/catalog"
    : decision.action === "resource:process"
    ? "/api/runtime/resources/process"
    : decision.action === "resource:forward"
      ? "/api/runtime/resources/forward"
    : decision.action === "resource:disclose"
      ? "/api/runtime/resources/disclose"
      : "/api/runtime/resources/read";
  const fallbackCommand = decision.action === "resource:list"
    ? "node .launchpad/tools/vault.mjs list --owner <current username>"
    : decision.action === "resource:process"
    ? 'node .launchpad/tools/vault.mjs assess --owner <username> --title "[PROTECTED_TITLE]"'
    : decision.action === "resource:forward"
      ? 'node .launchpad/tools/vault.mjs forward --owner <username> --title "[PROTECTED_TITLE]" --recipient <username>'
    : decision.action === "resource:disclose"
      ? 'node .launchpad/tools/vault.mjs disclose --owner <username> [--title "[PROTECTED_TITLE]"]'
      : 'node .launchpad/tools/vault.mjs read --owner <username> --title "[PROTECTED_TITLE]"';
  const evidence = decision.requestEvidence;
  return {
    id: decision.id,
    title: t(`${decision.executingAgentName ?? "Agent"} 发出的实际请求`, `Actual request from ${decision.executingAgentName ?? "Agent"}`),
    kind: "actual",
    command: evidence?.command ?? fallbackCommand,
    method: evidence?.method ?? "POST",
    path: evidence?.path ?? fallbackPath,
    body: evidence?.body ?? {
      ownerUsername: "<username>",
      title: "[PROTECTED_TITLE]",
    },
    response: linkedRequest
      ? `202 · APPROVAL REQUIRED · ${decision.reasonCode}`
      : `${evidence?.responseStatus ?? (decision.decision === "allow" ? 200 : 403)} · ${decision.decision === "allow" ? "ALLOW" : "DENY"} · ${decision.reasonCode}`,
  };
}

function workflowState(
  decisions: AuthorizationDecision[],
  requests: AccessRequest[],
  run: AgentRun,
): ProcessState | null {
  const pending = requests.find((request) => request.status === "pending");
  if (pending) return "waiting";

  const linkedDecisionIds = new Set(requests.map((request) => request.sourceDecisionId));
  const events: Array<{ at: string; state: ProcessState }> = [];
  for (const decision of decisions) {
    if (decision.decision === "allow") {
      events.push({ at: decision.occurredAt, state: "success" });
    } else if (!linkedDecisionIds.has(decision.id)) {
      events.push({ at: decision.occurredAt, state: "denied" });
    }
  }
  for (const request of requests) {
    if (request.status === "rejected" || request.status === "expired") {
      events.push({ at: request.resolvedAt ?? request.requestedAt, state: "denied" });
    } else if (request.status === "approved") {
      events.push({
        at: request.resolvedAt ?? request.requestedAt,
        state: terminalStatuses.has(run.status) ? "failed" : "running",
      });
    }
  }
  return events.sort((left, right) => left.at.localeCompare(right.at)).at(-1)?.state ?? null;
}

function RequestDetails({ requests }: { requests: ProcessRequestDetail[] }) {
  const { t } = useI18n();
  const hasActual = requests.some((request) => request.kind === "actual");
  const attemptCount = requests.filter((request) => request.kind === "attempt").length;
  return (
    <details className="runtime-process-request-details">
      <summary>
        <span>{t("查看请求代码与格式", "View request code and format")}</span>
        <em>{hasActual
          ? t(`${requests.filter((request) => request.kind === "actual").length} 个实际请求`, `${requests.filter((request) => request.kind === "actual").length} actual requests`)
          : attemptCount > 0
            ? t(`${attemptCount} 次 Runtime 尝试`, `${attemptCount} Runtime attempts`)
            : t("默认折叠", "Collapsed")}</em>
      </summary>
      <div className="runtime-process-request-list">
        {requests.map((request) => (
          <section className={`runtime-process-request request-${request.kind}`} key={request.id}>
            <header>
              <strong>{request.title}</strong>
              <span>{request.kind === "actual"
                ? t("实际发生", "Actual")
                : request.kind === "attempt"
                  ? t("Runtime 尝试·无策略证据", "Runtime attempt · no policy evidence")
                  : request.kind === "internal"
                    ? t("内部调用", "Internal call")
                    : t("预期格式·未发生", "Expected format · not observed")}</span>
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
  accessRequests,
  onClose,
  onRefresh,
}: RuntimeProcessWindowProps) {
  const { t } = useI18n();
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
    (decision) =>
      decision.action === "resource:list" ||
      decision.action === "resource:read" ||
      decision.action === "resource:process",
  );
  const disclosureDecisions = runDecisions.filter(
    (decision) => decision.action === "resource:disclose",
  );
  const forwardDecisions = runDecisions.filter(
    (decision) => decision.action === "resource:forward",
  );
  const approvalDecisions = runDecisions.filter((decision) =>
    decision.action.startsWith("approval:")
  );
  const requestBySourceDecisionId = new Map(
    accessRequests.map((request) => [request.sourceDecisionId, request]),
  );
  const catalogReadApprovalRequests = accessRequests.filter(
    (request) => request.action === "list" || request.action === "read",
  );
  const disclosureApprovalRequests = accessRequests.filter(
    (request) => request.action === "disclose",
  );
  const forwardApprovalRequests = accessRequests.filter(
    (request) => request.action === "forward",
  );
  const accessRequestDetails = accessDecisions.map((decision) =>
    requestForDecision(decision, t, requestBySourceDecisionId.get(decision.id))
  );
  const disclosureRequestDetails = disclosureDecisions.map((decision) =>
    requestForDecision(decision, t, requestBySourceDecisionId.get(decision.id))
  );
  const forwardRequestDetails = forwardDecisions.map((decision) =>
    requestForDecision(decision, t, requestBySourceDecisionId.get(decision.id))
  );
  const accessToolEvents = (run.runtimeToolEvents ?? []).filter(
    (event) => event.operation === "read" || event.operation === "assess",
  );
  const disclosureToolEvents = (run.runtimeToolEvents ?? []).filter(
    (event) => event.operation === "disclose",
  );
  const forwardToolEvents = (run.runtimeToolEvents ?? []).filter(
    (event) => event.operation === "forward" || event.operation === "request-forward",
  );
  const requiredAccess = (run.middlewareEvidenceRequirements ?? []).some(
    (requirement) =>
      requirement.action === "resource:read" || requirement.action === "resource:process",
  );
  const requiredDisclosure = (run.middlewareEvidenceRequirements ?? []).some(
    (requirement) => requirement.action === "resource:disclose",
  );
  const requiredForward = (run.middlewareEvidenceRequirements ?? []).some(
    (requirement) => requirement.action === "resource:forward",
  );
  const evidenceMissing = run.middlewareEvidenceStatus === "missing";
  const knowledgeWorkflowState = workflowState(
    accessDecisions,
    catalogReadApprovalRequests,
    run,
  );
  const disclosureWorkflowState = workflowState(
    disclosureDecisions,
    disclosureApprovalRequests,
    run,
  );
  const forwardWorkflowState = workflowState(
    forwardDecisions,
    forwardApprovalRequests,
    run,
  );
  const approvalStage = (accessRequest: AccessRequest): ProcessStage => ({
    id: `approval:${accessRequest.id}`,
    title: accessRequest.action === "list"
      ? t("私人资料目录审批", "Private catalog approval")
      : accessRequest.action === "read"
        ? t("资料读取审批", "Resource read approval")
        : accessRequest.action === "disclose"
          ? t("原文披露审批", "Source disclosure approval")
          : t("指定接收人转发审批", "Recipient-bound forward approval"),
    detail: accessRequest.status === "pending"
      ? t(`Run 已冻结，旧凭证已销毁；${accessRequest.ownerName} 可在截止时间前同意或拒绝。`, `The Run is frozen and its previous credential destroyed; ${accessRequest.ownerName} may approve or deny before the deadline.`)
      : accessRequest.status === "approved"
        ? t("资料所有者已同意；后端已签发新的 Run 短期凭证并恢复执行。", "The resource owner approved; the backend issued a fresh short-lived Run credential and resumed execution.")
        : accessRequest.status === "expired"
          ? t("审批已超时，后端按默认拒绝恢复 Run。", "Approval expired; the backend resumed the Run with default denial.")
          : t("资料所有者已拒绝；后端在不披露内容的情况下恢复 Run。", "The resource owner denied the request; the backend resumed without disclosing content."),
    state: accessRequest.status === "pending"
      ? "waiting"
      : accessRequest.status === "approved"
        ? "success"
        : "denied",
    time: accessRequest.resolvedAt ?? accessRequest.requestedAt,
    requests: [{
      id: `approval-${accessRequest.id}`,
      title: t("控制面人工审批请求", "Control-plane human approval request"),
      kind: "actual",
      command: "accessRequest.resolve(ownerDecision)",
      method: "POST",
      path: `/api/access-requests/${accessRequest.id}/approve|reject`,
      body: { action: accessRequest.action, recipient: accessRequest.recipientName },
      response: accessRequest.status === "pending"
        ? t(`Pending · ${new Date(accessRequest.expiresAt).toLocaleTimeString()} 自动拒绝`, `Pending · auto-deny at ${new Date(accessRequest.expiresAt).toLocaleTimeString()}`)
        : accessRequest.status,
    }],
  });

  const stages: ProcessStage[] = [
    {
      id: "accepted",
      title: t("请求进入 Launchpad", "Request entered Launchpad"),
      detail: t(`后端已创建 Run ${shortId(run.id)}，并绑定当前对话。`, `The backend created Run ${shortId(run.id)} and bound it to the current conversation.`),
      state: "success",
      time: run.createdAt,
      requests: [{
        id: "accepted-request",
        title: t("浏览器提交任务", "Browser submitted task"),
        kind: "actual",
        command: `fetch("/api/agents/${agent.id}/messages", { method: "POST", body: JSON.stringify(payload) })`,
        method: "POST",
        path: `/api/agents/${agent.id}/messages`,
        body: { content: t("[本次对话内容]", "[CURRENT_CONVERSATION_CONTENT]"), resourceReferences: t("[已附加资源引用]", "[ATTACHED_RESOURCE_REFERENCES]") },
        response: `202 Accepted · Run ${shortId(run.id)}`,
      }],
    },
    {
      id: "identity",
      title: t("注入运行身份", "Inject runtime identity"),
      detail: run.startedAt
        ? t(`${currentUser.displayName} → ${agent.name}；短期凭证仅对当前 Run 有效。`, `${currentUser.displayName} → ${agent.name}; the short-lived credential is valid only for this Run.`)
        : t("等待 Runtime 启动并签发当前 Run 的短期凭证。", "Waiting for Runtime to start and receive this Run's short-lived credential."),
      state: run.startedAt ? "success" : "running",
      time: run.startedAt,
      requests: [{
        id: "identity-request",
        title: t("Launchpad 启动 Agent Runtime", "Launchpad starts Agent Runtime"),
        kind: "internal",
        command: "runner.run({ prompt, workspacePath, runtimeEnvironment })",
        method: null,
        path: "AgentRunner.run",
        body: {
          LAUNCHPAD_RUN_ID: shortId(run.id),
          LAUNCHPAD_AGENT_ID: shortId(agent.id),
          LAUNCHPAD_RUNTIME_TOKEN: "[REDACTED_RUN_TOKEN]",
        },
        response: run.startedAt ? t("Runtime 已接收运行身份", "Runtime received its execution identity") : t("等待 Runtime 启动", "Waiting for Runtime to start"),
      }],
    },
    ...(grantDecisions.some((decision) => decision.action === "grant:create")
      ? [{
          id: "grant",
          title: t("附加资料授权", "Attached resource grant"),
          detail: grantDecisions.some((decision) => decision.action === "grant:revoke")
            ? t("本次运行的临时资料授权已撤销。", "The temporary resource grant for this Run was revoked.")
            : t("资料所有者已授予仅限本次运行的读取权限。", "The resource owner granted read access for this Run only."),
          state: "success" as const,
          time: grantDecisions.at(-1)?.occurredAt ?? null,
          requests: [{
            id: "grant-request",
            title: t("控制面附加临时授权", "Control plane attaches temporary grant"),
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
      title: t("私有资料读取或密封处理", "Private resource read or sealed processing"),
      detail: accessDecisions.length > 0
        ? knowledgeWorkflowState === "waiting"
          ? t("Bouncer 已安全阻断本次访问并转入人工审批；Run 正在等待，尚未返回目录或资料内容。", "Bouncer safely blocked this access and opened human approval; the Run is waiting and no catalog or resource content has been returned.")
          : knowledgeWorkflowState === "running"
            ? t("人工审批已通过，后端正在以新的 Run 短期凭证恢复执行并重试访问。", "Human approval succeeded; the backend is resuming with a fresh short-lived Run credential and retrying access.")
            : knowledgeWorkflowState === "success"
              ? t("访问曾被安全阻断并转入审批；批准后重试已通过，底层挑战记录仍保留为审计证据。", "Access was safely blocked and routed to approval; the approved retry succeeded while the original challenge remains as audit evidence.")
              : knowledgeWorkflowState === "denied"
                ? t("访问已被最终拒绝；原因可能是审批被拒绝、超时，或请求不具备可审批条件。", "Access was finally denied because approval was denied, expired, or the request was not eligible for approval.")
                : t("访问流程未能形成有效的最终授权结果。", "The access flow did not produce a valid final authorization result.")
        : accessToolEvents.length > 0
          ? t("Agent 已调用 vault，但工具或传输在策略决策前失败；这不是一次授权拒绝。", "The Agent called vault, but the tool or transport failed before a policy decision; this is not an authorization denial.")
        : isTerminal
          ? requiredAccess && evidenceMissing
            ? t("证据契约未满足：Run 已结束，但后端没有收到要求的资料读取或密封处理请求。", "Evidence contract not satisfied: the Run ended without the required backend read or sealed-processing request.")
            : t("本次 Run 没有产生资料读取或密封处理决策；不能把 Agent 正文中的描述视为已完成鉴权。", "This Run produced no read or sealed-processing decision; Agent prose cannot be treated as authorization evidence.")
          : t("等待 Agent 调用受保护资料库；只有抵达后端的请求才会留下权限证据。", "Waiting for the Agent to call the protected vault; only requests reaching the backend produce authorization evidence."),
      state: knowledgeWorkflowState ?? (accessDecisions.length > 0
        ? "failed"
        : accessToolEvents.length > 0 || isTerminal && requiredAccess && evidenceMissing
          ? "failed"
          : isTerminal ? "neutral" : "running"),
      time: accessDecisions.at(-1)?.occurredAt ?? accessToolEvents.at(-1)?.occurredAt ?? null,
      emptyTimeLabel: isTerminal ? requiredAccess ? t("未触发", "Not triggered") : t("未发生", "Not observed") : undefined,
      requests: accessRequestDetails.length > 0
        ? accessRequestDetails
        : accessToolEvents.length > 0
          ? accessToolEvents.map((event) => requestForToolEvent(event, t))
          : [{
        id: "knowledge-expected",
        title: t("Agent 资料读取/密封处理格式", "Agent resource read / sealed-process format"),
        kind: "expected",
        command: 'node .launchpad/tools/vault.mjs assess --owner <username> --title "[PROTECTED_TITLE]"',
        method: "POST",
        path: "/api/runtime/resources/process",
        body: { ownerUsername: "<username>", title: "[PROTECTED_TITLE]", operation: "launch-risk-check" },
        response: isTerminal ? t("本次 Run 未发出该请求", "This Run did not issue this request") : t("等待 Agent 发出请求", "Waiting for Agent request"),
      }],
    },
    ...catalogReadApprovalRequests.map(approvalStage),
    {
      id: "disclosure",
      title: t("向当前对话展示原文", "Disclose source text to current conversation"),
      detail: disclosureDecisions.length > 0
        ? disclosureWorkflowState === "waiting"
          ? t("首次披露被安全阻断并转入独立人工审批；Run 正在等待，资料原文尚未返回当前对话。", "The initial disclosure was safely blocked and routed to separate human approval; the Run is waiting and no source text has reached the conversation.")
          : disclosureWorkflowState === "running"
            ? t("披露审批已通过，后端正在恢复 Run 并重试独立披露鉴权。", "Disclosure approval succeeded; the backend is resuming the Run and retrying independent disclosure authorization.")
            : disclosureWorkflowState === "success"
              ? t("披露曾进入人工审批；批准后的重试已通过当前用户独立鉴权。", "Disclosure entered human approval; the approved retry passed independent authorization for the current user.")
              : disclosureWorkflowState === "denied"
                ? t("披露已被最终拒绝；资料原文没有返回当前对话。", "Disclosure was finally denied; no source text reached the conversation.")
                : t("披露流程未能形成有效的最终授权结果。", "The disclosure flow did not produce a valid final authorization result.")
        : disclosureToolEvents.length > 0
          ? t("Agent 已调用披露工具，但没有形成后端披露策略决策；这不是一次有效拒绝。", "The Agent called the disclosure tool without producing a backend disclosure decision; this is not a valid denial.")
        : isTerminal
          ? requiredDisclosure && evidenceMissing
            ? t("证据契约未满足：Agent 没有发起要求的真实披露请求。", "Evidence contract not satisfied: the Agent did not issue the required real disclosure request.")
            : t("本次 Run 没有发起披露请求。", "This Run did not issue a disclosure request.")
          : t("若用户要求在当前对话查看原文，Agent 必须调用独立披露接口。", "If the user requests source text in the conversation, the Agent must call the independent disclosure endpoint."),
      state: disclosureWorkflowState ?? (disclosureDecisions.length > 0
        ? "failed"
        : disclosureToolEvents.length > 0 || isTerminal && requiredDisclosure && evidenceMissing
          ? "failed"
          : isTerminal ? "neutral" : "running"),
      time: disclosureDecisions.at(-1)?.occurredAt ?? disclosureToolEvents.at(-1)?.occurredAt ?? null,
      emptyTimeLabel: isTerminal ? requiredDisclosure ? t("未触发", "Not triggered") : t("未发生", "Not observed") : undefined,
      requests: disclosureRequestDetails.length > 0
        ? disclosureRequestDetails
        : disclosureToolEvents.length > 0
          ? disclosureToolEvents.map((event) => requestForToolEvent(event, t))
          : [{
        id: "disclosure-expected",
        title: t("Agent 披露请求格式", "Agent disclosure request format"),
        kind: "expected",
        command: 'node .launchpad/tools/vault.mjs disclose --owner <username> [--title "[PROTECTED_TITLE]"]',
        method: "POST",
        path: "/api/runtime/resources/disclose",
        body: { ownerUsername: "<username>", title: t("[可省略或已脱敏]", "[OPTIONAL_OR_REDACTED]") },
        response: isTerminal ? t("本次 Run 未发出该请求", "This Run did not issue this request") : t("等待 Agent 发出请求", "Waiting for Agent request"),
      }],
    },
    ...disclosureApprovalRequests.map(approvalStage),
    {
      id: "forward",
      title: t("向指定接收人转发资料", "Forward resource to specified recipient"),
      detail: forwardDecisions.length > 0
        ? forwardWorkflowState === "waiting"
          ? t("Bouncer 已安全阻断外发并创建接收人绑定的人工审批；Run 正在等待，资料尚未交付。", "Bouncer safely blocked forwarding and created recipient-bound human approval; the Run is waiting and nothing has been delivered.")
          : forwardWorkflowState === "running"
            ? t("外发审批已通过，后端正在恢复 Run，并仅对已确认的资料与接收人重试。", "Forward approval succeeded; the backend is resuming the Run and retrying only the confirmed resource-recipient pair.")
            : forwardWorkflowState === "success"
              ? t("外发曾进入人工审批；批准后的重试已通过，后端完成交付且正文未返回 Agent。", "Forwarding entered human approval; the approved retry succeeded, the backend delivered the resource, and source text never returned to the Agent.")
              : forwardWorkflowState === "denied"
                ? t("外发已被最终拒绝；原因可能是审批被拒绝、超时，或所有权、接收人、用户意图不匹配。", "Forwarding was finally denied because approval was denied or expired, or ownership, recipient, or user intent did not match.")
                : t("外发流程未能形成有效的最终授权结果。", "The forward flow did not produce a valid final authorization result.")
        : forwardToolEvents.length > 0
          ? t("Agent 已调用转发工具，但请求未形成有效的后端策略决定。", "The Agent called the forward tool, but the request produced no valid backend policy decision.")
          : isTerminal
            ? requiredForward && evidenceMissing
              ? t("证据契约未满足：Agent 没有发起要求的真实转发请求。", "Evidence contract not satisfied: the Agent did not issue the required real forward request.")
              : t("本次 Run 没有发起资料转发请求。", "This Run did not issue a resource forward request.")
            : t("只有用户明确授权的资料与接收人组合才可由后端转发。", "The backend may forward only a resource-recipient pair explicitly authorized by the user."),
      state: forwardWorkflowState ?? (forwardDecisions.length > 0
        ? "failed"
        : forwardToolEvents.length > 0 || isTerminal && requiredForward && evidenceMissing
          ? "failed"
          : isTerminal ? "neutral" : "running"),
      time: forwardDecisions.at(-1)?.occurredAt ?? forwardToolEvents.at(-1)?.occurredAt ?? null,
      emptyTimeLabel: isTerminal ? requiredForward ? t("未触发", "Not triggered") : t("未发生", "Not observed") : undefined,
      requests: forwardRequestDetails.length > 0
        ? forwardRequestDetails
        : forwardToolEvents.length > 0
          ? forwardToolEvents.map((event) => requestForToolEvent(event, t))
          : [{
              id: "forward-expected",
              title: t("Agent 转发请求格式", "Agent forward request format"),
              kind: "expected",
              command: 'node .launchpad/tools/vault.mjs forward --owner <username> --title "[PROTECTED_TITLE]" --recipient <username>',
              method: "POST",
              path: "/api/runtime/resources/forward",
              body: { ownerUsername: "<username>", title: "[PROTECTED_TITLE]", recipientUsername: "<username>" },
              response: isTerminal ? t("本次 Run 未发出该请求", "This Run did not issue this request") : t("等待 Agent 发出请求", "Waiting for Agent request"),
            }],
    },
    ...forwardApprovalRequests.map(approvalStage),
    {
      id: "result",
      title: t("结束运行并销毁凭证", "Finish Run and destroy credential"),
      detail: run.status === "completed"
        ? run.middlewareEvidenceStatus === "satisfied"
          ? t("回复已写入对话，middleware 证据契约已满足，Run 短期凭证已销毁。", "The response was written to the conversation, the middleware evidence contract was satisfied, and the short-lived Run credential was destroyed.")
          : t("回复已写入对话，Run 短期凭证已销毁。", "The response was written to the conversation and the short-lived Run credential was destroyed.")
        : run.status === "failed"
          ? run.middlewareEvidenceStatus === "missing"
            ? t("运行因缺少真实 middleware 证据而失败；凭证已销毁，可从任务页重试该步骤。", "The Run failed because real middleware evidence was missing; its credential was destroyed and the step can be retried from the task page.")
            : t("运行失败，Run 短期凭证已销毁。", "The Run failed and its short-lived credential was destroyed.")
          : run.status === "cancelled"
            ? t("运行已取消，Run 短期凭证已销毁。", "The Run was cancelled and its short-lived credential was destroyed.")
            : run.status === "waiting_for_approval"
              ? t("Runtime 已停止，旧短期凭证已销毁；审批完成后会以新凭证恢复同一 Run。", "Runtime stopped and its previous short-lived credential was destroyed; the same Run will resume with a fresh credential after approval.")
              : t("运行结束后，后端会立即销毁本次短期凭证。", "The backend will destroy this short-lived credential immediately when the Run ends."),
      state: run.status === "completed"
        ? "success"
        : run.status === "failed" || run.status === "cancelled"
          ? "failed"
          : "running",
      time: run.completedAt,
      requests: [{
        id: "result-request",
        title: t("控制面提交运行结果", "Control plane finalizes Run result"),
        kind: "internal",
        command: "store.mutate(run => finalize(run)); runtimeCredentials.delete(tokenHash)",
        method: null,
        path: "Run finalization",
        body: { status: run.status, output: "[REDACTED_CONVERSATION_OUTPUT]", runtimeToken: "[REVOKED]" },
        response: isTerminal ? `Run ${run.status}` : t("等待 Run 结束", "Waiting for Run to finish"),
      }],
    },
  ];
  const isOptionalUntriggeredStage = (stage: ProcessStage) =>
    isTerminal && (
      stage.id === "knowledge"
        ? accessDecisions.length === 0 && accessToolEvents.length === 0 && !requiredAccess
        : stage.id === "disclosure"
          ? disclosureDecisions.length === 0 && disclosureToolEvents.length === 0 && !requiredDisclosure
          : stage.id === "forward"
            ? forwardDecisions.length === 0 && forwardToolEvents.length === 0 && !requiredForward
          : false
    );
  const visibleStages = stages.filter((stage) => !isOptionalUntriggeredStage(stage));
  const untriggeredStages = stages.filter(isOptionalUntriggeredStage);

  const renderStage = (stage: ProcessStage) => {
    const stageDecisions = stage.id === "knowledge"
      ? accessDecisions
      : stage.id === "disclosure"
        ? disclosureDecisions
        : stage.id === "forward"
          ? forwardDecisions
        : stage.id.startsWith("approval:")
          ? approvalDecisions.filter((decision) =>
              decision.targetId === stage.id.slice("approval:".length)
            )
        : [];
    return (
      <article className={`runtime-process-stage stage-${stage.state}`} key={stage.id}>
        <span className="runtime-process-node" aria-hidden="true" />
        <div>
          <header><strong>{stage.title}</strong><time>{timeLabel(stage.time, stage.emptyTimeLabel ?? t("等待中", "Waiting"))}</time></header>
          <p>{stage.detail}</p>
          {stageDecisions.length > 0 && (
            <div className="runtime-process-decisions">
              {stageDecisions.map((decision) => {
                const linkedRequest = requestBySourceDecisionId.get(decision.id);
                return (
                  <div
                    className={`runtime-process-decision ${linkedRequest ? "decision-awaiting" : `decision-${decision.decision}`}`}
                    key={decision.id}
                  >
                    <span>{linkedRequest
                      ? t("需审批", "Approval required")
                      : decision.action === "approval:request"
                        ? t("待审批", "Pending")
                        : decision.action === "approval:approve"
                          ? t("同意", "Approved")
                          : decision.action === "approval:reject"
                            ? t("拒绝", "Denied")
                            : decision.action === "approval:expire"
                              ? t("已超时", "Expired")
                              : decision.decision === "allow" ? t("允许", "Allow") : t("拒绝", "Deny")}</span>
                    <strong>{decision.targetLabel}</strong>
                    <code>{decision.reasonCode}</code>
                  </div>
                );
              })}
            </div>
          )}
          <RequestDetails requests={stage.requests} />
        </div>
      </article>
    );
  };

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
      aria-label={t("后端执行过程", "Backend execution trace")}
    >
      <header
        className="runtime-process-handle"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div>
          <span className="eyebrow">LIVE BACKEND TRACE · {t("拖动移动", "DRAG TO MOVE")}</span>
          <h2>{t("后端执行过程", "Backend execution trace")}</h2>
        </div>
        <span className={`runtime-process-status status-${run.status}`}>
          <i />{runStateLabel(run, t)}
        </span>
        <div className="runtime-process-actions">
          <button type="button" onClick={onRefresh} title={t("刷新后端过程", "Refresh backend trace")}>↻</button>
          <button type="button" onClick={() => setCollapsed((value) => !value)} title={collapsed ? t("展开", "Expand") : t("收起", "Collapse")}>
            {collapsed ? "▢" : "—"}
          </button>
          <button type="button" onClick={onClose} aria-label={t("关闭后端过程", "Close backend trace")}>×</button>
        </div>
      </header>

      {!collapsed && <div className="runtime-process-body">
        <div className="runtime-process-boundary">
          <span>{t("运行边界", "Run boundary")}</span>
          <strong>{currentUser.displayName} → {agent.name}</strong>
          <code>Run {shortId(run.id)} · bouncer-v1</code>
        </div>
        <div className="runtime-process-trust-strip" aria-label={t("Bouncer 信任边界", "Bouncer trust boundary")}>
          <span>UNTRUSTED RUNTIME</span>
          <b aria-hidden="true">→</b>
          <span>TRUSTED BOUNCER</span>
          <b aria-hidden="true">→</b>
          <span>AUDIT EVIDENCE</span>
        </div>

        <div className="runtime-process-timeline">
          {visibleStages.map(renderStage)}
        </div>

        {untriggeredStages.length > 0 && (
          <details className="runtime-process-untriggered">
            <summary>{t("本次未触发的可选操作", "Optional operations not triggered")} <span>{untriggeredStages.length}</span></summary>
            <div className="runtime-process-timeline">
              {untriggeredStages.map(renderStage)}
            </div>
          </details>
        )}

        <footer className="runtime-process-footer">
          <span>{t("可展开查看脱敏后的实际请求格式", "Expand to view redacted actual request formats")}</span>
          <strong>{t("不会展示密钥或私有资料内容", "Secrets and private resource content are never shown")}</strong>
        </footer>
      </div>}
    </aside>
  );
}
