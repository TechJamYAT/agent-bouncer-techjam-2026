import type {
  Agent,
  AgentRun,
  ArtifactPublication,
  AuthorizationDecision,
  CoordinationMode,
  CoordinationSession,
  CoordinationSnapshot,
  Group,
  GroupMember,
  HumanDirectMessage,
  DirectConversationSummary,
  Message,
  ProtectedResource,
  ProjectFileInfo,
  ProjectFilePreview,
  ResourceGrant,
  SharedFileRecord,
  SystemInfo,
  User,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reasonCode: string | null = null,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "include",
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    reasonCode?: string;
  };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status, data.reasonCode ?? null);
  }
  return data;
}

async function requestBlob(url: string): Promise<Blob> {
  const response = await fetch(url, {
    headers: authToken ? { Authorization: "Bearer " + authToken } : {},
    credentials: "include",
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string; reasonCode?: string };
    throw new ApiError(data.error ?? "Download failed", response.status, data.reasonCode ?? null);
  }
  return response.blob();
}

export const api = {
  auth: () => request<{ required: boolean; userSessionRequired: boolean }>("/api/auth"),
  session: () => request<{ user: User | null }>("/api/session"),
  login: (username: string, password: string) =>
    request<{ user: User; expiresAt: string }>("/api/session", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean }>("/api/session", { method: "DELETE" }),
  system: () => request<SystemInfo>("/api/system"),
  users: () => request<{ users: User[] }>("/api/users"),
  directConversations: () =>
    request<{ conversations: DirectConversationSummary[] }>("/api/direct-conversations"),
  humanDirectMessages: (userId: string) =>
    request<{ messages: HumanDirectMessage[] }>(`/api/users/${userId}/direct-messages`),
  sendHumanDirectMessage: (userId: string, content: string) =>
    request<{ message: HumanDirectMessage }>(`/api/users/${userId}/direct-messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  groups: () => request<{ groups: Group[] }>("/api/groups"),
  createGroup: (body: { name: string; description: string }) =>
    request<{ group: Omit<Group, "role" | "memberCount" | "lastActivityAt"> }>("/api/groups", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  groupMembers: (groupId: string) =>
    request<{ members: GroupMember[] }>(`/api/groups/${groupId}/members`),
  addGroupMember: (groupId: string, userId: string, role: "admin" | "member") =>
    request<{ membership: { groupId: string; userId: string; role: "admin" | "member" } }>(
      `/api/groups/${groupId}/members`,
      { method: "POST", body: JSON.stringify({ userId, role }) },
    ),
  removeGroupMember: (groupId: string, userId: string) =>
    request<{ ok: true }>(`/api/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
  coordinationSessions: (groupId: string) =>
    request<{ sessions: CoordinationSession[] }>(
      `/api/groups/${groupId}/coordination-sessions`,
    ),
  createCoordinationTask: (groupId: string, body: {
    title: string;
    objective: string;
    mode: CoordinationMode;
    participantAgentIds: string[];
    coordinatorEnabled: boolean;
    maxRounds?: number;
    maxCallsPerRound: number;
    contextImport?:
      | { mode: "none" }
      | { mode: "full"; sourceConversationId: string }
      | { mode: "selected"; sourceConversationId: string; eventIds: string[] };
  }) =>
    request<CoordinationSnapshot>(`/api/groups/${groupId}/coordination-sessions`, {
      method: "POST",
      body: JSON.stringify({ ...body, kind: "task" }),
    }),
  createGroupChat: (groupId: string, body: {
    title: string;
    mode: CoordinationMode;
    participantAgentIds: string[];
    coordinatorEnabled: boolean;
    maxCallsPerRound?: number;
  }) =>
    request<CoordinationSnapshot>(`/api/groups/${groupId}/coordination-sessions`, {
      method: "POST",
      body: JSON.stringify({ ...body, kind: "group_chat" }),
    }),
  coordinationSession: (id: string) =>
    request<CoordinationSnapshot>(`/api/coordination-sessions/${id}`),
  coordinationProjectFiles: (id: string) =>
    request<{ files: ProjectFileInfo[] }>(`/api/coordination-sessions/${id}/project/files`),
  coordinationProjectFile: (id: string, path: string) =>
    request<{ file: ProjectFilePreview }>(
      `/api/coordination-sessions/${id}/project/file?path=${encodeURIComponent(path)}`,
    ),
  downloadCoordinationProject: (id: string) =>
    requestBlob(`/api/coordination-sessions/${id}/project/archive`),
  sendCoordinationMessage: (id: string, content: string) =>
    request<CoordinationSnapshot>(`/api/coordination-sessions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  setCoordinationMode: (id: string, mode: CoordinationMode, expectedVersion: number) =>
    request<CoordinationSnapshot>(`/api/coordination-sessions/${id}/mode`, {
      method: "PATCH",
      body: JSON.stringify({ mode, expectedVersion }),
    }),
  setCoordinationCallAllowance: (id: string, maxCallsPerRound: number, expectedVersion: number) =>
    request<CoordinationSnapshot>(`/api/coordination-sessions/${id}/call-allowance`, {
      method: "PATCH",
      body: JSON.stringify({ maxCallsPerRound, expectedVersion }),
    }),
  setCoordinationCoordinator: (id: string, enabled: boolean, expectedVersion: number) =>
    request<CoordinationSnapshot>(`/api/coordination-sessions/${id}/coordinator`, {
      method: "PATCH",
      body: JSON.stringify({ enabled, expectedVersion }),
    }),
  advanceCoordination: (id: string, expectedVersion: number) =>
    request<{ snapshot: CoordinationSnapshot; run: AgentRun | null }>(
      `/api/coordination-sessions/${id}/advance`,
      { method: "POST", body: JSON.stringify({ expectedVersion }) },
    ),
  resolveCoordinationManualAdvance: (
    id: string,
    decision: "approve" | "reject",
    expectedVersion: number,
  ) => request<{ snapshot: CoordinationSnapshot; run: AgentRun | null }>(
    `/api/coordination-sessions/${id}/manual-advance`,
    { method: "POST", body: JSON.stringify({ decision, expectedVersion }) },
  ),
  retryCoordination: (id: string, stepId: string, expectedVersion: number) =>
    request<CoordinationSnapshot>(`/api/coordination-sessions/${id}/retry`, {
      method: "POST",
      body: JSON.stringify({ stepId, expectedVersion }),
    }),
  interruptCoordination: (id: string, expectedVersion: number) =>
    request<CoordinationSnapshot>(`/api/coordination-sessions/${id}/interrupt`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion }),
    }),
  resolveCoordinationInterruption: (
    id: string,
    action: "continue" | "new_round",
    expectedVersion: number,
  ) => request<{ snapshot: CoordinationSnapshot; run: AgentRun | null }>(
    `/api/coordination-sessions/${id}/interruption`,
    { method: "POST", body: JSON.stringify({ action, expectedVersion }) },
  ),
  stopCoordination: (id: string) =>
    request<CoordinationSnapshot>(`/api/coordination-sessions/${id}/stop`, {
      method: "POST",
    }),
  resolveCoordinationRoundExtension: (
    id: string,
    decision: "approve" | "reject",
    additionalRounds: number | undefined,
    expectedVersion: number,
  ) => request<CoordinationSnapshot>(`/api/coordination-sessions/${id}/round-extension`, {
    method: "POST",
    body: JSON.stringify({ decision, additionalRounds, expectedVersion }),
  }),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    role?: string;
    description: string;
    instructions: string;
    scope?: "personal" | "group";
    groupId?: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; role?: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ deletedAgentId: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (
    id: string,
    content: string,
    resourceReferences: Array<{ ownerUsername: string; title: string }> = [],
  ) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content, resourceReferences }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  resources: () => request<{ resources: ProtectedResource[] }>("/api/resources"),
  createResource: (body: {
    title: string;
    content: string;
    scope: "private" | "group";
    groupId?: string;
  }) => request<{ resource: ProtectedResource }>("/api/resources", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  grants: () => request<{ grants: ResourceGrant[] }>("/api/grants"),
  grantResource: (
    resourceId: string,
    agentId: string,
    options: { duration?: "persistent" | "run" | "task"; taskId?: string; action?: "read" | "process" } = {},
  ) =>
    request<{ grant: ResourceGrant }>(`/api/resources/${resourceId}/grants`, {
      method: "POST",
      body: JSON.stringify({ agentId, duration: "persistent", ...options }),
    }),
  revokeGrant: (grantId: string) =>
    request<{ grant: ResourceGrant }>(`/api/grants/${grantId}`, { method: "DELETE" }),
  decisions: () =>
    request<{ decisions: AuthorizationDecision[] }>("/api/authorization-decisions"),
  artifactPublications: () =>
    request<{ publications: ArtifactPublication[] }>("/api/artifact-publications"),
  approveArtifactPublication: (id: string) =>
    request<{ publication: ArtifactPublication; sharedFile: SharedFileRecord }>(
      `/api/artifact-publications/${id}/approve`,
      { method: "POST" },
    ),
  rejectArtifactPublication: (id: string) =>
    request<{ publication: ArtifactPublication; sharedFile: null }>(
      `/api/artifact-publications/${id}/reject`,
      { method: "POST" },
    ),
};
