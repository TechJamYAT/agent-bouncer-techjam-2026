import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type {
  Agent,
  AgentRun,
  ArtifactPublication,
  ContextImportMode,
  CoordinationMode,
  CoordinationSnapshot,
  Group,
  ProjectFileInfo,
  ProjectFilePreview,
  User,
} from "./types";

interface CoordinationWorkspaceProps {
  agents: Agent[];
  groups: Group[];
  currentUser: User;
  fixedGroupId?: string;
  selectedSessionId?: string | null;
  createRequest?: number;
  onError: (message: string) => void;
  onRefreshAgents: () => Promise<void>;
  onSessionsChanged?: (groupId: string, sessions: CoordinationSnapshot["session"][]) => void;
  onTaskCreated?: (sessionId: string) => void;
  onRuntimeRunStarted?: (run: AgentRun) => void;
}

type LiveAgentActivity =
  | { kind: "planning"; agentId: string | null; name: string }
  | { kind: "thinking"; agentId: string; name: string };

function eventTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

interface ProjectTreeNode {
  name: string;
  path: string;
  file: ProjectFileInfo | null;
  children: ProjectTreeNode[];
}

function projectTree(files: ProjectFileInfo[]): ProjectTreeNode[] {
  const roots: ProjectTreeNode[] = [];
  for (const file of files) {
    const parts = file.relativePath.split("/");
    let siblings = roots;
    let currentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]!;
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      let node = siblings.find((item) => item.name === name);
      if (!node) {
        node = { name, path: currentPath, file: null, children: [] };
        siblings.push(node);
      }
      if (index === parts.length - 1) node.file = file;
      siblings = node.children;
    }
  }
  const sort = (nodes: ProjectTreeNode[]) => {
    nodes.sort((left, right) => {
      if (Boolean(left.file) !== Boolean(right.file)) return left.file ? 1 : -1;
      return left.name.localeCompare(right.name);
    });
    nodes.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}

function fileSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${Math.ceil(size / 1_024)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}

function ProjectTree({
  nodes,
  selectedPath,
  onSelect,
}: {
  nodes: ProjectTreeNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <ul className="project-tree-branch">
      {nodes.map((node) => node.file ? (
        <li key={node.path}>
          <button
            className={selectedPath === node.path ? "selected" : ""}
            onClick={() => onSelect(node.path)}
          >
            <span>◇</span><strong>{node.name}</strong><small>{fileSize(node.file.size)}</small>
          </button>
        </li>
      ) : (
        <li key={node.path}>
          <details open>
            <summary><span>▾</span><strong>{node.name}</strong></summary>
            <ProjectTree nodes={node.children} selectedPath={selectedPath} onSelect={onSelect} />
          </details>
        </li>
      ))}
    </ul>
  );
}

