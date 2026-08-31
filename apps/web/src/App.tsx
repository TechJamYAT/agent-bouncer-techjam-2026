import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, ApiError, setAuthToken } from "./api";
import { CoordinationWorkspace } from "./CoordinationWorkspace";
import { GroupChat } from "./GroupChat";
import { GroupMembers } from "./GroupMembers";
import { HumanDirectChat } from "./DirectMessages";
import { AuthorizationEvidenceWindow } from "./AuthorizationEvidenceWindow";
import { AccessRequestCard } from "./AccessRequestCard";
import { MarkdownContent } from "./MarkdownContent";
import { RuntimeProcessWindow } from "./RuntimeProcessWindow";
import { LanguageToggle, useI18n } from "./i18n";
import {
  GroupWorkspace,
  PersonalWorkspace,
  type GroupSection,
  type PersonalSection,
} from "./WorkspaceViews";
import type {
  AccessRequest,
  Agent,
  AgentRun,
  AuthorizationDecision,
  CoordinationSession,
  DirectConversationSummary,
  Group,
  Message,
  ProtectedResource,
  ResourceGrant,
  SystemInfo,
  User,
} from "./types";

const activeRunStatuses = new Set<AgentRun["status"]>([
  "queued",
  "running",
  "waiting_for_approval",
]);

interface AgentForm {
  name: string;
  role: string;
  description: string;
  instructions: string;
  scope: "personal" | "group";
  groupId: string;
}

interface ResourceForm {
  title: string;
  content: string;
  scope: "private" | "group";
  groupId: string;
}

type AppView = "personal" | "group" | "agent" | "human-chat";
type ConversationFilter = "all" | "human" | "agent" | "group";

const emptyForm: AgentForm = {
  name: "",
  role: "General Assistant",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
  scope: "personal",
  groupId: "",
};

const emptyResourceForm: ResourceForm = {
  title: "",
  content: "",
  scope: "private",
  groupId: "",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  const { t } = useI18n();
  const label = status === "ready"
    ? t("就绪", "Ready")
    : status === "busy"
      ? t("运行中", "Busy")
      : status === "stopped"
        ? t("已停用", "Stopped")
        : status === "error"
          ? t("错误", "Error")
          : t("已删除", "Deleted");
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {label}
    </span>
  );
}

function Spinner() {
  const { t } = useI18n();
  return <span className="spinner" aria-label={t("加载中", "Loading")} />;
}

