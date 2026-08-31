export type AgentStatus = "ready" | "busy" | "stopped" | "error" | "deleted";
export type AgentScope = "personal" | "group" | "coordinator";
export type WorkspaceOwnerType = "personal" | "group";
export type ProjectStatus = "active" | "archived";
export type ConversationKind = "agent_dm" | "human_dm" | "group_chat" | "task";
export type ArtifactPublicationStatus = "pending" | "approving" | "approved" | "rejected";
export type RunStatus = "queued" | "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type GroupRole = "owner" | "admin" | "member";
export type ResourceScope = "private" | "group";
export type ResourceKind = "document" | "message" | "task_artifact";
export type GrantDuration = "persistent" | "run" | "task";
export type ResourceGrantAction = "read" | "process" | "disclose";
export type IntentGrantStatus = "active" | "consumed" | "revoked";
export type AccessRequestStatus = "pending" | "approved" | "rejected" | "expired";
export type AuthorizationAction =
  | "agent:create"
  | "agent:use"
  | "group:manage"
  | "member:manage"
  | "resource:create"
  | "resource:read"
  | "resource:process"
  | "resource:disclose"
  | "resource:forward"
  | "resource:publish"
  | "artifact:propose"
  | "artifact:approve"
  | "artifact:reject"
  | "shared_file:read"
  | "grant:create"
  | "grant:revoke"
  | "approval:request"
  | "approval:approve"
  | "approval:reject"
  | "approval:expire";
export type AuthorizationDecisionValue = "allow" | "deny";
export type MiddlewareEvidenceAction =
  | "resource:read"
  | "resource:process"
  | "resource:disclose"
  | "resource:forward";
export type MiddlewareEvidenceStatus =
  | "not_required"
  | "pending"
  | "satisfied"
  | "missing";

export interface MiddlewareEvidenceRequirement {
  action: MiddlewareEvidenceAction;
  decision: AuthorizationDecisionValue;
  /** Optional server-derived binding used for Run-local evidence contracts. */
  targetId?: string | undefined;
  /** Optional server-derived reason binding; clients cannot set this through task APIs. */
  reasonCode?: string | undefined;
}

export interface RuntimeToolEvent {
  tool: "vault";
  operation: "list" | "read" | "assess" | "disclose" | "resolve" | "forward" | "request-forward";
  status: "completed" | "failed";
  exitCode: number | null;
  occurredAt: string;
}

export interface AuthorizationRequestEvidence {
  source: "agent_runtime" | "control_plane";
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  command: string | null;
  body: Record<string, string> | null;
  responseStatus: number;
  redacted: true;
}
export type CoordinationKind = "group_chat" | "task";
export type CoordinationMode = "manual" | "automatic";
export type ContextImportMode = "none" | "full" | "selected";
export type CoordinationSessionStatus =
  | "active"
  | "running"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "stopped";
export type CoordinationStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type CoordinationEventType =
  | "session.created"
  | "mode.changed"
  | "allowance.changed"
  | "human.message"
  | "coordinator.enabled"
  | "coordinator.disabled"
  | "coordinator.decision"
  | "round_extension.requested"
  | "round_extension.resolved"
  | "round.completed"
  | "manual_advance.requested"
  | "manual_advance.resolved"
  | "round.interrupt_requested"
  | "round.interrupted"
  | "round.resumed"
  | "round.restarted"
  | "plan.replaced"
  | "step.queued"
  | "step.started"
  | "agent.message"
  | "step.completed"
  | "step.failed"
  | "step.retry_scheduled"
  | "session.completed"
  | "session.stopped";
export type CoordinationActorType = "human" | "agent" | "coordinator" | "system";

