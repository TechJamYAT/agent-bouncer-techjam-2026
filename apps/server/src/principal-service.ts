import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { createOpaqueToken, hashToken, verifyPassword } from "./auth.js";
import { DEMO_USER_IDS } from "./demo-data.js";
import { HttpError } from "./errors.js";
import type { JsonStore } from "./store.js";
import type {
  Agent,
  AuthorizationDecision,
  CreateAgentInput,
  Group,
  GroupMembership,
  GroupRole,
  Session,
  UpdateAgentInput,
  User,
  Workspace,
} from "./types.js";
import type { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export type PublicUser = Omit<User, "passwordHash">;

export interface GroupSummary extends Group {
  role: GroupRole;
  memberCount: number;
  lastActivityAt: string | null;
}

type DecisionInput = Omit<AuthorizationDecision, "id" | "occurredAt" | "policyVersion">;

interface PrincipalServiceHooks {
  recordDecision(input: DecisionInput): Promise<AuthorizationDecision>;
  cancelExecution(agentId: string): Promise<void>;
  cancelWaitingApprovalRuns(agentId: string, humanId: string): Promise<void>;
}

function publicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

/**
 * Owns human sessions, group membership and Agent principal lifecycle.
 *
 * Run cancellation and audit persistence remain supplied by AgentService while
 * orchestration is being extracted incrementally. Keeping those dependencies
 * explicit prevents this service from reaching back into the facade.
 */
export class PrincipalService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly hooks: PrincipalServiceHooks,
  ) {}

  async login(username: string, password: string): Promise<{ token: string; user: PublicUser; expiresAt: string }> {
    const normalized = username.trim().toLowerCase();
    const user = this.store.snapshot().users.find((item) => item.username === normalized);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new HttpError(401, "Invalid username or password");
    }
    const token = createOpaqueToken();
    const createdAt = now();
    const expiresAt = new Date(
      Date.now() + this.config.sessionTtlHours * 60 * 60 * 1000,
    ).toISOString();
    const session: Session = {
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt,
    };
    await this.store.mutate((database) => {
      database.sessions = database.sessions.filter(
        (item) => new Date(item.expiresAt) > new Date(createdAt),
      );
      database.sessions.push(session);
    });
    return { token, user: publicUser(user), expiresAt };
  }

  currentUser(token: string): PublicUser | null {
    if (!token) return null;
    const database = this.store.snapshot();
    const tokenDigest = hashToken(token);
    const session = database.sessions.find(
      (item) => item.tokenHash === tokenDigest && new Date(item.expiresAt) > new Date(),
    );
    if (!session) return null;
    const user = database.users.find((item) => item.id === session.userId);
    return user ? publicUser(user) : null;
  }

  async logout(token: string): Promise<void> {
    if (!token) return;
    const tokenDigest = hashToken(token);
    await this.store.mutate((database) => {
      database.sessions = database.sessions.filter((item) => item.tokenHash !== tokenDigest);
    });
  }

  listUsers(): PublicUser[] {
    return this.store
      .snapshot()
      .users.map(publicUser)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  listGroups(humanId: string): GroupSummary[] {
    const database = this.store.snapshot();
    const groupIdByChatSessionId = new Map(
      database.coordinationSessions
        .filter((session) => session.kind === "group_chat")
        .map((session) => [session.id, session.groupId] as const),
    );
    const lastActivityByGroupId = new Map<string, string>();
    for (const event of database.coordinationEvents) {
      if (event.type !== "human.message" && event.type !== "agent.message") continue;
      const groupId = groupIdByChatSessionId.get(event.sessionId);
      if (!groupId) continue;
      const previous = lastActivityByGroupId.get(groupId);
      if (!previous || event.createdAt > previous) {
        lastActivityByGroupId.set(groupId, event.createdAt);
      }
    }
    return database.memberships
      .filter((membership) => membership.userId === humanId)
      .map((membership) => {
        const group = database.groups.find((item) => item.id === membership.groupId);
        if (!group) return null;
        return {
          ...group,
          role: membership.role,
          memberCount: database.memberships.filter((item) => item.groupId === group.id).length,
          lastActivityAt: lastActivityByGroupId.get(group.id) ?? null,
        };
      })
      .filter((group): group is GroupSummary => group !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async createGroup(humanId: string, name: string, description = ""): Promise<Group> {
    this.requireUser(humanId);
    const timestamp = now();
    const group: Group = {
      id: randomUUID(),
      name: name.trim(),
      description: description.trim(),
      createdByUserId: humanId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const workspace: Workspace = {
      id: randomUUID(),
      ownerType: "group",
      ownerUserId: null,
      groupId: group.id,
      relativePath: this.workspaces.groupRelativePath(group.id),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => {
      database.groups.push(group);
      database.workspaces.push(workspace);
      database.memberships.push({
        groupId: group.id,
        userId: humanId,
        role: "owner",
        createdAt: timestamp,
      });
    });
    await this.workspaces.ensureWorkspace(workspace);
    return group;
  }

  listMembers(humanId: string, groupId: string): Array<{ user: PublicUser; role: GroupRole }> {
    const database = this.store.snapshot();
    this.requireMembership(database.memberships, humanId, groupId);
    return database.memberships
      .filter((membership) => membership.groupId === groupId)
      .map((membership) => {
        const user = database.users.find((item) => item.id === membership.userId);
        if (!user) return null;
        return { user: publicUser(user), role: membership.role };
      })
      .filter((member): member is { user: PublicUser; role: GroupRole } => member !== null);
  }

  async addMember(
    humanId: string,
    groupId: string,
    userId: string,
    role: Exclude<GroupRole, "owner"> = "member",
  ): Promise<GroupMembership> {
    this.requireUser(userId);
    this.requireGroupManager(humanId, groupId);
    const membership: GroupMembership = { groupId, userId, role, createdAt: now() };
    await this.store.mutate((database) => {
      if (database.memberships.some((item) => item.groupId === groupId && item.userId === userId)) {
        throw new HttpError(409, "User is already a group member");
      }
      database.memberships.push(membership);
    });
    await this.hooks.recordDecision({
      initiatingHumanId: humanId,
      executingAgentId: null,
      runId: null,
      taskId: null,
      conversationId: null,
      action: "member:manage",
      targetType: "member",
      targetId: userId,
      decision: "allow",
      reasonCode: "GROUP_MEMBER_ADDED",
      detail: `Added user ${userId} to group ${groupId} as ${role}`,
    });
    return membership;
  }

  async removeMember(humanId: string, groupId: string, userId: string): Promise<void> {
    this.requireGroupManager(humanId, groupId);
    const target = this.getMembership(userId, groupId);
    if (target.role === "owner") {
      throw new HttpError(409, "Transfer group ownership before removing the owner");
    }
    await this.store.mutate((database) => {
      database.memberships = database.memberships.filter(
        (item) => item.groupId !== groupId || item.userId !== userId,
      );
      const groupAgentIds = new Set(
        database.agents.filter((agent) => agent.groupId === groupId).map((agent) => agent.id),
      );
      const timestamp = now();
      for (const grant of database.grants) {
        if (grant.grantedByUserId === userId && groupAgentIds.has(grant.granteeAgentId)) {
          grant.revokedAt = timestamp;
        }
      }
    });
    await this.hooks.recordDecision({
      initiatingHumanId: humanId,
      executingAgentId: null,
      runId: null,
      taskId: null,
      conversationId: null,
      action: "member:manage",
      targetType: "member",
      targetId: userId,
      decision: "allow",
      reasonCode: "GROUP_MEMBER_REMOVED",
      detail: `Removed user ${userId} from group ${groupId}`,
    });
  }

  listAgents(humanId: string = DEMO_USER_IDS.alice): Agent[] {
    const database = this.store.snapshot();
    const groupIds = new Set(
      database.memberships
        .filter((membership) => membership.userId === humanId)
        .map((membership) => membership.groupId),
    );
    return database.agents
      .filter(
        (agent) =>
          agent.status !== "deleted" &&
          ((agent.scope === "personal" && agent.ownerUserId === humanId) ||
            (agent.groupId !== null && groupIds.has(agent.groupId))),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) throw new HttpError(404, "Agent not found");
    return agent;
  }

  getAgentForUser(humanId: string, id: string): Agent {
    const agent = this.getAgent(id);
    this.assertCanUseAgent(humanId, agent);
    return agent;
  }

  async createAgent(
    input: CreateAgentInput,
    humanId: string = DEMO_USER_IDS.alice,
  ): Promise<Agent> {
    this.requireUser(humanId);
    const scope = input.scope ?? "personal";
    const groupId = scope === "group" ? input.groupId ?? null : null;
    if (scope === "group") {
      if (!groupId) throw new HttpError(400, "groupId is required for a group Agent");
      this.requireGroupManager(humanId, groupId);
    }
    const timestamp = now();
    const agent: Agent = {
      id: randomUUID(),
      name: input.name.trim(),
      role: input.role?.trim() || "General Assistant",
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      color: input.color?.trim() || "#6d5efc",
      scope,
      ownerUserId: scope === "personal" ? humanId : null,
      groupId,
      createdByUserId: humanId,
      systemManaged: false,
      status: "ready",
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(
    id: string,
    input: UpdateAgentInput,
    humanId: string = DEMO_USER_IDS.alice,
  ): Promise<Agent> {
    const current = this.getAgent(id);
    this.assertCanManageAgent(humanId, current);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.role !== undefined) agent.role = input.role.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      if (input.color !== undefined) agent.color = input.color.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  async deleteAgent(id: string, humanId: string = DEMO_USER_IDS.alice): Promise<{ deletedAgentId: string }> {
    const agent = this.getAgent(id);
    this.assertCanManageAgent(humanId, agent);
    if (agent.systemManaged) throw new HttpError(409, "System-managed Agents cannot be deleted");
    const activeSession = this.store.snapshot().coordinationSessions.find(
      (session) =>
        session.participantAgentIds.includes(id) &&
        session.status !== "completed" &&
        session.status !== "stopped",
    );
    if (activeSession) {
      throw new HttpError(409, "Remove or stop the Agent's active coordination session first");
    }
    await this.hooks.cancelExecution(id);
    await this.hooks.cancelWaitingApprovalRuns(id, humanId);
    await this.store.mutate((database) => {
      const stored = database.agents.find((item) => item.id === id);
      if (!stored) throw new HttpError(404, "Agent not found");
      stored.status = "deleted";
      stored.updatedAt = now();
      for (const grant of database.grants) {
        if (grant.granteeAgentId === id && grant.revokedAt === null) grant.revokedAt = now();
      }
      for (const session of database.agentSessions) {
        if (session.agentId === id) {
          session.codexThreadId = null;
          session.updatedAt = now();
        }
      }
    });
    return { deletedAgentId: id };
  }

  async startAgent(id: string, humanId: string = DEMO_USER_IDS.alice): Promise<Agent> {
    const agent = this.getAgent(id);
    this.assertCanManageAgent(humanId, agent);
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string, humanId: string = DEMO_USER_IDS.alice): Promise<Agent> {
    const agent = this.getAgent(id);
    this.assertCanManageAgent(humanId, agent);
    await this.hooks.cancelExecution(id);
    await this.hooks.cancelWaitingApprovalRuns(id, humanId);
    const stopped = await this.setStatus(id, "stopped");
    await this.store.mutate((database) => {
      const timestamp = now();
      for (const grant of database.grants) {
        if (grant.granteeAgentId === id && grant.duration !== "persistent") {
          grant.revokedAt = timestamp;
        }
      }
    });
    return stopped;
  }

  requireUser(userId: string): User {
    const user = this.store.snapshot().users.find((item) => item.id === userId);
    if (!user) throw new HttpError(404, "User not found");
    return user;
  }

  requireDirectHumanPeer(humanId: string, peerUserId: string): void {
    this.requireUser(humanId);
    this.requireUser(peerUserId);
    if (humanId === peerUserId) {
      throw new HttpError(400, "A direct conversation requires another user");
    }
  }

  getMembership(userId: string, groupId: string): GroupMembership {
    const membership = this.store
      .snapshot()
      .memberships.find((item) => item.groupId === groupId && item.userId === userId);
    if (!membership) throw new HttpError(403, "Group membership required");
    return membership;
  }

  requireMembership(
    memberships: GroupMembership[],
    userId: string,
    groupId: string,
  ): GroupMembership {
    const membership = memberships.find(
      (item) => item.groupId === groupId && item.userId === userId,
    );
    if (!membership) throw new HttpError(403, "Group membership required");
    return membership;
  }

  requireGroupManager(userId: string, groupId: string): GroupMembership {
    const membership = this.getMembership(userId, groupId);
    if (membership.role !== "owner" && membership.role !== "admin") {
      throw new HttpError(403, "Group owner or admin permission required");
    }
    return membership;
  }

  assertCanUseAgent(humanId: string, agent: Agent): void {
    if (agent.status === "deleted") {
      throw new HttpError(410, "Access Denied: AGENT_DELETED");
    }
    if (agent.scope === "personal") {
      if (agent.ownerUserId !== humanId) {
        throw new HttpError(403, "Access Denied: PERSONAL_AGENT_OWNER_MISMATCH");
      }
      return;
    }
    if (agent.scope === "coordinator") {
      throw new HttpError(403, "System coordinators can only be invoked by the coordination scheduler");
    }
    if (!agent.groupId) throw new HttpError(403, "Access Denied: AGENT_GROUP_MISMATCH");
    this.getMembership(humanId, agent.groupId);
  }

  assertCanManageAgent(humanId: string, agent: Agent): void {
    if (agent.status === "deleted") throw new HttpError(410, "Agent has been deleted");
    if (agent.scope === "personal") {
      if (agent.ownerUserId !== humanId) {
        throw new HttpError(403, "Only the owner may manage this personal Agent");
      }
      return;
    }
    if (!agent.groupId) throw new HttpError(403, "The Agent has no group owner");
    const membership = this.getMembership(humanId, agent.groupId);
    if (
      membership.role !== "owner" &&
      membership.role !== "admin" &&
      agent.createdByUserId !== humanId
    ) {
      throw new HttpError(403, "Only the Agent creator or a group manager may manage it");
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "deleted") throw new HttpError(410, "Agent has been deleted");
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }
}