export default function App() {
  const { t } = useI18n();
  const starterPrompts = [
    {
      label: t("创建一个从示例 JSON 输出天气摘要的 TypeScript CLI。", "Create a small TypeScript CLI that prints a weather summary from sample JSON."),
      prompt: "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
    },
    {
      label: t("检查这个工作区，并说明最值得优先改进的地方。", "Inspect this workspace and explain what you would improve first."),
      prompt: "Inspect this workspace and explain what you would improve first.",
    },
    {
      label: t("构建一个带测试的响应式单页待办应用。", "Build a responsive single-page todo app with tests."),
      prompt: "Build a responsive single-page todo app with tests.",
    },
  ];
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [directConversations, setDirectConversations] = useState<DirectConversationSummary[]>([]);
  const [selectedHumanPeerId, setSelectedHumanPeerId] = useState<string | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null | undefined>(undefined);
  const [resources, setResources] = useState<ProtectedResource[]>([]);
  const [grants, setGrants] = useState<ResourceGrant[]>([]);
  const [decisions, setDecisions] = useState<AuthorizationDecision[]>([]);
  const [accessRequests, setAccessRequests] = useState<AccessRequest[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showCreateResource, setShowCreateResource] = useState(false);
  const [resourceForm, setResourceForm] = useState<ResourceForm>(emptyResourceForm);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [grantAgentId, setGrantAgentId] = useState("");
  const [taskGrantTarget, setTaskGrantTarget] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showAuthorizationEvidence, setShowAuthorizationEvidence] = useState(false);
  const [runtimeProcessRunId, setRuntimeProcessRunId] = useState<string | null>(null);
  const [runtimeProcessAgentId, setRuntimeProcessAgentId] = useState<string | null>(null);
  const [view, setView] = useState<AppView>("personal");
  const [personalSection, setPersonalSection] = useState<PersonalSection>("conversations");
  const [conversationFilter, setConversationFilter] = useState<ConversationFilter>("all");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState("");
  const [groupSection, setGroupSection] = useState<GroupSection>("chat");
  const [groupTasks, setGroupTasks] = useState<Record<string, CoordinationSession[]>>({});
  const [expandedGroupIds, setExpandedGroupIds] = useState<string[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskCreateRequest, setTaskCreateRequest] = useState(0);
  const [creatingTask, setCreatingTask] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [attachedResourceId, setAttachedResourceId] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const [username, setUsername] = useState("alice");
  const [password, setPassword] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const forceScrollAfterConversationLoad = useRef(false);
  const shouldFollowNewMessages = useRef(true);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const selectedHumanConversation = useMemo(
    () => directConversations.find(
      (item) => item.peerType === "human" && item.peerId === selectedHumanPeerId,
    ) ?? null,
    [directConversations, selectedHumanPeerId],
  );
  const selectedGroup = selected?.groupId
    ? groups.find((group) => group.id === selected.groupId) ?? null
    : null;
  const canManageSelectedAgent = Boolean(
    selected &&
    !selected.systemManaged &&
    (selected.scope === "personal" ||
      selectedGroup?.role === "owner" ||
      selectedGroup?.role === "admin"),
  );
  const manageableGroups = groups.filter(
    (group) => group.role === "owner" || group.role === "admin",
  );
  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null;
  const personalResources = resources.filter(
    (resource) => resource.scope === "private" && resource.ownerUserId === currentUser?.id,
  );
  const activeGroupAgents = activeGroup
    ? agents.filter(
        (agent) =>
          (agent.scope === "group" || agent.scope === "coordinator") &&
          agent.groupId === activeGroup.id,
      )
    : [];
  const activeGroupResources = activeGroup
    ? resources.filter((resource) => resource.scope === "group" && resource.groupId === activeGroup.id)
    : [];
  const activeGroupAgentIds = new Set(activeGroupAgents.map((agent) => agent.id));
  const activeGroupDecisions = decisions.filter(
    (decision) => decision.executingAgentId && activeGroupAgentIds.has(decision.executingAgentId),
  );
  const selectedResource = resources.find((resource) => resource.id === selectedResourceId) ?? null;
  const personalGrantAgents = agents.filter(
    (agent) => agent.scope === "personal" && agent.ownerUserId === currentUser?.id,
  );
  const taskGrantTargets = Object.values(groupTasks).flatMap((tasks) =>
    tasks
      .filter((task) => !["completed", "stopped"].includes(task.status))
      .flatMap((task) => task.participantAgentIds.flatMap((agentId) => {
        const agent = agents.find(
          (item) => item.id === agentId && item.scope === "group" && item.groupId === task.groupId,
        );
        return agent ? [{ task, agent, value: `${task.id}|${agent.id}` }] : [];
      })),
  );
  const selectedResourceGrants = selectedResource
    ? grants.filter((grant) => grant.resourceId === selectedResource.id)
    : [];
  const selectedResourceDecisions = selectedResource
    ? decisions.filter(
        (decision) => decision.targetType === "resource" && decision.targetId === selectedResource.id,
      ).slice(0, 8)
    : [];
  const selectedAgentDecisions = selected
    ? decisions.filter(
        (decision) =>
          decision.executingAgentId === selected.id &&
          (decision.action === "resource:list" ||
            decision.action === "resource:read" ||
            decision.action === "resource:process" ||
            decision.action === "resource:disclose" ||
            decision.action === "resource:forward" ||
            decision.action === "grant:create" ||
            decision.action === "grant:revoke"),
      ).slice(0, 40)
    : [];
  const runtimeProcessRun = runtimeProcessRunId
    ? runs.find((run) => run.id === runtimeProcessRunId) ??
      (activeRun?.id === runtimeProcessRunId ? activeRun : null)
    : null;
  const runtimeProcessAgent = runtimeProcessAgentId
    ? agents.find((agent) => agent.id === runtimeProcessAgentId) ?? null
    : null;
  const runtimeProcessDecisions = runtimeProcessRun
    ? decisions.filter((decision) => decision.runId === runtimeProcessRun.id)
    : [];
  const runtimeProcessAccessRequests = runtimeProcessRun
    ? accessRequests
        .filter((request) => request.runId === runtimeProcessRun.id)
        .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
    : [];
  const selectedPendingAccessRequests = selected
    ? accessRequests
        .filter((request) => request.agentId === selected.id && request.status === "pending")
        .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
    : [];
  const sidebarChats = useMemo(() => [
    ...directConversations.map((conversation) => ({
      kind: "direct" as const,
      id: `${conversation.peerType}:${conversation.peerId}`,
      updatedAt: conversation.updatedAt ?? "",
      conversation,
    })),
    ...groups.map((group) => ({
      kind: "group" as const,
      id: `group:${group.id}`,
      updatedAt: group.lastActivityAt ?? "",
      group,
    })),
  ].filter((item) => {
    if (conversationFilter === "all") return true;
    if (item.kind === "group") return conversationFilter === "group";
    return item.conversation.peerType === conversationFilter;
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [conversationFilter, directConversations, groups]);

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : null,
    );
  }, []);

  const refreshDirectConversations = useCallback(async () => {
    const result = await api.directConversations();
    if (mountedRef.current) setDirectConversations(result.conversations);
  }, []);

  const reportError = useCallback((message: string) => setError(message), []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshSecurity = useCallback(async () => {
    const [resourceResult, grantResult, decisionResult, accessRequestResult] = await Promise.all([
      api.resources(),
      api.grants(),
      api.decisions(),
      api.accessRequests(),
    ]);
    setResources(resourceResult.resources);
    setGrants(grantResult.grants);
    setDecisions(decisionResult.decisions);
    setAccessRequests(accessRequestResult.accessRequests);
  }, []);

  const refreshGroups = useCallback(async () => {
    const result = await api.groups();
    setGroups(result.groups);
    const taskEntries = await Promise.all(result.groups.map(async (group) => {
      const sessions = await api.coordinationSessions(group.id);
      return [group.id, sessions.sessions.filter((session) => session.kind === "task")] as const;
    }));
    setGroupTasks(Object.fromEntries(taskEntries));
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      refreshDirectConversations(),
      api.system().then(setSystem),
      refreshGroups(),
      refreshSecurity(),
    ]);
  }, [refreshAgents, refreshDirectConversations, refreshGroups, refreshSecurity]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) {
          const { user } = await api.session();
          if (!mountedRef.current) return;
          setCurrentUser(user);
          if (user) await bootstrap();
        }
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setRuns([]);
    setRuntimeProcessRunId(null);
    setShowSettings(false);
    setMessages([]);
    setAttachedResourceId("");
    if (!selectedId) {
      return;
    }
    void Promise.all([api.messages(selectedId), api.runs(selectedId)])
      .then(([messageResult, runResult]) => {
        if (selectedIdRef.current !== selectedId) return;
        forceScrollAfterConversationLoad.current = true;
        shouldFollowNewMessages.current = true;
        setMessages(messageResult.messages);
        setRuns(runResult.runs);
        const latest = runResult.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && activeRunStatuses.has(latest.status)) {
          setRuntimeProcessRunId(latest.id);
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        role: selected.role,
        description: selected.description,
        instructions: selected.instructions,
        scope: selected.scope === "group" ? "group" : "personal",
        groupId: selected.groupId ?? "",
      });
    }
  }, [selected]);

  useLayoutEffect(() => {
    if (forceScrollAfterConversationLoad.current) {
      forceScrollAfterConversationLoad.current = false;
      messageEnd.current?.scrollIntoView({ behavior: "auto", block: "end" });
      return;
    }
    if (shouldFollowNewMessages.current) {
      messageEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, selectedId]);

  const trackConversationScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldFollowNewMessages.current = distanceFromBottom <= 48;
  };

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent({
        name: form.name,
        role: form.role,
        description: form.description,
        instructions: form.instructions,
        scope: form.scope,
        ...(form.scope === "group" ? { groupId: form.groupId } : {}),
      });
      await refreshAgents();
      await refreshDirectConversations();
      setSelectedId(agent.id);
      setView("agent");
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, {
        name: form.name,
        role: form.role,
        description: form.description,
        instructions: form.instructions,
      });
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgentById = async (agent: Agent) => {
    if (!window.confirm(t(
      `删除 ${agent.name} 的配置？已有对话、任务和项目文件会继续由个人或群组保留。运行中的群任务需要先停止。`,
      `Delete ${agent.name}'s configuration? Existing conversations, tasks, and project files remain owned by their person or group. Running group tasks must be stopped first.`,
    ))) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(agent.id);
      await refreshAgents();
      if (selectedIdRef.current === agent.id) {
        if (agent.groupId) openGroup(agent.groupId, "agents");
        else {
          setPersonalSection("agents");
          setView("personal");
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (selected) await deleteAgentById(selected);
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const [result, decisionResult, accessRequestResult] = await Promise.all([
          api.run(runId),
          api.decisions().catch(() => null),
          api.accessRequests().catch(() => null),
        ]);
        if (decisionResult) setDecisions(decisionResult.decisions);
        if (accessRequestResult) setAccessRequests(accessRequestResult.accessRequests);
        setRuns((current) => current.some((run) => run.id === result.run.id)
          ? current.map((run) => run.id === result.run.id ? result.run : run)
          : [result.run, ...current]);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!activeRunStatuses.has(result.run.status)) {
          await Promise.all([
            refreshMessages(agentId),
            refreshAgents(),
            refreshDirectConversations(),
            refreshSecurity(),
          ]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    const attachedResource = personalResources.find(
      (resource) => resource.id === attachedResourceId,
    ) ?? null;
    setPrompt("");
    setAttachedResourceId("");
    setError(null);
    try {
      const result = await api.sendMessage(
        selected.id,
        content,
        attachedResource && currentUser
          ? [{ ownerUsername: currentUser.username, title: attachedResource.title }]
          : [],
      );
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        setRuns((current) => [result.run, ...current]);
        setRuntimeProcessRunId(result.run.id);
        setRuntimeProcessAgentId(selected.id);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await refreshDirectConversations();
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setPrompt(content);
      if (attachedResource) setAttachedResourceId(attachedResource.id);
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      const { user } = await api.session();
      setAuthRequired(false);
      setCurrentUser(user);
      if (user) await bootstrap();
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError(t("访问令牌无效。", "The access token is not valid."));
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(username, password);
      setCurrentUser(result.user);
      setPassword("");
      await bootstrap();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.logout();
      setCurrentUser(null);
      setAgents([]);
      setDirectConversations([]);
      setSelectedId(null);
      setSelectedHumanPeerId(null);
      setResources([]);
      setGrants([]);
      setDecisions([]);
      setRuntimeProcessRunId(null);
      setRuntimeProcessAgentId(null);
      setGroups([]);
      setView("personal");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const openAgent = (agentId: string) => {
    setSelectedId(agentId);
    setShowSettings(false);
    setView("agent");
  };

  const openDirectConversation = (conversation: DirectConversationSummary) => {
    setPersonalSection("conversations");
    if (conversation.peerType === "agent") {
      setSelectedHumanPeerId(null);
      openAgent(conversation.peerId);
      return;
    }
    setSelectedHumanPeerId(conversation.peerId);
    setSelectedId(null);
    setView("human-chat");
  };

  const openAgentSettings = (agentId: string) => {
    setSelectedId(agentId);
    setShowSettings(true);
    setView("agent");
  };

  const openPersonalAgentCreate = () => {
    setForm({ ...emptyForm, scope: "personal", groupId: "" });
    setShowCreate(true);
  };

  const openGroupAgentCreate = (groupId: string) => {
    setForm({ ...emptyForm, scope: "group", groupId });
    setShowCreate(true);
  };

  const openGroup = (groupId: string, section: GroupSection = "chat") => {
    setActiveGroupId(groupId);
    setGroupSection(section);
    setExpandedGroupIds((current) => current.includes(groupId) ? current : [...current, groupId]);
    setView("group");
  };

  const toggleGroupTasks = (groupId: string) => {
    setExpandedGroupIds((current) => current.includes(groupId)
      ? current.filter((id) => id !== groupId)
      : [...current, groupId]);
  };

  const openGroupTask = (groupId: string, taskId: string) => {
    setCreatingTask(false);
    setSelectedTaskId(taskId);
    openGroup(groupId, "tasks");
  };

  const createGroupTask = (groupId: string) => {
    setCreatingTask(true);
    setSelectedTaskId(null);
    setTaskCreateRequest((current) => current + 1);
    openGroup(groupId, "tasks");
  };

  const updateGroupTasks = useCallback((groupId: string, sessions: CoordinationSession[]) => {
    setGroupTasks((current) => ({ ...current, [groupId]: sessions }));
    if (!creatingTask && groupId === activeGroupId && groupSection === "tasks") {
      setSelectedTaskId((current) => current ?? sessions[0]?.id ?? null);
    }
  }, [activeGroupId, creatingTask, groupSection]);

  const openResourceCreate = (
    scope: ResourceForm["scope"],
    groupId = "",
  ) => {
    setResourceForm({ ...emptyResourceForm, scope, groupId });
    setShowCreateResource(true);
  };

  const openResource = (resource: ProtectedResource) => {
    setSelectedResourceId(resource.id);
    setGrantAgentId(personalGrantAgents[0]?.id ?? "");
    setTaskGrantTarget(taskGrantTargets[0]?.value ?? "");
  };

  const createResource = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { resource } = await api.createResource({
        title: resourceForm.title,
        content: resourceForm.content,
        scope: resourceForm.scope,
        ...(resourceForm.scope === "group" ? { groupId: resourceForm.groupId } : {}),
      });
      await refreshSecurity();
      setShowCreateResource(false);
      setResourceForm(emptyResourceForm);
      setSelectedResourceId(resource.id);
      setGrantAgentId(personalGrantAgents[0]?.id ?? "");
      setTaskGrantTarget(taskGrantTargets[0]?.value ?? "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const grantSelectedResource = async () => {
    if (!selectedResource || !grantAgentId) return;
    setBusy(true);
    setError(null);
    try {
      await api.grantResource(selectedResource.id, grantAgentId);
      await refreshSecurity();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const grantSelectedResourceForTask = async () => {
    if (!selectedResource || !taskGrantTarget) return;
    const [taskId, agentId] = taskGrantTarget.split("|");
    if (!taskId || !agentId) return;
    setBusy(true);
    setError(null);
    try {
      await api.grantResource(selectedResource.id, agentId, {
        duration: "task",
        taskId,
        action: "process",
      });
      await refreshSecurity();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const revokeSelectedGrant = async (grantId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.revokeGrant(grantId);
      await refreshSecurity();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createGroup = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!groupName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { group } = await api.createGroup({
        name: groupName.trim(),
        description: groupDescription.trim(),
      });
      const result = await api.groups();
      setGroups(result.groups);
      setGroupName("");
      setGroupDescription("");
      setShowCreateGroup(false);
      openGroup(group.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <LanguageToggle />
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>{t("正在连接控制面", "Connecting to the control plane")}</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <LanguageToggle />
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>{t("输入访问令牌", "Enter the access token")}</h1>
          <p>{t("共享演示令牌由平台管理员配置。", "This shared demo token is configured by the platform operator.")}</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            {t("访问令牌", "Access token")}
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : t("打开 Launchpad", "Open Launchpad")}
          </button>
        </form>
      </main>
    );
  }

  if (currentUser === undefined) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <LanguageToggle />
          <div className="brand-mark">A</div>
          <span className="eyebrow">Bouncer control plane</span>
          <h1>{t("正在检查会话", "Checking your session")}</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={login}>
          <LanguageToggle />
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad · Track B</span>
          <h1>{t("选择真实身份", "Choose a real identity")}</h1>
          <p>{t("所有授权均基于当前登录身份判定，绝不信任 Agent 输入。", "Authorization is evaluated from this signed-in identity, never from Agent input.")}</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            {t("用户名", "Username")}
            <input
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="alice"
              required
            />
          </label>
          <label>
            {t("密码", "Password")}
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="launchpad-demo"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy}>
            {busy ? <Spinner /> : t("登录", "Sign in")}
          </button>
          <div className="demo-account-note">
            {t("演示用户：alice、bob、carol、david、emma · 默认密码：launchpad-demo", "Demo users: alice, bob, carol, david, emma · default password: launchpad-demo")}
          </div>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>
        <LanguageToggle compact />

        <nav className="primary-nav">
          <div className="sidebar-mode-tabs" aria-label={t("主要空间", "Main spaces")}>
            <button className={!(view === "personal" && personalSection === "knowledge") ? "selected" : ""} onClick={() => { setPersonalSection("conversations"); setView("personal"); }}>{t("聊天", "Chats")}</button>
            <button className={view === "personal" && personalSection === "knowledge" ? "selected" : ""} onClick={() => { setPersonalSection("knowledge"); setView("personal"); }}>{t("我的知识库", "My knowledge")}</button>
          </div>
          {!(view === "personal" && personalSection === "knowledge") && <>
            <div className="sidebar-chat-heading"><span>{t("聊天", "Chats")}</span><button onClick={() => setCreateMenuOpen((current) => !current)} title={t("创建", "Create")}>{createMenuOpen ? "×" : "＋"}</button></div>
            {createMenuOpen && <div className="sidebar-create-menu">
              <button onClick={() => { setCreateMenuOpen(false); openPersonalAgentCreate(); }}><span>◇</span><strong>{t("创建个人 Agent", "Create personal Agent")}</strong></button>
              <button onClick={() => { setCreateMenuOpen(false); setShowCreateGroup(true); }}><span>◎</span><strong>{t("创建群聊", "Create group chat")}</strong></button>
              <button onClick={() => { setCreateMenuOpen(false); setPersonalSection("agents"); setView("personal"); }}><span>⚙</span><strong>{t("管理 Agents", "Manage Agents")}</strong></button>
            </div>}
            <div className="sidebar-chat-filters" aria-label={t("聊天分类", "Chat categories")}>
              {([['all', t('全部', 'All')], ['human', t('个人', 'People')], ['agent', 'Agent'], ['group', t('群聊', 'Groups')]] as const).map(([id, label]) => <button key={id} className={conversationFilter === id ? "selected" : ""} onClick={() => setConversationFilter(id)}>{label}</button>)}
            </div>
            <div className="sidebar-flat-chat-list">
            {sidebarChats.map((item) => {
              if (item.kind === "direct") {
                const conversation = item.conversation;
                const active = conversation.peerType === "human"
                  ? view === "human-chat" && selectedHumanPeerId === conversation.peerId
                  : view === "agent" && selectedId === conversation.peerId;
                return <button key={item.id} className={active ? "selected" : ""} onClick={() => openDirectConversation(conversation)}><span className={conversation.peerType}>{conversation.title.slice(0, 1).toUpperCase()}</span><strong>{conversation.title}</strong><em>{conversation.peerType === "human" ? t("个人", "Person") : "Agent"}</em></button>;
              }
              const group = item.group;
              const expanded = expandedGroupIds.includes(group.id);
              const tasks = groupTasks[group.id] ?? [];
              return <div className="sidebar-group-node flat" key={item.id}>
                <div className={`sidebar-group-row ${view === "group" && activeGroupId === group.id ? "selected" : ""}`}>
                  <button className="sidebar-group-main" onClick={() => openGroup(group.id)}><span>{group.name.slice(0, 1).toUpperCase()}</span><strong>{group.name}</strong><em>{t("群聊", "Group")}</em></button>
                  <div className="sidebar-group-actions">
                    <button onClick={() => createGroupTask(group.id)} aria-label={t(`在 ${group.name} 新建任务`, `Create a task in ${group.name}`)} title={t("新建任务", "New task")}>＋</button>
                    <button onClick={() => toggleGroupTasks(group.id)} aria-label={expanded ? t(`收起 ${group.name} 的任务`, `Collapse ${group.name} tasks`) : t(`展开 ${group.name} 的任务`, `Expand ${group.name} tasks`)}>{expanded ? "▾" : "›"}</button>
                  </div>
                </div>
                {expanded && <div className="sidebar-task-list">{tasks.map((task) => <button key={task.id} className={view === "group" && activeGroupId === group.id && selectedTaskId === task.id ? "selected" : ""} onClick={() => openGroupTask(group.id, task.id)}><span>└</span><strong>{task.title}</strong><em>{task.status === "completed" ? t("完成", "Done") : task.status === "running" ? t("运行中", "Running") : t("进行中", "Active")}</em></button>)}{tasks.length === 0 && <small>{t("暂无任务", "No tasks")}</small>}</div>}
              </div>;
            })}
            {sidebarChats.length === 0 && <small className="sidebar-chat-empty">{t("这个分类还没有聊天。", "No chats in this category yet.")}</small>}
            </div>
          </>}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? t("检查中…", "Checking…")}</strong>
          <span>
            {system?.arkModel ?? t("未配置 Ark 模型", "Ark model not configured")}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
        <div className="user-card">
          <div className="user-avatar">{currentUser.displayName.slice(0, 1)}</div>
          <div>
            <strong>{currentUser.displayName}</strong>
            <span>@{currentUser.username} · {t("已验证会话", "verified session")}</span>
          </div>
          <button onClick={() => void logout()} disabled={busy} title={t("退出登录", "Sign out")}>↪</button>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>{t("需要配置 Runtime", "Runtime configuration needed")}</strong>
              <p>
                {!system?.arkConfigured
                  ? t("使用 Playground 前，请在 .env 中设置 ARK_API_KEY 和 ARK_MODEL。", "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground.")
                  : system.runtimeProvider === "container"
                    ? t("本地容器引擎或 Agent Runtime 镜像不可用，请重新运行 npm run poc。", "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc.")
                    : t("未找到 Codex CLI，请使用 Docker 镜像或安装 @openai/codex。", "Codex CLI was not found. Use the Docker image or install @openai/codex.")}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {view === "personal" ? (
          <PersonalWorkspace
            section={personalSection}
            agents={agents}
            resources={personalResources}
            conversations={directConversations}
            onCreateAgent={openPersonalAgentCreate}
            onOpenAgent={openAgent}
            onEditAgent={openAgentSettings}
            onDeleteAgent={(agent) => void deleteAgentById(agent)}
            onCreateResource={() => openResourceCreate("private")}
            onOpenResource={openResource}
          />
        ) : view === "group" && activeGroup ? (
          <GroupWorkspace
            group={activeGroup}
            section={groupSection}
            agents={activeGroupAgents}
            resources={activeGroupResources}
            decisions={activeGroupDecisions}
            onSectionChange={(section) => {
              setCreatingTask(false);
              setGroupSection(section);
              if (section === "tasks" && !selectedTaskId) {
                setSelectedTaskId(groupTasks[activeGroup.id]?.[0]?.id ?? null);
              }
            }}
            onCreateAgent={() => openGroupAgentCreate(activeGroup.id)}
            onOpenAgent={openAgent}
            onEditAgent={openAgentSettings}
            onDeleteAgent={(agent) => void deleteAgentById(agent)}
            onCreateResource={() => openResourceCreate("group", activeGroup.id)}
            onOpenResource={openResource}
            chatContent={
              <GroupChat
                group={activeGroup}
                agents={activeGroupAgents}
                currentUser={currentUser}
                onError={reportError}
                onOpenAgents={() => setGroupSection("agents")}
                onActivity={() => void refreshGroups()}
              />
            }
            membersContent={
              <GroupMembers
                group={activeGroup}
                currentUser={currentUser}
                onChanged={refreshGroups}
                onError={reportError}
              />
            }
          >
            <CoordinationWorkspace
              agents={agents}
              groups={groups}
              currentUser={currentUser}
              fixedGroupId={activeGroup.id}
              selectedSessionId={selectedTaskId}
              createRequest={taskCreateRequest}
              onError={reportError}
              onRefreshAgents={refreshAgents}
              onSessionsChanged={updateGroupTasks}
              onTaskCreated={(sessionId) => { setCreatingTask(false); setSelectedTaskId(sessionId); }}
              onRuntimeRunStarted={(run) => {
                setRuns((current) => current.some((item) => item.id === run.id)
                  ? current.map((item) => item.id === run.id ? run : item)
                  : [run, ...current]);
                setRuntimeProcessAgentId(run.agentId);
                setRuntimeProcessRunId(run.id);
                void pollRun(run.id, run.agentId);
              }}
            />
          </GroupWorkspace>
        ) : view === "human-chat" && selectedHumanConversation ? (
          <HumanDirectChat
            peer={selectedHumanConversation}
            currentUser={currentUser}
            onError={reportError}
            onSent={() => void refreshDirectConversations()}
          />
        ) : view === "agent" && selected ? (
          <section className="direct-agent-chat direct-agent-chat-standalone">
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                  <span className="scope-pill">
                    {selected.scope === "personal" ? t("个人", "Personal") : selectedGroup?.name ?? t("群组", "Group")}
                  </span>
                </div>
                <p>
                  {selected.role} · {selected.description || t("在当前对话或任务的受限目录中运行。", "Runs inside the restricted directory for the current conversation or task.")}
                </p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost authorization-evidence-trigger"
                  onClick={() => {
                    setShowAuthorizationEvidence(true);
                    void refreshSecurity().catch((reason) =>
                      setError(reason instanceof Error ? reason.message : String(reason)),
                    );
                  }}
                >
                  {t("权限证据", "Authorization evidence")}
                  {selectedAgentDecisions.length > 0 && <span>{selectedAgentDecisions.length}</span>}
                </button>
                {(activeRun ?? runs[0]) && (
                  <button
                    className="button button-ghost runtime-process-trigger"
                    onClick={() => {
                      setRuntimeProcessAgentId(selected.id);
                      setRuntimeProcessRunId((activeRun ?? runs[0])!.id);
                    }}
                  >
                    <i className={activeRun && activeRunStatuses.has(activeRun.status) ? "is-live" : ""} />
                    {t("后端过程", "Backend trace")}
                  </button>
                )}
                {canManageSelectedAgent && <><button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  {t("编辑配置", "Edit configuration")}
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? t("启用", "Enable") : t("停用", "Disable")}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  {t("删除", "Delete")}
                </button></>}
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">{t("Agent 配置", "Agent configuration")}</span>
                    <h2>{t("身份与提示词", "Identity and prompt")}</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    {t("名称", "Name")}
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    {t("角色", "Role")}
                    <input
                      value={form.role}
                      onChange={(event) => setForm({ ...form, role: event.target.value })}
                      maxLength={120}
                    />
                  </label>
                </div>
                <label>
                  {t("简介", "Description")}
                  <input
                    value={form.description}
                    onChange={(event) =>
                      setForm({ ...form, description: event.target.value })
                    }
                    maxLength={500}
                  />
                </label>
                <label>
                  {t("Agent 提示词", "Agent instructions")}
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <small>{t("Agent 配置会在每次独立对话或任务运行时注入。", "Agent configuration is injected into each independent conversation or task Run.")}</small>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : t("保存修改", "Save changes")}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div
                className="messages"
                onScroll={trackConversationScroll}
              >
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>{t(`${selected.name} 应该构建什么？`, `What should ${selected.name} build?`)}</h3>
                    <p>
                      {t("Agent 可以检查文件、编写代码、运行命令，并在多条消息间延续同一 Codex 会话。", "The Agent can inspect files, write code, run commands, and continue the same Codex session across messages.")}
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item.prompt} onClick={() => setPrompt(item.prompt)}>
                          <span>↗</span>
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? t("你", "You") : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <MarkdownContent className="message-body" content={message.content} />
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && selectedPendingAccessRequests.length === 0 && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>{t("正在处理当前对话或任务目录", "Processing the current conversation or task directory")}</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      {t("Codex 正在读取、编辑或运行命令…", "Codex is reading, editing, or running commands…")}
                    </div>
                  </article>
                )}
                {selectedPendingAccessRequests.map((request) => (
                  <AccessRequestCard
                    key={request.id}
                    request={request}
                    currentUser={currentUser}
                    onResolve={async (id, resolution) => {
                      const result = resolution === "approve"
                        ? await api.approveAccessRequest(id)
                        : await api.rejectAccessRequest(id);
                      setAccessRequests((current) => current.map((item) =>
                        item.id === result.accessRequest.id ? result.accessRequest : item
                      ));
                    }}
                  />
                ))}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>{t("Run 失败", "Run failed")}</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? t("请先启用这个 Agent", "Enable this Agent first")
                      : t("输入消息…", "Type a message…")
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && activeRunStatuses.has(activeRun.status)
                  }
                  rows={2}
                />
                <div className="composer-footer">
                  <div className="composer-controls">
                    {personalResources.length > 0 ? (
                      <select
                        className={attachedResourceId ? "has-resource" : ""}
                        value={attachedResourceId}
                        onChange={(event) => setAttachedResourceId(event.target.value)}
                        disabled={
                          selected.status === "stopped" ||
                          selected.status === "busy" ||
                          (activeRun != null && activeRunStatuses.has(activeRun.status))
                        }
                        title={t("附加即表示仅授权该 Agent 在本次运行中读取这份资料", "Attaching grants this Agent read access to this resource for this Run only")}
                      >
                        <option value="">{t("＋ 附加资料", "＋ Attach resource")}</option>
                        {personalResources.map((resource) => (
                          <option key={resource.id} value={resource.id}>{resource.title}</option>
                        ))}
                      </select>
                    ) : <span />}
                  </div>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && activeRunStatuses.has(activeRun.status))
                    }
                    aria-label={t("发送消息", "Send message")}
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </section>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>{t("Runtime 已准备好接入 Agent。", "Your runtime is ready for an Agent.")}</h1>
            <p>{t("创建 Agent 并开始对话；项目文件归个人或群组，而不是归 Agent。", "Create an Agent and start a conversation; project files belong to a person or group, not to the Agent.")}</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              {t("创建你的第一个 Agent", "Create your first Agent")}
            </button>
          </div>
        )}
      </main>

      {showAuthorizationEvidence && selected && currentUser && (
        <AuthorizationEvidenceWindow
          agent={selected}
          currentUser={currentUser}
          decisions={selectedAgentDecisions}
          runs={runs}
          onClose={() => setShowAuthorizationEvidence(false)}
          onRefresh={() => void refreshSecurity().catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          )}
        />
      )}

      {runtimeProcessRun && runtimeProcessAgent && currentUser && (
        <RuntimeProcessWindow
          key={runtimeProcessRun.id}
          agent={runtimeProcessAgent}
          currentUser={currentUser}
          run={runtimeProcessRun}
          decisions={runtimeProcessDecisions}
          accessRequests={runtimeProcessAccessRequests}
          onClose={() => setRuntimeProcessRunId(null)}
          onRefresh={() => void Promise.all([
            api.run(runtimeProcessRun.id).then(({ run }) => {
              setActiveRun(run);
              setRuns((current) => current.map((item) => item.id === run.id ? run : item));
            }),
            refreshSecurity(),
          ]).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))}
        />
      )}

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">{t("新的 Agent 身份", "New Agent identity")}</span>
                <h2>{form.scope === "group" ? t("创建群组 Agent", "Create group Agent") : t("创建个人 Agent", "Create personal Agent")}</h2>
                <p>{t("Agent 拥有独立运行线程；文件属于个人/群组下的对话或任务项目。", "Agents have independent runtime threads; files belong to conversation or task projects owned by a person or group.")}</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <div className="ownership-context">
              <span>{form.scope === "group" ? t("群组边界", "Group boundary") : t("个人边界", "Personal boundary")}</span>
              <div><strong>{form.scope === "group" ? groups.find((group) => group.id === form.groupId)?.name ?? t("未知群组", "Unknown group") : currentUser.displayName}</strong><small>{form.scope === "group" ? t("只有本群成员可以使用，不能跨群读取资源", "Only group members may use it; resources cannot be read across groups") : t("只有你可以使用，需要同意后才能读取我的知识库", "Only you may use it; reading your knowledge requires approval")}</small></div>
            </div>
            <label>
              {t("名称", "Name")}
              <input
                autoFocus
                placeholder={t("前端构建助手", "Frontend Builder")}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              {t("角色", "Role")}
              <input
                placeholder={t("产品经理、设计师、工程师…", "Product Manager, Designer, Engineer…")}
                value={form.role}
                onChange={(event) => setForm({ ...form, role: event.target.value })}
                required
                maxLength={120}
              />
            </label>
            <label>
              {t("简介", "Description")}
              <input
                placeholder={t("构建精致的 React 原型", "Builds polished React prototypes")}
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              {t("提示词", "Instructions")}
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                {t("取消", "Cancel")}
              </button>
              <button
                className="button button-primary"
                disabled={busy || form.scope === "group" && !form.groupId}
              >
                {busy ? <Spinner /> : t("创建 Agent", "Create Agent")}
              </button>
            </div>
          </form>
        </div>
      )}

      {showCreateResource && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreateResource(false)}>
          <form className="modal resource-modal" onSubmit={createResource} onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="eyebrow">{resourceForm.scope === "private" ? t("我的知识库", "My knowledge") : t("群组知识库", "Group knowledge")}</span>
                <h2>{t("新建资料", "New resource")}</h2>
                <p>{resourceForm.scope === "private" ? t("默认只有你本人可见，Agent 需要获得授权。", "Visible only to you by default; Agents require authorization.") : t("群成员可见，同群 Agent 可按策略读取。", "Visible to group members; same-group Agents may read it under policy.")}</p>
              </div>
              <button type="button" onClick={() => setShowCreateResource(false)}>×</button>
            </div>
            <label>{t("标题", "Title")}<input autoFocus value={resourceForm.title} onChange={(event) => setResourceForm({ ...resourceForm, title: event.target.value })} required maxLength={200} /></label>
            <label>{t("正文", "Content")}<textarea value={resourceForm.content} onChange={(event) => setResourceForm({ ...resourceForm, content: event.target.value })} required rows={12} maxLength={100_000} /></label>
            <div className="modal-footer"><button type="button" className="button button-ghost" onClick={() => setShowCreateResource(false)}>{t("取消", "Cancel")}</button><button className="button button-primary" disabled={busy || !resourceForm.title.trim() || !resourceForm.content.trim()}>{busy ? <Spinner /> : t("保存资料", "Save resource")}</button></div>
          </form>
        </div>
      )}

      {selectedResource && (
        <div className="modal-backdrop" onMouseDown={() => setSelectedResourceId(null)}>
          <section className="modal resource-detail-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><span className="eyebrow">{selectedResource.scope === "private" ? t("私人资料", "Private resource") : t("群组资料", "Group resource")}</span><h2>{selectedResource.title}</h2><p>{t("创建于", "Created")} {new Date(selectedResource.createdAt).toLocaleString()}</p></div>
              <button type="button" onClick={() => setSelectedResourceId(null)}>×</button>
            </div>
            <article className="resource-full-content">{selectedResource.content}</article>
            {selectedResource.scope === "private" && selectedResource.ownerUserId === currentUser.id && (
              <section className="grant-manager">
                <div><span className="eyebrow">{t("Agent 授权", "Agent authorization")}</span><h3>{t("按用途授权", "Purpose-bound access")}</h3><p>{t("个人 Agent 可读取；群组 Agent 在指定任务中只能密封处理，不能把原文披露给其他成员。", "Personal Agents may read; group Agents may only perform sealed processing in a specified task and cannot disclose source text to other members.")}</p></div>
                {personalGrantAgents.length > 0 ? (
                  <div className="grant-create-row"><select value={grantAgentId} onChange={(event) => setGrantAgentId(event.target.value)}>{personalGrantAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name} · {agent.role}</option>)}</select><button className="button button-primary" onClick={() => void grantSelectedResource()} disabled={busy || !grantAgentId}>{t("授权读取", "Grant read")}</button></div>
                ) : <p className="grant-empty">{t("先创建一个个人 Agent，才能授予读取权限。", "Create a personal Agent before granting read access.")}</p>}
                {taskGrantTargets.length > 0 ? (
                  <div className="grant-create-row"><select value={taskGrantTarget} onChange={(event) => setTaskGrantTarget(event.target.value)}>{taskGrantTargets.map(({ task, agent, value }) => <option value={value} key={value}>{task.title} → {agent.name}</option>)}</select><button className="button button-primary" onClick={() => void grantSelectedResourceForTask()} disabled={busy || !taskGrantTarget}>{t("授权任务内处理", "Grant task processing")}</button></div>
                ) : <p className="grant-empty">{t("创建一个包含群组 Agent 的进行中任务后，可授权其处理资料但不披露原文。", "Create an active task with a group Agent to authorize sealed processing without source disclosure.")}</p>}
                <div className="grant-list">
                  {selectedResourceGrants.map((grant) => {
                    const agent = agents.find((item) => item.id === grant.granteeAgentId);
                    const boundRun = grant.runId
                      ? runs.find((run) => run.id === grant.runId)
                      : null;
                    const runStillActive = grant.duration !== "run" ||
                      boundRun?.status === "queued" ||
                      boundRun?.status === "running";
                    const active = grant.revokedAt === null &&
                      (!grant.expiresAt || new Date(grant.expiresAt) > new Date()) &&
                      runStillActive;
                    return <article key={grant.id}><div><strong>{agent?.name ?? t("已删除的 Agent", "Deleted Agent")}</strong><small>{grant.action === "process" ? t("密封处理", "Sealed process") : t("读取原文", "Read source")} · {grant.duration === "persistent" ? t("持续授权", "Persistent") : grant.duration === "task" ? t("任务授权", "Task grant") : t("单次运行授权", "Run grant")} · {active ? t("生效中", "Active") : t("已失效", "Expired")}</small></div>{active && <button className="button button-danger" onClick={() => void revokeSelectedGrant(grant.id)} disabled={busy}>{t("撤销", "Revoke")}</button>}</article>;
                  })}
                  {selectedResourceGrants.length === 0 && <p className="grant-empty">{t("还没有授予任何 Agent。", "No Agent has been granted access yet.")}</p>}
                </div>
              </section>
            )}
            <section className="resource-access-history">
              <div><span className="eyebrow">{t("访问记录", "Access history")}</span><h3>{t("最近的权限决定", "Recent authorization decisions")}</h3></div>
              {selectedResourceDecisions.length > 0 ? (
                <div className="resource-decision-list">
                  {selectedResourceDecisions.map((decision) => (
                    <article key={decision.id}>
                      <span className={`activity-dot activity-${decision.decision}`} />
                      <div><strong>{decision.reasonCode}</strong><small>{decision.action} · {new Date(decision.occurredAt).toLocaleString()}</small></div>
                      <code>{decision.decision}</code>
                    </article>
                  ))}
                </div>
              ) : <p className="grant-empty">{t("还没有 Agent 请求过这份资料。", "No Agent has requested this resource yet.")}</p>}
            </section>
          </section>
        </div>
      )}

      {showCreateGroup && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreateGroup(false)}>
          <form className="modal compact-modal" onSubmit={createGroup} onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div><span className="eyebrow">{t("新的协作边界", "New collaboration boundary")}</span><h2>{t("创建群组", "Create group")}</h2><p>{t("创建者将成为群主。此群的成员、Agent 与资源彼此隔离于其他群。", "The creator becomes the owner. Members, Agents, and resources in this group are isolated from other groups.")}</p></div>
              <button type="button" onClick={() => setShowCreateGroup(false)}>×</button>
            </div>
            <label>{t("群组名称", "Group name")}<input autoFocus value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={t("例如：产品研发组", "e.g. Product Engineering")} required maxLength={120} /></label>
            <label>{t("说明", "Description")}<textarea value={groupDescription} onChange={(event) => setGroupDescription(event.target.value)} placeholder={t("这个群组负责什么？", "What is this group responsible for?")} rows={4} maxLength={500} /></label>
            <div className="modal-footer"><button type="button" className="button button-ghost" onClick={() => setShowCreateGroup(false)}>{t("取消", "Cancel")}</button><button className="button button-primary" disabled={busy || !groupName.trim()}>{busy ? <Spinner /> : t("创建群组", "Create group")}</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