export interface User {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMembership {
  groupId: string;
  userId: string;
  role: GroupRole;
  createdAt: string;
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

export interface Workspace {
  id: string;
  ownerType: WorkspaceOwnerType;
  ownerUserId: string | null;
  groupId: string | null;
  relativePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  sourceAgentId: string | null;
  name: string;
  description: string;
  relativePath: string;
  createdByUserId: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  kind: ConversationKind;
  agentId: string | null;
  title: string;
  ownerUserId: string | null;
  groupId: string | null;
  projectId: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  participantUserIds?: string[] | undefined;
}

export interface HumanDirectMessage {
  id: string;
  conversationId: string;
  senderUserId: string;
  content: string;
  createdAt: string;
}

export interface AgentSession {
  id: string;
  agentId: string;
  conversationId: string;
  codexThreadId: string | null;
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
  status: ArtifactPublicationStatus;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  humanId: string | null;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
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
  usage: RunUsage | null;
  middlewareEvidenceRequirements?: MiddlewareEvidenceRequirement[] | undefined;
  middlewareEvidenceStatus?: MiddlewareEvidenceStatus | undefined;
  runtimeToolEvents?: RuntimeToolEvent[] | undefined;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ProtectedResource {
  id: string;
  kind: ResourceKind;
  title: string;
  content: string;
  scope: ResourceScope;
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
  action: ResourceGrantAction;
  duration: GrantDuration;
  runId: string | null;
  taskId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * A capability derived only from a human-authored message at the trusted
 * control-plane boundary. Agent output and protected resource contents cannot
 * create one of these grants.
 */
export interface ForwardIntentGrant {
  id: string;
  initiatingHumanId: string;
  agentId: string;
  runId: string;
  conversationId: string;
  sourceMessageId: string;
  resourceId: string;
  recipientUserId: string;
  status: IntentGrantStatus;
  expiresAt: string;
  deliveredMessageId: string | null;
  createdAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
}

export interface AccessRequest {
  id: string;
  requesterHumanId: string;
  ownerUserId: string;
  agentId: string;
  resourceId: string;
  action: "disclose" | "forward";
  recipientUserId: string;
  runId: string;
  conversationId: string;
  status: AccessRequestStatus;
  sourceDecisionId: string;
  requestedAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
}

export interface AuthorizationDecision {
  id: string;
  occurredAt: string;
  initiatingHumanId: string;
  executingAgentId: string | null;
  runId: string | null;
  taskId: string | null;
  conversationId: string | null;
  action: AuthorizationAction;
  targetType: "agent" | "group" | "member" | "resource" | "grant" | "publication" | "shared_file" | "access_request";
  targetId: string;
  decision: AuthorizationDecisionValue;
  reasonCode: string;
  policyVersion: "bouncer-v1";
  detail: string;
  requestEvidence?: AuthorizationRequestEvidence | undefined;
}

export interface CoordinationSession {
  id: string;
  groupId: string;
  conversationId: string;
  projectId: string | null;
  kind: CoordinationKind;
  mode: CoordinationMode;
  title: string;
  objective: string | null;
  middlewareEvidenceRequirements?: MiddlewareEvidenceRequirement[] | undefined;
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
  status: CoordinationSessionStatus;
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

export interface CoordinationStep {
  id: string;
  sessionId: string;
  planVersion: number;
  position: number;
  agentId: string;
  instruction: string;
  status: CoordinationStepStatus;
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
  type: CoordinationEventType;
  actorType: CoordinationActorType;
  actorId: string | null;
  stepId: string | null;
  content: string | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface Database {
  version: 7;
  users: User[];
  sessions: Session[];
  groups: Group[];
  memberships: GroupMembership[];
  agents: Agent[];
  workspaces: Workspace[];
  projects: Project[];
  conversations: Conversation[];
  agentSessions: AgentSession[];
  sharedFiles: SharedFileRecord[];
  artifactPublications: ArtifactPublication[];
  messages: Message[];
  directMessages: HumanDirectMessage[];
  runs: AgentRun[];
  resources: ProtectedResource[];
  grants: ResourceGrant[];
  forwardIntentGrants: ForwardIntentGrant[];
  accessRequests: AccessRequest[];
  authorizationDecisions: AuthorizationDecision[];
  coordinationSessions: CoordinationSession[];
  coordinationSteps: CoordinationStep[];
  coordinationEvents: CoordinationEvent[];
}

export interface CreateAgentInput {
  name: string;
  role?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  color?: string | undefined;
  scope?: Exclude<AgentScope, "coordinator"> | undefined;
  groupId?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  role?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  color?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
  toolEvents?: RuntimeToolEvent[] | undefined;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  runtimeEnvironment?: Record<string, string> | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