export function CoordinationWorkspace({
  agents,
  groups,
  currentUser,
  fixedGroupId,
  selectedSessionId,
  createRequest = 0,
  onError,
  onRefreshAgents,
  onSessionsChanged,
  onTaskCreated,
  onRuntimeRunStarted,
}: CoordinationWorkspaceProps) {
  const [groupId, setGroupId] = useState(fixedGroupId ?? groups[0]?.id ?? "");
  const [, setSessions] = useState<Array<CoordinationSnapshot["session"]>>([]);
  const [snapshot, setSnapshot] = useState<CoordinationSnapshot | null>(null);
  const [sourceChat, setSourceChat] = useState<CoordinationSnapshot | null>(null);
  const [contextMode, setContextMode] = useState<ContextImportMode>("none");
  const [selectedContextEventIds, setSelectedContextEventIds] = useState<string[]>([]);
  const [publications, setPublications] = useState<ArtifactPublication[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFileInfo[]>([]);
  const [selectedProjectFile, setSelectedProjectFile] = useState<string | null>(null);
  const [projectPreview, setProjectPreview] = useState<ProjectFilePreview | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [title, setTitle] = useState("Product launch review");
  const [objective, setObjective] = useState(
    "Review the launch plan from each specialist's perspective and produce an ordered handoff.",
  );
  const [mode, setMode] = useState<CoordinationMode>("manual");
  const [coordinatorEnabled, setCoordinatorEnabled] = useState(true);
  const [bouncerEvidenceContract, setBouncerEvidenceContract] = useState(false);
  const [maxCallsPerRound, setMaxCallsPerRound] = useState(4);
  const roundPermissionRef = useRef<HTMLElement>(null);
  const reportedRuntimeRunIds = useRef(new Set<string>());
  const [participantAgentIds, setParticipantAgentIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [optimisticActivity, setOptimisticActivity] = useState<LiveAgentActivity | null>(null);
  const [resolvingManualPermission, setResolvingManualPermission] = useState(false);
  const [resolvingRoundPermission, setResolvingRoundPermission] = useState(false);
  const [showTaskCreate, setShowTaskCreate] = useState(false);

  const reportRuntimeRun = useCallback((run: AgentRun) => {
    if (reportedRuntimeRunIds.current.has(run.id)) return;
    reportedRuntimeRunIds.current.add(run.id);
    onRuntimeRunStarted?.(run);
  }, [onRuntimeRunStarted]);

  const groupAgents = useMemo(
    () => agents.filter(
      (agent) => agent.scope === "group" && agent.groupId === groupId && agent.status !== "stopped",
    ),
    [agents, groupId],
  );

  const refreshSessions = useCallback(async (nextGroupId: string) => {
    if (!nextGroupId) {
      setSessions([]);
      setSourceChat(null);
      return;
    }
    const result = await api.coordinationSessions(nextGroupId);
    const taskSessions = result.sessions.filter((session) => session.kind === "task");
    setSessions(taskSessions);
    onSessionsChanged?.(nextGroupId, taskSessions);
    const chat = result.sessions.find((session) => session.kind === "group_chat");
    setSourceChat(chat ? await api.coordinationSession(chat.id) : null);
  }, [onSessionsChanged]);

  const refreshPublications = useCallback(async () => {
    const result = await api.artifactPublications();
    setPublications(result.publications);
  }, []);

  const refreshSnapshot = useCallback(async (sessionId: string) => {
    const next = await api.coordinationSession(sessionId);
    setSnapshot(next);
    return next;
  }, []);

  const refreshProjectFiles = useCallback(async (sessionId: string) => {
    const result = await api.coordinationProjectFiles(sessionId);
    setProjectFiles(result.files);
    setSelectedProjectFile((current) =>
      current && result.files.some((file) => file.relativePath === current)
        ? current
        : result.files[0]?.relativePath ?? null,
    );
  }, []);

  useEffect(() => {
    if (fixedGroupId) {
      setGroupId(fixedGroupId);
      return;
    }
    if (groups.some((group) => group.id === groupId)) return;
    setGroupId(groups[0]?.id ?? "");
  }, [fixedGroupId, groupId, groups]);

  useEffect(() => {
    setSnapshot(null);
    setParticipantAgentIds([]);
    setContextMode("none");
    setSelectedContextEventIds([]);
    void Promise.all([refreshSessions(groupId), refreshPublications()]).catch((reason) =>
      onError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [groupId, onError, refreshPublications, refreshSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setShowTaskCreate(false);
    void refreshSnapshot(selectedSessionId).catch((reason) =>
      onError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [onError, refreshSnapshot, selectedSessionId]);

  useEffect(() => {
    if (createRequest === 0) return;
    setSnapshot(null);
    setShowTaskCreate(true);
  }, [createRequest]);

  useEffect(() => {
    const sessionId = snapshot?.session.projectId ? snapshot.session.id : null;
    setProjectFiles([]);
    setSelectedProjectFile(null);
    setProjectPreview(null);
    if (!sessionId) return;
    void refreshProjectFiles(sessionId).catch((reason) =>
      onError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [onError, refreshProjectFiles, snapshot?.session.id, snapshot?.session.projectId]);

  useEffect(() => {
    const runId = snapshot?.steps.find(
      (step) => step.id === snapshot.session.activeStepId && step.runId,
    )?.runId;
    if (!runId || reportedRuntimeRunIds.current.has(runId)) return;
    void api.run(runId)
      .then(({ run }) => reportRuntimeRun(run))
      .catch(() => reportedRuntimeRunIds.current.delete(runId));
  }, [reportRuntimeRun, snapshot]);

  useEffect(() => {
    if (!snapshot || !selectedProjectFile) {
      setProjectPreview(null);
      setProjectBusy(false);
      return;
    }
    let active = true;
    setProjectBusy(true);
    void api.coordinationProjectFile(snapshot.session.id, selectedProjectFile)
      .then((result) => {
        if (active) setProjectPreview(result.file);
      })
      .catch((reason) => {
        if (active) onError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setProjectBusy(false);
      });
    return () => { active = false; };
  }, [onError, selectedProjectFile, snapshot?.session.id]);

  useEffect(() => {
    if (
      (snapshot?.session.roundExtensionRequest?.status === "pending" ||
        snapshot?.session.manualAdvanceRequest?.status === "pending") &&
      snapshot.session.createdByUserId === currentUser.id
    ) {
      roundPermissionRef.current?.focus({ preventScroll: true });
    }
  }, [currentUser.id, snapshot?.session.createdByUserId, snapshot?.session.manualAdvanceRequest, snapshot?.session.roundExtensionRequest]);

  useEffect(() => {
    if (
      !snapshot ||
      (snapshot.session.status !== "running" &&
        !(snapshot.session.mode === "automatic" && snapshot.session.status === "active"))
    ) return;
    const timer = window.setInterval(() => {
      void refreshSnapshot(snapshot.session.id)
        .then(async (next) => {
          if (next.session.status !== "running") {
            await Promise.all([
              refreshSessions(next.session.groupId),
              refreshPublications(),
              ...(next.session.projectId ? [refreshProjectFiles(next.session.id)] : []),
              onRefreshAgents(),
            ]);
          }
        })
        .catch((reason) => onError(reason instanceof Error ? reason.message : String(reason)));
    }, 300);
    return () => window.clearInterval(timer);
  }, [onError, onRefreshAgents, refreshProjectFiles, refreshPublications, refreshSessions, refreshSnapshot, snapshot]);

  const sourceMessages = useMemo(
    () => sourceChat?.events.filter(
      (event) => event.type === "human.message" || event.type === "agent.message",
    ) ?? [],
    [sourceChat],
  );

  const createTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!groupId || !title.trim() || !objective.trim()) return;
    setBusy(true);
    try {
      const next = await api.createCoordinationTask(groupId, {
        title: title.trim(),
        objective: objective.trim(),
        mode,
        participantAgentIds,
        coordinatorEnabled,
        maxCallsPerRound,
        ...(bouncerEvidenceContract
          ? {
              middlewareEvidenceRequirements: [
                { action: "resource:process" as const, decision: "allow" as const },
                { action: "resource:disclose" as const, decision: "deny" as const },
              ],
            }
          : {}),
        contextImport: contextMode === "none"
          ? { mode: "none" }
          : contextMode === "full"
            ? { mode: "full", sourceConversationId: sourceChat!.session.conversationId }
            : {
                mode: "selected",
                sourceConversationId: sourceChat!.session.conversationId,
                eventIds: selectedContextEventIds,
              },
      });
      setSnapshot(next);
      onTaskCreated?.(next.session.id);
      setParticipantAgentIds([]);
      setContextMode("none");
      setSelectedContextEventIds([]);
      setBouncerEvidenceContract(false);
      setShowTaskCreate(false);
      setMaxCallsPerRound(4);
      await Promise.all([refreshSessions(groupId), refreshPublications()]);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const reviewPublication = async (
    publication: ArtifactPublication,
    decision: "approve" | "reject",
  ) => {
    if (
      decision === "approve" &&
      !window.confirm(
        `确认把 ${publication.sourceRelativePath} 发布到群组共享区 ${publication.destinationRelativePath}？\n\n将批准哈希 ${publication.sourceSha256.slice(0, 16)}… 对应的确切文件。`,
      )
    ) return;
    setBusy(true);
    try {
      if (decision === "approve") await api.approveArtifactPublication(publication.id);
      else await api.rejectArtifactPublication(publication.id);
      await refreshPublications();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const downloadProject = async () => {
    if (!snapshot) return;
    setProjectBusy(true);
    try {
      const blob = await api.downloadCoordinationProject(snapshot.session.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const safeTitle = snapshot.session.title.replace(/[^a-zA-Z0-9._-]+/g, "-") || "task";
      link.href = url;
      link.download = `${safeTitle}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProjectBusy(false);
    }
  };

  const advance = async () => {
    if (!snapshot) return;
    const pendingStep = snapshot.steps
      .filter((step) => step.planVersion === snapshot.session.planVersion && step.status === "pending")
      .sort((left, right) => left.position - right.position)[0];
    setOptimisticActivity(
      snapshot.session.needsReplan && snapshot.session.coordinatorEnabled
        ? {
            kind: "planning",
            agentId: snapshot.session.coordinatorAgentId,
            name: agents.find((agent) => agent.id === snapshot.session.coordinatorAgentId)?.name ?? "调度 Agent",
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
      const result = await api.advanceCoordination(
        snapshot.session.id,
        snapshot.session.version,
      );
      if (result.run) reportRuntimeRun(result.run);
      setSnapshot(result.snapshot);
      await onRefreshAgents();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      await refreshSnapshot(snapshot.session.id).catch(() => undefined);
    } finally {
      setOptimisticActivity(null);
      setBusy(false);
    }
  };

  const changeMode = async (nextMode: CoordinationMode) => {
    if (!snapshot || snapshot.session.mode === nextMode) return;
    setBusy(true);
    try {
      const next = await api.setCoordinationMode(
        snapshot.session.id,
        nextMode,
        snapshot.session.version,
      );
      setSnapshot(next);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!snapshot || !message.trim()) return;
    const content = message.trim();
    setMessage("");
    setBusy(true);
    try {
      setSnapshot(await api.sendCoordinationMessage(snapshot.session.id, content));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!snapshot) return;
    const failed = snapshot.steps.find(
      (step) => step.planVersion === snapshot.session.planVersion && step.status === "failed",
    );
    if (!failed) return;
    setBusy(true);
    try {
      setSnapshot(await api.retryCoordination(
        snapshot.session.id,
        failed.id,
        snapshot.session.version,
      ));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const interrupt = async () => {
    if (!snapshot) return;
    setBusy(true);
    try {
      const next = await api.interruptCoordination(
        snapshot.session.id,
        snapshot.session.version,
      );
      setSnapshot(next);
      await onRefreshAgents();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      await refreshSnapshot(snapshot.session.id).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const resolveInterruption = async (action: "continue" | "new_round") => {
    if (!snapshot) return;
    const interruptedStep = snapshot.steps.find(
      (step) => step.id === snapshot.session.interruption?.stepId,
    );
    setOptimisticActivity(
      snapshot.session.coordinatorEnabled || action === "new_round"
        ? {
            kind: "planning",
            agentId: snapshot.session.coordinatorAgentId,
            name: agentName(snapshot.session.coordinatorAgentId),
          }
        : interruptedStep
          ? { kind: "thinking", agentId: interruptedStep.agentId, name: agentName(interruptedStep.agentId) }
          : null,
    );
    setBusy(true);
    try {
      const result = await api.resolveCoordinationInterruption(
        snapshot.session.id,
        action,
        snapshot.session.version,
      );
      setSnapshot(result.snapshot);
      await onRefreshAgents();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      await refreshSnapshot(snapshot.session.id).catch(() => undefined);
    } finally {
      setOptimisticActivity(null);
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!snapshot) return;
    setBusy(true);
    try {
      const next = await api.stopCoordination(snapshot.session.id);
      setSnapshot(next);
      await Promise.all([refreshSessions(next.session.groupId), onRefreshAgents()]);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
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
                name: agentName(next.session.coordinatorAgentId),
              }
            : pendingStep
              ? {
                  kind: "thinking",
                  agentId: pendingStep.agentId,
                  name: agentName(pendingStep.agentId),
                }
              : null,
        );
        next = (await api.advanceCoordination(next.session.id, next.session.version)).snapshot;
      }
      setSnapshot(next);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOptimisticActivity(null);
      setResolvingRoundPermission(false);
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
        snapshot.session.needsReplan && snapshot.session.coordinatorEnabled
          ? {
              kind: "planning",
              agentId: snapshot.session.coordinatorAgentId,
              name: agentName(snapshot.session.coordinatorAgentId),
            }
          : pendingStep
            ? { kind: "thinking", agentId: pendingStep.agentId, name: agentName(pendingStep.agentId) }
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
      if (result.run) reportRuntimeRun(result.run);
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

  const agentName = (id: string | null) =>
    agents.find((agent) => agent.id === id)?.name ?? id ?? "System";
  const humanName = (id: string | null) =>
    id === currentUser.id ? currentUser.displayName : id ?? "Human";
  const currentSteps = snapshot?.steps.filter(
    (step) => step.planVersion === snapshot.session.planVersion,
  ) ?? [];
  const activeStep = snapshot?.steps.find((step) => step.id === snapshot.session.activeStepId);
  const liveActivity: LiveAgentActivity | null = snapshot?.session.status === "running" && activeStep
    ? { kind: "thinking", agentId: activeStep.agentId, name: agentName(activeStep.agentId) }
    : snapshot?.session.mode === "automatic" &&
        snapshot.session.status === "active" &&
        snapshot.session.needsReplan &&
        snapshot.session.coordinatorEnabled
      ? {
          kind: "planning",
          agentId: snapshot.session.coordinatorAgentId,
          name: agentName(snapshot.session.coordinatorAgentId),
        }
      : optimisticActivity;
  const terminal = snapshot
    ? ["completed", "stopped"].includes(snapshot.session.status)
    : false;
  const isRoundInitiator = snapshot
    ? snapshot.session.kind === "task"
      ? snapshot.session.createdByUserId === currentUser.id
      : snapshot.session.controllerUserId === currentUser.id
    : false;
  const interruptionPending = snapshot?.session.interruption?.status === "cancelling" ||
    snapshot?.session.interruption?.status === "paused";
  const taskPublications = snapshot?.session.projectId
    ? publications.filter((item) => item.projectId === snapshot.session.projectId)
    : [];
  const contextSelectionInvalid =
    contextMode !== "none" &&
    (!sourceChat || sourceMessages.length === 0 ||
      contextMode === "selected" && selectedContextEventIds.length === 0);
  const bouncerContractInvalid =
    bouncerEvidenceContract && (participantAgentIds.length !== 1 || coordinatorEnabled);

  return (
    <section className="coordination-workspace">
      <header className="coordination-header">
        <div>
          <span className="eyebrow">Multi-Agent coordination middleware</span>
          <h1>Group tasks</h1>
          <p>Every turn is ordered, versioned, attributable, and checked against the group boundary.</p>
        </div>
        {!fixedGroupId && (
          <label>
            Group
            <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              {groups.map((group) => (
                <option value={group.id} key={group.id}>{group.name}</option>
              ))}
            </select>
          </label>
        )}
      </header>

      <div className="coordination-grid">
        <aside className="task-sidebar">
          {showTaskCreate ? <form className="task-create" onSubmit={createTask}>
            <span className="eyebrow">新的子任务</span>
            <label>
              Title
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} />
            </label>
            <label>
              Objective
              <textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={4} />
            </label>
            <label>
              Mode
              <select value={mode} onChange={(event) => setMode(event.target.value as CoordinationMode)}>
                <option value="manual">Manual · pause after every Agent</option>
                <option value="automatic">Automatic · continue by itself</option>
              </select>
            </label>
            <label>
              每轮最大 Agent 调用次数
              <input type="number" min={1} max={50} value={maxCallsPerRound} onChange={(event) => setMaxCallsPerRound(Math.max(1, Math.min(50, Number(event.target.value) || 1)))} />
              <small>计划本身可以更长；达到本轮实际调用额度后，调度 Agent 必须判断是否申请下一轮。</small>
            </label>
            <label className="coordinator-toggle">
              <input
                type="checkbox"
                checked={coordinatorEnabled}
                onChange={(event) => setCoordinatorEnabled(event.target.checked)}
              />
              <span>
                <strong>启用调度 Agent（推荐）</strong>
                <small>调度 Agent 可以制定更长的完整计划；每实际执行 {maxCallsPerRound} 次 Agent 后必须申请下一轮。</small>
              </span>
            </label>
            <label className="coordinator-toggle">
              <input
                type="checkbox"
                checked={bouncerEvidenceContract}
                onChange={(event) => {
                  setBouncerEvidenceContract(event.target.checked);
                  if (event.target.checked) {
                    setCoordinatorEnabled(false);
                    setMode("manual");
                  }
                }}
              />
              <span>
                <strong>启用 Bouncer 证据契约（演示推荐）</strong>
                <small>要求同一 Run 真实产生 process=allow 与 disclose=deny；缺失时后端判定步骤失败并允许重试。请选择且只选择一个 Agent。</small>
              </span>
            </label>
            <fieldset className="context-import-fieldset">
              <legend>附加群聊历史</legend>
              <label>
                上下文范围
                <select
                  value={contextMode}
                  onChange={(event) => {
                    setContextMode(event.target.value as ContextImportMode);
                    setSelectedContextEventIds([]);
                  }}
                >
                  <option value="none">不附加历史（推荐用于独立任务）</option>
                  <option value="full" disabled={sourceMessages.length === 0}>
                    附加全部群聊消息
                  </option>
                  <option value="selected" disabled={sourceMessages.length === 0}>
                    只附加我勾选的消息
                  </option>
                </select>
              </label>
              {sourceMessages.length === 0 ? (
                <p>群聊还没有可附加的消息。任务只会收到目标和任务内的新消息。</p>
              ) : contextMode === "full" ? (
                <div className="context-import-summary">
                  <strong>{sourceMessages.length} 条群聊消息</strong>
                  <span>创建任务时复制快照，之后群聊新增内容不会自动混入。</span>
                </div>
              ) : contextMode === "selected" ? (
                <div className="context-message-picker">
                  {sourceMessages.map((event) => {
                    const checked = selectedContextEventIds.includes(event.id);
                    const actor = event.actorType === "agent"
                      ? agentName(event.actorId)
                      : event.actorId === currentUser.id ? currentUser.displayName : "群组成员";
                    return (
                      <label key={event.id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(change) => setSelectedContextEventIds((current) =>
                            change.target.checked
                              ? [...current, event.id]
                              : current.filter((id) => id !== event.id),
                          )}
                        />
                        <span><strong>{actor} · #{event.sequence}</strong>{event.content}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p>不会读取群聊历史；只使用任务目标和任务内后续消息。</p>
              )}
            </fieldset>
            <fieldset>
              <legend>Participating Agents</legend>
              {groupAgents.map((agent) => (
                <label className="agent-check" key={agent.id}>
                  <input
                    type="checkbox"
                    checked={participantAgentIds.includes(agent.id)}
                    onChange={(event) => setParticipantAgentIds((current) =>
                      event.target.checked
                        ? [...current, agent.id]
                        : current.filter((id) => id !== agent.id),
                    )}
                  />
                  <span><strong>{agent.name}</strong>{agent.role}</span>
                </label>
              ))}
              {groupAgents.length === 0 && <p>Create a group Agent first.</p>}
            </fieldset>
            <button
              className="button button-primary"
              disabled={busy || groupAgents.length === 0 || contextSelectionInvalid || bouncerContractInvalid}
            >
              {busy ? "Creating…" : "Create task"}
            </button>
            <small>Leave all unchecked to include every enabled Agent in the group.</small>
            <button type="button" className="button button-ghost" onClick={() => setShowTaskCreate(false)}>取消</button>
          </form> : snapshot ? (
            <div className="task-project-sidebar">
              <div className="panel-heading">
                <div><span className="eyebrow">Task workspace</span><strong>项目文件</strong></div>
                <code>{projectFiles.length}</code>
              </div>
              <div className="project-file-actions compact">
                <button className="button button-ghost" onClick={() => void refreshProjectFiles(snapshot.session.id).catch((reason) => onError(reason instanceof Error ? reason.message : String(reason)))} disabled={projectBusy}>刷新</button>
                <button className="button button-primary" onClick={() => void downloadProject()} disabled={projectBusy}>下载 ZIP</button>
              </div>
              <div className="project-tree task-project-tree">
                {projectFiles.length > 0 ? <ProjectTree nodes={projectTree(projectFiles)} selectedPath={selectedProjectFile} onSelect={setSelectedProjectFile} /> : <p>任务目录还没有文件。</p>}
              </div>
            </div>
          ) : (
            <div className="task-sidebar-empty"><span>⇄</span><strong>从左侧选择任务</strong><small>任务现在归属于对应群组。</small></div>
          )}
        </aside>

        {showTaskCreate ? (
          <div className="task-empty"><span>＋</span><h2>创建群任务</h2><p>填写左侧信息；创建后任务会出现在最左侧对应群组下。</p></div>
        ) : snapshot ? (
          <div className="task-detail">
            <div className="task-detail-header">
              <div>
                <div className="header-title-row">
                  <h2>{snapshot.session.title}</h2>
                  <span className={`coord-status coord-${snapshot.session.status}`}>
                    {snapshot.session.status.replaceAll("_", " ")}
                  </span>
                </div>
                <p>{snapshot.session.objective}</p>
                <div className="task-context-badge">
                  <span>附加历史</span>
                  <strong>
                    {snapshot.session.contextImport?.mode === "full"
                      ? `全部群聊 · ${snapshot.session.contextImport.messages.length} 条`
                      : snapshot.session.contextImport?.mode === "selected"
                        ? `已选择 ${snapshot.session.contextImport.messages.length} 条`
                        : "无"}
                  </strong>
                  {snapshot.session.contextImport?.sourceTitle && (
                    <small>来自 {snapshot.session.contextImport.sourceTitle}</small>
                  )}
                </div>
                <div className={`task-coordinator-badge ${snapshot.session.coordinatorEnabled ? "enabled" : "disabled"}`}>
                  <span>调度 Agent</span>
                  <strong>{snapshot.session.coordinatorEnabled
                    ? snapshot.session.planVersion === 0
                      ? `已启用 · 等待首次规划（每轮 ${snapshot.session.maxCallsPerRound} 次）`
                      : `第 ${snapshot.session.currentRound} 轮 · ${snapshot.session.callsInCurrentRound}/${snapshot.session.maxCallsPerRound} 次调用`
                    : "未启用 · 单轮执行"}</strong>
                </div>
                {(snapshot.session.middlewareEvidenceRequirements?.length ?? 0) > 0 && (
                  <div className="task-context-badge">
                    <span>Bouncer 证据契约</span>
                    <strong>{snapshot.session.middlewareEvidenceRequirements!
                      .map((requirement) => `${requirement.action.replace("resource:", "")}=${requirement.decision}`)
                      .join(" · ")}</strong>
                    <small>没有真实后端决策时，本轮不会被标记为完成。</small>
                  </div>
                )}
              </div>
              <div className="task-actions">
                <select
                  value={snapshot.session.mode}
                  onChange={(event) => void changeMode(event.target.value as CoordinationMode)}
                  disabled={busy || terminal || snapshot.session.status === "running" || interruptionPending || snapshot.session.manualAdvanceRequest?.status === "pending" || snapshot.session.roundExtensionRequest?.status === "pending"}
                >
                  <option value="manual">Manual mode</option>
                  <option value="automatic">Automatic mode</option>
                </select>
                {snapshot.session.mode === "manual" && !terminal && !interruptionPending && snapshot.session.status !== "failed" && snapshot.session.manualAdvanceRequest?.status !== "pending" && (
                  <button
                    className="button button-primary"
                    onClick={() => void advance()}
                    disabled={
                      busy ||
                      snapshot.session.status === "running" ||
                      snapshot.session.roundExtensionRequest?.status === "pending" ||
                      (!snapshot.session.needsReplan && !currentSteps.some((step) => step.status === "pending"))
                    }
                  >
                    {snapshot.session.coordinatorEnabled
                      ? "调度并执行下一步"
                      : snapshot.session.needsReplan
                        ? "重新规划并继续"
                      : currentSteps.some((step) => step.status === "pending")
                        ? "执行下一位 Agent"
                        : "等待补充信息"}
                  </button>
                )}
                {snapshot.session.status === "running" && isRoundInitiator && (
                  <button className="button button-danger" onClick={() => void interrupt()} disabled={busy}>
                    中断当前轮次
                  </button>
                )}
                {snapshot.session.status === "failed" && (
                  <button className="button button-primary" onClick={() => void retry()} disabled={busy}>
                    Retry failed step
                  </button>
                )}
                {!terminal && (
                  <button className="button button-danger" onClick={() => void stop()} disabled={busy}>
                    Stop
                  </button>
                )}
              </div>
            </div>

            {snapshot.session.interruption?.status === "paused" && (
              <section className="round-extension-card" role="alert">
                <div className="round-extension-heading"><span>⏸</span>当前轮次已中断</div>
                <p className="round-extension-question">继续当前轮次，还是新开一轮？</p>
                <p className="round-extension-reason">被中断的 Agent 调用没有计入额度。你可以先在下方补充上下文，再决定如何恢复。</p>
                <small>继续会保留第 {snapshot.session.currentRound} 轮的调用计数；新开一轮会取消当前计划、轮次加一并把调用次数清零。</small>
                {isRoundInitiator ? (
                  <div className="round-extension-actions">
                    <button onClick={() => void resolveInterruption("new_round")} disabled={busy}>新开一轮</button>
                    <button className="allow" onClick={() => void resolveInterruption("continue")} disabled={busy}>继续当前轮次</button>
                  </div>
                ) : <span className="round-extension-waiting">等待发起者选择恢复方式</span>}
              </section>
            )}

            {snapshot.session.manualAdvanceRequest?.status === "pending" && !resolvingManualPermission && (
              <section
                ref={roundPermissionRef}
                className="round-extension-card"
                role="alertdialog"
                aria-label="请求进入下一个 Agent 步骤"
                tabIndex={-1}
                onKeyDown={(event) => {
                  if (busy || snapshot.session.createdByUserId !== currentUser.id) return;
                  if (event.key === "Escape") { event.preventDefault(); void resolveManualAdvance("reject"); }
                  if (event.key === "Enter") { event.preventDefault(); void resolveManualAdvance("approve"); }
                }}
              >
                <div className="round-extension-heading"><span>✋</span>请求权限</div>
                <p className="round-extension-question">是否允许进入下一步？</p>
                <p className="round-extension-reason">{snapshot.session.manualAdvanceRequest.rationale}</p>
                <small>等待期间可以继续补充信息；无人补充则执行原计划下一步，有新信息才由调度 Agent 重新规划。</small>
                {snapshot.session.createdByUserId === currentUser.id ? (
                  <div className="round-extension-actions">
                    <button onClick={() => void resolveManualAdvance("reject")} disabled={busy}>拒绝 <kbd>Esc</kbd></button>
                    <button className="allow" onClick={() => void resolveManualAdvance("approve")} disabled={busy}>允许下一步 <kbd>↵</kbd></button>
                  </div>
                ) : <span className="round-extension-waiting">等待任务发起者处理</span>}
              </section>
            )}

            {snapshot.session.roundExtensionRequest?.status === "pending" && !resolvingRoundPermission && (
              <section
                ref={roundPermissionRef}
                className="round-extension-card"
                role="alertdialog"
                aria-label="调度 Agent 请求更多轮次"
                tabIndex={-1}
                onKeyDown={(event) => {
                  if (busy || snapshot.session.createdByUserId !== currentUser.id) return;
                  if (event.key === "Escape") { event.preventDefault(); void resolveRoundExtension("reject"); }
                  if (event.key === "Enter") { event.preventDefault(); void resolveRoundExtension("approve"); }
                }}
              >
                <div className="round-extension-heading"><span>✋</span>请求权限</div>
                <p className="round-extension-question">本轮调用额度已用完，是否允许开启下一轮？</p>
                <p className="round-extension-reason">{snapshot.session.roundExtensionRequest.rationale}</p>
                <small>第 {snapshot.session.currentRound} 轮已执行 {snapshot.session.callsInCurrentRound}/{snapshot.session.maxCallsPerRound} 次 Agent 调用。</small>
                <small>批准后若无人补充新信息，将直接从原调度计划的下一步继续；有新信息时才重新规划。</small>
                {snapshot.session.createdByUserId === currentUser.id ? (
                  <div className="round-extension-actions">
                    <button onClick={() => void resolveRoundExtension("reject")} disabled={busy}>拒绝 <kbd>Esc</kbd></button>
                    <button className="allow" onClick={() => void resolveRoundExtension("approve")} disabled={busy}>允许下一轮 <kbd>↵</kbd></button>
                  </div>
                ) : <span className="round-extension-waiting">等待任务发起者处理</span>}
              </section>
            )}

            <div className="task-body-grid">
              <div className="shared-conversation">
                <div className="panel-heading">
                  <div><span className="eyebrow">Shared session</span><strong>Committed context</strong></div>
                  <code>v{snapshot.session.version} · seq {snapshot.session.lastEventSequence}</code>
                </div>
                <div className="coord-events">
                  {snapshot.events.map((event) => {
                    const isMessage = event.type === "human.message" || event.type === "agent.message";
                    return (
                      <article className={isMessage ? `coord-message ${event.actorType}` : "coord-system-event"} key={event.id}>
                        <div>
                          <strong>
                            {isMessage
                              ? event.actorType === "agent"
                                ? agentName(event.actorId)
                                : humanName(event.actorId)
                              : event.type}
                          </strong>
                          <span>#{event.sequence} · {eventTime(event.createdAt)}</span>
                        </div>
                        {event.content && <p>{event.content}</p>}
                        {!isMessage && event.type === "step.started" && (
                          <p>Invoked {agentName(String(event.metadata.agentId))} with context through #{event.metadata.contextThroughSequence}.</p>
                        )}
                        {!isMessage && event.type === "step.failed" && <p>{String(event.metadata.error ?? "Step failed")}</p>}
                        {!isMessage && event.type === "plan.replaced" && event.metadata.rationale && (
                          <p>调度判断：{String(event.metadata.rationale)}</p>
                        )}
                        {!isMessage && event.type === "coordinator.decision" && event.content && (
                          <p>调度判断：{event.content}</p>
                        )}
                      </article>
                    );
                  })}
                  {liveActivity && (
                    <article className={`coord-message agent coord-live-activity ${liveActivity.kind}`}>
                      <div>
                        <strong>{liveActivity.name}</strong>
                        <span>{liveActivity.kind === "planning" ? "正在规划调度" : "正在思考"}</span>
                      </div>
                      <p className="chat-thinking">
                        <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                        {liveActivity.kind === "planning"
                          ? "正在读取最新上下文，并决定本轮调用哪些 Agent 以及执行顺序…"
                          : "正在读取调用前的完整上下文并生成结果…"}
                      </p>
                    </article>
                  )}
                </div>
                {!terminal && (
                  <form className="coord-composer" onSubmit={sendMessage}>
                    <textarea
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder="Add context. If an Agent is running, the next step will replan after it finishes."
                      rows={2}
                    />
                    <button className="button button-ghost" disabled={busy || !message.trim()}>Send</button>
                  </form>
                )}
              </div>

              <aside className="step-panel">
                <div className="panel-heading">
                  <div><span className="eyebrow">Current plan</span><strong>Ordered Agent turns</strong></div>
                  <code>plan {snapshot.session.planVersion}</code>
                </div>
                <div className="step-list">
                  {currentSteps.map((step) => (
                    <article className={`coord-step step-${step.status}`} key={step.id}>
                      <span>{step.position}</span>
                      <div>
                        <strong>{agentName(step.agentId)}</strong>
                        <p>{step.instruction}</p>
                        <small>{step.status} · attempt {step.attempt}</small>
                        {step.error && <em>{step.error}</em>}
                      </div>
                    </article>
                  ))}
                </div>
              </aside>
            </div>

            <section className="task-project-preview-panel">
              {projectBusy && !projectPreview ? (
                <p>正在读取文件…</p>
              ) : projectPreview ? (
                <>
                  <header><strong>{projectPreview.relativePath}</strong><small>{fileSize(projectPreview.size)}{projectPreview.truncated ? " · 仅预览前 1 MB" : ""}</small></header>
                  {projectPreview.kind === "text" ? <pre>{projectPreview.content}</pre> : <div className="binary-preview">这是二进制文件，可通过 ZIP 下载。</div>}
                </>
              ) : (
                <p>项目文件位于左侧。选择文件后可在这里预览。</p>
              )}
            </section>

            <section className="publication-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Human approval gate</span>
                  <strong>任务结果发布</strong>
                </div>
                <code>{taskPublications.filter((item) => item.status === "pending").length} 待审批</code>
              </div>
              <div className="publication-list">
                {taskPublications.map((publication) => (
                  <article className={`publication-card publication-${publication.status}`} key={publication.id}>
                    <div className="publication-file">
                      <span>{publication.status === "pending" ? "待审批" : publication.status}</span>
                      <strong>{publication.sourceRelativePath}</strong>
                      <small>发布到 shared/{publication.destinationRelativePath}</small>
                    </div>
                    <div className="publication-proof">
                      <code>{publication.sourceSha256.slice(0, 16)}…</code>
                      <span>{Math.max(1, Math.ceil(publication.sourceSize / 1024))} KB · {agentName(publication.proposedByAgentId)}</span>
                    </div>
                    {publication.status === "pending" && (
                      <div className="publication-actions">
                        <button
                          className="button button-ghost"
                          onClick={() => void reviewPublication(publication, "reject")}
                          disabled={busy}
                        >
                          拒绝
                        </button>
                        <button
                          className="button button-primary"
                          onClick={() => void reviewPublication(publication, "approve")}
                          disabled={busy}
                        >
                          核对并批准
                        </button>
                      </div>
                    )}
                  </article>
                ))}
                {taskPublications.length === 0 && (
                  <div className="publication-empty">
                    Agent 生成的文件仍留在任务目录。只有 Agent 发起发布申请后，才会在这里请求你批准写入群组共享区。
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : (
          <div className="task-empty">
            <span>⇄</span>
            <h2>Create or select a group task</h2>
            <p>Manual mode pauses between Agents. Automatic mode continues while preserving every committed message.</p>
          </div>
        )}
      </div>
    </section>
  );
}
