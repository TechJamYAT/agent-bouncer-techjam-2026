export type AgentStatus = "ready" | "busy" | "stopped" | "error" | "deleted";
export type AgentScope = "personal" | "group" | "coordinator";
export type RunStatus = "queued" | "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled";
export type MiddlewareEvidenceAction =
  | "resource:list"
  | "resource:read"
  | "resource:process"
  | "resource:disclose"
  | "resource:forward";

export interface MiddlewareEvidenceRequirement {
  action: MiddlewareEvidenceAction;
  decision: "allow" | "deny";
  targetId?: string;
  reasonCode?: string;
}

export interface RuntimeToolEvent {
  tool: "vault";
  operation: "list" | "read" | "assess" | "disclose" | "resolve" | "forward" | "request-forward";
  status: "completed" | "failed";
  exitCode: number | null;
  occurredAt: string;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  createdByUserId: string;
  role: "owner" | "admin" | "member";
  memberCount: number;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMember {
  user: User;
  role: "owner" | "admin" | "member";
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  description: string;
  instructions: string;
  color: string;
  scope: AgentScope;
  ownerUserId: string | null;
  groupId: string | null;
  createdByUserId: string;
  systemManaged: boolean;
  status: AgentStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  humanId: string | null;
  conversationId: string | null;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface HumanDirectMessage {
  id: string;
  conversationId: string;
  senderUserId: string;
  content: string;
  createdAt: string;
}

export interface DirectConversationSummary {
  peerType: "human" | "agent";
  peerId: string;
  title: string;
  subtitle: string;
  color: string;
  preview: string;
  updatedAt: string | null;
}

export interface AgentRun {
  id: string;
  agentId: string;
  initiatingHumanId: string | null;
  conversationId: string;
  projectId: string | null;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  middlewareEvidenceRequirements?: MiddlewareEvidenceRequirement[];
  middlewareEvidenceStatus?: "not_required" | "pending" | "satisfied" | "missing";
  runtimeToolEvents?: RuntimeToolEvent[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ProtectedResource {
  id: string;
  kind: "document" | "message" | "task_artifact";
  title: string;
  content: string;
  scope: "private" | "group";
  ownerUserId: string | null;
  groupId: string | null;
  createdByType: "human" | "agent";
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceGrant {
  id: string;
  resourceId: string;
  granteeAgentId: string;
  grantedByUserId: string;
  action: "read" | "process" | "disclose";
  duration: "persistent" | "run" | "task";
  runId: string | null;
  taskId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ArtifactPublication {
  id: string;
  workspaceId: string;
  projectId: string;
  sourceRelativePath: string;
  destinationRelativePath: string;
  sourceSha256: string;
  sourceSize: number;
  proposedByAgentId: string;
  proposedByRunId: string;
  requestedForUserId: string;
  status: "pending" | "approving" | "approved" | "rejected";
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SharedFileRecord {
  id: string;
  workspaceId: string;
  relativePath: string;
  createdByUserId: string;
  sourcePublicationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFileInfo {
  relativePath: string;
  size: number;
  updatedAt: string;
}

export interface ProjectFilePreview extends ProjectFileInfo {
  kind: "text" | "binary";
  content: string | null;
  truncated: boolean;
}

export interface AuthorizationDecision {
  id: string;
  occurredAt: string;
  initiatingHumanId: string;
  executingAgentId: string | null;
  runId: string | null;
  taskId: string | null;
  conversationId: string | null;
  action: string;
  targetType: "agent" | "group" | "member" | "resource" | "grant" | "publication" | "shared_file" | "access_request";
  targetId: string;
  decision: "allow" | "deny";
  reasonCode: string;
  policyVersion: "bouncer-v1";
  detail: string;
  initiatingHumanName: string;
  executingAgentName: string | null;
  targetLabel: string;
  targetOwnerName: string | null;
  requestEvidence?: {
    source: "agent_runtime" | "control_plane";
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    command: string | null;
    body: Record<string, string> | null;
    responseStatus: number;
    redacted: true;
  };
}

export interface AccessRequest {
  id: string;
  requesterHumanId: string;
  ownerUserId: string;
  agentId: string;
  resourceId: string | null;
  action: "list" | "read" | "disclose" | "forward";
  recipientUserId: string;
  runId: string;
  conversationId: string;
  status: "pending" | "approved" | "rejected" | "expired";
  sourceDecisionId: string;
  requestedAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  resourceTitle: string;
  agentName: string;
  requesterName: string;
  ownerName: string;
  recipientName: string;
}

export type CoordinationMode = "manual" | "automatic";
export type ContextImportMode = "none" | "full" | "selected";

export interface ImportedContextMessage {
  sourceEventId: string;
  sourceSequence: number;
  actorType: "human" | "agent";
  actorId: string | null;
  content: string;
  createdAt: string;
}

export interface CoordinationContextImport {
  mode: ContextImportMode;
  sourceConversationId: string | null;
  sourceSessionId: string | null;
  sourceTitle: string | null;
  attachedByUserId: string;
  messages: ImportedContextMessage[];
  createdAt: string;
}
export type CoordinationStatus =
  | "active"
  | "running"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "stopped";

export interface CoordinationSession {
  id: string;
  groupId: string;
  conversationId: string;
  projectId: string | null;
  kind: "group_chat" | "task";
  mode: CoordinationMode;
  title: string;
  objective: string | null;
  middlewareEvidenceRequirements?: MiddlewareEvidenceRequirement[];
  createdByUserId: string;
  controllerUserId: string;
  participantAgentIds: string[];
  coordinatorEnabled: boolean;
  coordinatorAgentId: string | null;
  maxRounds: number;
  maxCallsPerRound: number;
  currentRound: number;
  callsInCurrentRound: number;
  roundExtensionRequest?: CoordinationRoundExtensionRequest | null;
  manualAdvanceRequest?: CoordinationManualAdvanceRequest | null;
  interruption?: CoordinationInterruption | null;
  status: CoordinationStatus;
  version: number;
  lastEventSequence: number;
  planVersion: number;
  needsReplan: boolean;
  activeStepId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  contextImport?: CoordinationContextImport | null;
}

export interface CoordinationInterruption {
  id: string;
  stepId: string;
  requestedByUserId: string;
  status: "cancelling" | "paused" | "continued" | "new_round";
  requestedAt: string;
  interruptedAt: string | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
}

export interface CoordinationManualAdvanceRequest {
  id: string;
  afterStepId: string;
  rationale: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
}

export interface CoordinationRoundExtensionRequest {
  id: string;
  requestedAdditionalRounds: number;
  rationale: string;
  contextThroughSequence: number;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  approvedAdditionalRounds: number | null;
}

export interface CoordinationStep {
  id: string;
  sessionId: string;
  planVersion: number;
  position: number;
  agentId: string;
  instruction: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  attempt: number;
  contextThroughSequence: number | null;
  runId: string | null;
  outputEventId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CoordinationEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: string;
  actorType: "human" | "agent" | "coordinator" | "system";
  actorId: string | null;
  stepId: string | null;
  content: string | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface CoordinationSnapshot {
  session: CoordinationSession;
  steps: CoordinationStep[];
  events: CoordinationEvent[];
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
