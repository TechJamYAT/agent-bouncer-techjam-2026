import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type {
  Agent,
  CoordinationMode,
  CoordinationSnapshot,
  Group,
  GroupMember,
  User,
} from "./types";

interface GroupChatProps {
  group: Group;
  agents: Agent[];
  currentUser: User;
  onError: (message: string) => void;
  onOpenAgents: () => void;
  onActivity: () => void;
}

type LiveAgentActivity =
  | { kind: "planning"; agentId: string | null; name: string }
  | { kind: "thinking"; agentId: string; name: string };

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function GroupChat({
  group,
  agents,
  currentUser,
  onError,
  onOpenAgents,
  onActivity,
}: GroupChatProps) {
  const [snapshot, setSnapshot] = useState<CoordinationSnapshot | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [draftMode, setDraftMode] = useState<CoordinationMode>("manual");
  const [draftMaxCalls, setDraftMaxCalls] = useState(4);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [optimisticActivity, setOptimisticActivity] = useState<LiveAgentActivity | null>(null);
  const [resolvingManualPermission, setResolvingManualPermission] = useState(false);
  const [resolvingRoundPermission, setResolvingRoundPermission] = useState(false);
  const shouldFollow = useRef(true);
  const forceScroll = useRef(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  const permissionRef = useRef<HTMLElement>(null);
  const canManage = group.role === "owner" || group.role === "admin";
  const executionAgents = useMemo(
    () => agents.filter((agent) => agent.scope === "group"),
    [agents],
  );
  const coordinator = agents.find((agent) => agent.scope === "coordinator") ?? null;

  const refreshSnapshot = useCallback(async (sessionId: string) => {
    const next = await api.coordinationSession(sessionId);
    setSnapshot(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSnapshot(null);
    void Promise.all([api.coordinationSessions(group.id), api.groupMembers(group.id)])
      .then(async ([sessionResult, memberResult]) => {
        if (cancelled) return;
        setMembers(memberResult.members);
        const chat = sessionResult.sessions.find((session) => session.kind === "group_chat");
        if (chat) {
          const next = await api.coordinationSession(chat.id);
          if (cancelled) return;
          forceScroll.current = true;
          setDraftMode(next.session.mode);
          setDraftMaxCalls(next.session.maxCallsPerRound);
          setSnapshot(next);
        }
      })
      .catch((reason) => onError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [group.id, onError]);

  useEffect(() => {
    if (!snapshot) return;
    const shouldPoll = snapshot.session.status === "running" ||
      (snapshot.session.mode === "automatic" && snapshot.session.status === "active");
    if (!shouldPoll) return;
    const timer = window.setInterval(() => {
      void refreshSnapshot(snapshot.session.id).catch((reason) =>
        onError(reason instanceof Error ? reason.message : String(reason)),
      );
    }, 300);
    return () => window.clearInterval(timer);
  }, [onError, refreshSnapshot, snapshot]);

  useEffect(() => {
    if (
      snapshot?.session.controllerUserId === currentUser.id &&
      (snapshot.session.manualAdvanceRequest?.status === "pending" ||
        snapshot.session.roundExtensionRequest?.status === "pending")
    ) {
      permissionRef.current?.focus({ preventScroll: true });
    }
  }, [currentUser.id, snapshot?.session.controllerUserId, snapshot?.session.manualAdvanceRequest, snapshot?.session.roundExtensionRequest]);

  const visibleEvents = useMemo(
    () => snapshot?.events.filter(
      (event) => event.type === "human.message" || event.type === "agent.message",
    ) ?? [],
    [snapshot?.events],
  );

  const liveActivity = useMemo<LiveAgentActivity | null>(() => {
    if (!snapshot) return optimisticActivity;
    const activeStep = snapshot.steps.find((step) => step.id === snapshot.session.activeStepId);
    if (snapshot.session.status === "running" && activeStep) {
      return {
        kind: "thinking",
        agentId: activeStep.agentId,
        name: agents.find((agent) => agent.id === activeStep.agentId)?.name ?? "群组 Agent",
      };
    }
    if (
      snapshot.session.mode === "automatic" &&
      snapshot.session.status === "active" &&
      snapshot.session.needsReplan &&
      snapshot.session.coordinatorEnabled
    ) {
      return {
        kind: "planning",
        agentId: snapshot.session.coordinatorAgentId,
        name: coordinator?.name ?? "调度 Agent",
      };
    }
    return optimisticActivity;
  }, [agents, coordinator?.name, optimisticActivity, snapshot]);

  useLayoutEffect(() => {
    if (forceScroll.current) {
      forceScroll.current = false;
      messageEnd.current?.scrollIntoView({ behavior: "auto", block: "end" });
      return;
    }
    if (shouldFollow.current) {
      messageEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [liveActivity?.agentId, liveActivity?.kind, visibleEvents.length]);

  const actorName = (actorType: string, actorId: string | null) => {
    if (actorType === "agent") {
      return agents.find((agent) => agent.id === actorId)?.name ?? "群组 Agent";
    }
    return members.find((member) => member.user.id === actorId)?.user.displayName ?? "群组成员";
  };

  const ensureChat = async (): Promise<CoordinationSnapshot> => {
    if (snapshot) return snapshot;
    const created = await api.createGroupChat(group.id, {
      title: `${group.name} 群聊`,
      mode: draftMode,
      participantAgentIds: executionAgents
        .filter((agent) => agent.status !== "stopped")
        .map((agent) => agent.id),
      coordinatorEnabled: true,
      maxCallsPerRound: draftMaxCalls,
    });
    setSnapshot(created);
    return created;
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    const content = message.trim();
    setMessage("");
    setBusy(true);
    try {
      const chat = await ensureChat();
      setSnapshot(await api.sendCoordinationMessage(chat.session.id, content));
      onActivity();
      shouldFollow.current = true;
    } catch (reason) {
      setMessage(content);
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const askAgent = async () => {
    if (!snapshot || executionAgents.length === 0) return;
    const pendingStep = snapshot.steps
      .filter((step) => step.planVersion === snapshot.session.planVersion && step.status === "pending")
      .sort((left, right) => left.position - right.position)[0];
    setOptimisticActivity(
      snapshot.session.needsReplan && snapshot.session.coordinatorEnabled
        ? {
            kind: "planning",
            agentId: snapshot.session.coordinatorAgentId,
            name: coordinator?.name ?? "调度 Agent",
          }
        : pendingStep
          ? {
              kind: "thinking",
              agentId: pendingStep.agentId,
              name: agents.find((agent) => agent.id === pendingStep.agentId)?.name ?? "群组 Agent",
            }
          : null,
    );
    setBusy(true);
    try {
      const result = await api.advanceCoordination(snapshot.session.id, snapshot.session.version);
      setSnapshot(result.snapshot);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      await refreshSnapshot(snapshot.session.id).catch(() => undefined);
    } finally {
      setOptimisticActivity(null);
      setBusy(false);
    }
  };

  const changeMode = async (mode: CoordinationMode) => {
    setDraftMode(mode);
    if (!snapshot || snapshot.session.mode === mode) return;
    setBusy(true);
    try {
      setSnapshot(await api.setCoordinationMode(snapshot.session.id, mode, snapshot.session.version));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      setDraftMode(snapshot.session.mode);
    } finally {
      setBusy(false);
    }
  };

  const changeCallAllowance = async () => {
    if (!snapshot) return;
    const value = Math.max(1, Math.min(50, Math.trunc(draftMaxCalls) || 1));
    setDraftMaxCalls(value);
    if (value === snapshot.session.maxCallsPerRound) return;
    setBusy(true);
    try {
      const next = await api.setCoordinationCallAllowance(
        snapshot.session.id,
        value,
        snapshot.session.version,
      );
      setSnapshot(next);
      setDraftMaxCalls(next.session.maxCallsPerRound);
    } catch (reason) {
      setDraftMaxCalls(snapshot.session.maxCallsPerRound);
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const changeCoordinator = async (enabled: boolean) => {
    if (!snapshot || snapshot.session.coordinatorEnabled === enabled) return;
    setBusy(true);
    try {
      setSnapshot(await api.setCoordinationCoordinator(
        snapshot.session.id,
        enabled,
        snapshot.session.version,
      ));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      await refreshSnapshot(snapshot.session.id).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const resolveManualAdvance = async (decision: "approve" | "reject") => {
    if (!snapshot) return;
    setResolvingManualPermission(true);
    if (decision === "approve") {
      const pendingStep = snapshot.steps
        .filter((step) => step.planVersion === snapshot.session.planVersion && step.status === "pending")
        .sort((left, right) => left.position - right.position)[0];
      setOptimisticActivity(
        snapshot.session.needsReplan
          ? {
              kind: "planning",
              agentId: snapshot.session.coordinatorAgentId,
              name: coordinator?.name ?? "调度 Agent",
            }
          : pendingStep
            ? {
                kind: "thinking",
                agentId: pendingStep.agentId,
                name: agents.find((agent) => agent.id === pendingStep.agentId)?.name ?? "群组 Agent",
              }
            : null,
      );
    }
    setBusy(true);
    try {
      const result = await api.resolveCoordinationManualAdvance(
        snapshot.session.id,
        decision,
        snapshot.session.version,
      );
      setSnapshot(result.snapshot);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      await refreshSnapshot(snapshot.session.id).catch(() => undefined);
    } finally {
      setOptimisticActivity(null);
      setResolvingManualPermission(false);
      setBusy(false);
    }
  };

  const resolveRoundExtension = async (decision: "approve" | "reject") => {
    if (!snapshot) return;
    setResolvingRoundPermission(true);
    setBusy(true);
    try {
      let next = await api.resolveCoordinationRoundExtension(
        snapshot.session.id,
        decision,
        decision === "approve" ? 1 : undefined,
        snapshot.session.version,
      );
      if (decision === "approve" && next.session.mode === "manual") {
        const pendingStep = next.steps
          .filter((step) => step.planVersion === next.session.planVersion && step.status === "pending")
          .sort((left, right) => left.position - right.position)[0];
        setOptimisticActivity(
          next.session.needsReplan && next.session.coordinatorEnabled
            ? {
                kind: "planning",
                agentId: next.session.coordinatorAgentId,
                name: coordinator?.name ?? "调度 Agent",
              }
            : pendingStep
              ? {
                  kind: "thinking",
                  agentId: pendingStep.agentId,
                  name: agents.find((agent) => agent.id === pendingStep.agentId)?.name ?? "群组 Agent",
                }
              : null,
        );
        next = (await api.advanceCoordination(next.session.id, next.session.version)).snapshot;
      }
      setSnapshot(next);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      await refreshSnapshot(snapshot.session.id).catch(() => undefined);
    } finally {
      setOptimisticActivity(null);
      setResolvingRoundPermission(false);
      setBusy(false);
    }
  };

  const running = snapshot?.session.status === "running";
  const canApprove = snapshot?.session.controllerUserId === currentUser.id;
  return (
    <section className="group-chat-shell">
      <div className="group-chat-tools">
        <div className="participant-stack">
          {members.slice(0, 4).map((member) => (
            <span key={member.user.id} title={member.user.displayName}>
              {member.user.displayName.slice(0, 1).toUpperCase()}
            </span>
          ))}
          <small>
            {members.length} 位成员 · {executionAgents.length} 个执行 Agent
            {coordinator ? " · 1 个调度 Agent" : ""}
            {snapshot ? ` · 第 ${snapshot.session.currentRound} 轮 ${snapshot.session.callsInCurrentRound}/${snapshot.session.maxCallsPerRound}` : ""}
          </small>
        </div>
        <div className="chat-mode-control">
          <label>协作模式
            <select
              value={snapshot?.session.mode ?? draftMode}
              onChange={(event) => void changeMode(event.target.value as CoordinationMode)}
              disabled={busy || running || !canManage || snapshot?.session.manualAdvanceRequest?.status === "pending" || snapshot?.session.roundExtensionRequest?.status === "pending"}
            >
              <option value="manual">人工模式</option>
              <option value="automatic" disabled={executionAgents.length === 0}>自动模式</option>
            </select>
          </label>
          {snapshot && canManage && (
            <label>每轮调用
              <input
                className="chat-call-allowance"
                type="number"
                min={1}
                max={50}
                value={draftMaxCalls}
                onChange={(event) => setDraftMaxCalls(Number(event.target.value))}
                onBlur={() => void changeCallAllowance()}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void changeCallAllowance(); } }}
                disabled={busy || running || snapshot.session.manualAdvanceRequest?.status === "pending" || snapshot.session.roundExtensionRequest?.status === "pending"}
              />
            </label>
          )}
          {snapshot && (
            <label className="chat-coordinator-toggle" title="由调度 Agent 按需选择回复者及顺序">
              <input
                type="checkbox"
                checked={snapshot.session.coordinatorEnabled}
                onChange={(event) => void changeCoordinator(event.target.checked)}
                disabled={busy || running || !canManage}
              />
              调度 Agent
            </label>
          )}
          {snapshot && snapshot.session.mode !== "automatic" && executionAgents.length > 0 && snapshot.session.manualAdvanceRequest?.status !== "pending" && (
            <button className="button button-ghost" onClick={() => void askAgent()} disabled={busy || running || visibleEvents.length === 0}>
              {running
                ? "Agent 回复中…"
                : snapshot?.session.needsReplan && snapshot.session.coordinatorEnabled
                  ? "让调度 Agent 决定下一步"
                  : "让下一位 Agent 回复"}
            </button>
          )}
          {executionAgents.length === 0 && <button className="button button-ghost" onClick={onOpenAgents}>＋ 添加群组 Agent</button>}
        </div>
      </div>

      <div
        className="group-chat-messages"
        onScroll={(event) => {
          const node = event.currentTarget;
          shouldFollow.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 48;
        }}
      >
        {loading ? (
          <div className="chat-empty-state"><span className="spinner" /><p>正在载入群聊…</p></div>
        ) : visibleEvents.length === 0 ? (
          <div className="chat-empty-state"><span>◎</span><h2>开始群聊</h2><p>群成员可以直接发言；人工模式由人决定何时让下一位 Agent 回复，自动模式会在新消息后继续调度。</p></div>
        ) : visibleEvents.map((event) => {
          const own = event.actorType === "human" && event.actorId === currentUser.id;
          return (
            <article className={`group-chat-message ${event.actorType} ${own ? "own" : ""}`} key={event.id}>
              <div className="chat-avatar">{actorName(event.actorType, event.actorId).slice(0, 1).toUpperCase()}</div>
              <div><header><strong>{own ? "你" : actorName(event.actorType, event.actorId)}</strong><span>#{event.sequence} · {formatTime(event.createdAt)}</span></header><p>{event.content}</p></div>
            </article>
          );
        })}
        {liveActivity && (
          <article className={`group-chat-message agent live-agent-activity ${liveActivity.kind}`}>
            <div className="chat-avatar">{liveActivity.name.slice(0, 1).toUpperCase()}</div>
            <div>
              <header>
                <strong>{liveActivity.name}</strong>
                <span>{liveActivity.kind === "planning" ? "正在规划调度" : "正在思考"}</span>
              </header>
              <p className="chat-thinking">
                <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                {liveActivity.kind === "planning"
                  ? "正在读取最新上下文，并决定本轮调用哪些 Agent 以及回复顺序…"
                  : "正在读取调用前的完整上下文并生成回复…"}
              </p>
            </div>
          </article>
        )}
        {snapshot?.session.manualAdvanceRequest?.status === "pending" && !resolvingManualPermission && (
          <section
            ref={permissionRef}
            className="round-extension-card conversation-permission-card"
            role="alertdialog"
            aria-label="请求进入下一个 Agent 步骤"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (busy || !canApprove) return;
              if (event.key === "Escape") { event.preventDefault(); void resolveManualAdvance("reject"); }
              if (event.key === "Enter") { event.preventDefault(); void resolveManualAdvance("approve"); }
            }}
          >
            <div className="round-extension-heading"><span>✋</span>请求权限</div>
            <p className="round-extension-question">是否允许进入下一步？</p>
            <p className="round-extension-reason">{snapshot.session.manualAdvanceRequest.rationale}</p>
            <small>等待期间可以继续补充信息；无人补充则执行原计划下一步，有新信息才由调度 Agent 重新规划。</small>
            {canApprove ? (
              <div className="round-extension-actions">
                <button onClick={() => void resolveManualAdvance("reject")} disabled={busy}>拒绝 <kbd>Esc</kbd></button>
                <button className="allow" onClick={() => void resolveManualAdvance("approve")} disabled={busy}>允许下一步 <kbd>↵</kbd></button>
              </div>
            ) : <span className="round-extension-waiting">等待本轮发起者处理</span>}
          </section>
        )}
        {snapshot?.session.roundExtensionRequest?.status === "pending" && !resolvingRoundPermission && (
          <section
            ref={permissionRef}
            className="round-extension-card conversation-permission-card"
            role="alertdialog"
            aria-label="请求开启下一执行轮次"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (busy || !canApprove) return;
              if (event.key === "Escape") { event.preventDefault(); void resolveRoundExtension("reject"); }
              if (event.key === "Enter") { event.preventDefault(); void resolveRoundExtension("approve"); }
            }}
          >
            <div className="round-extension-heading"><span>✋</span>请求权限</div>
            <p className="round-extension-question">本轮调用额度已用完，是否允许开启下一轮？</p>
            <p className="round-extension-reason">{snapshot.session.roundExtensionRequest.rationale}</p>
            <small>第 {snapshot.session.currentRound} 轮已执行 {snapshot.session.callsInCurrentRound}/{snapshot.session.maxCallsPerRound} 次 Agent 调用。</small>
            <small>批准后若无人补充新信息，将直接从原调度计划的下一步继续；有新信息时才重新规划。</small>
            {canApprove ? (
              <div className="round-extension-actions">
                <button onClick={() => void resolveRoundExtension("reject")} disabled={busy}>拒绝 <kbd>Esc</kbd></button>
                <button className="allow" onClick={() => void resolveRoundExtension("approve")} disabled={busy}>允许下一轮 <kbd>↵</kbd></button>
              </div>
            ) : <span className="round-extension-waiting">等待本轮发起者处理</span>}
          </section>
        )}
        <div ref={messageEnd} />
      </div>

      <form className="group-chat-composer" onSubmit={sendMessage}>
        <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`发送到 ${group.name}`} rows={2} disabled={busy && !running} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div><span>Enter 发送 · Shift + Enter 换行</span><button className="send-button" disabled={!message.trim() || busy} aria-label="发送群聊消息">↑</button></div>
      </form>
    </section>
  );
}
