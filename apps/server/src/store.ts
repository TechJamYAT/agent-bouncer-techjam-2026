import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Agent,
  AgentRun,
  AccessRequest,
  AuthorizationDecision,
  CoordinationEvent,
  CoordinationSession,
  CoordinationStep,
  Database,
  Group,
  GroupMembership,
  Message,
  ProtectedResource,
  ResourceGrant,
  Session,
  User,
} from "./types.js";

type VersionThreeAgent = Agent & {
  workspacePath: string;
  codexThreadId: string | null;
};

type VersionThreeMessage = Omit<Message, "conversationId"> & {
  conversationId: string | null;
};

type VersionThreeRun = Omit<AgentRun, "conversationId" | "projectId">;

type VersionThreeCoordinationSession = Omit<
  CoordinationSession,
  "conversationId" | "projectId"
>;

interface VersionThreeDatabase {
  version: 3;
  users: User[];
  sessions: Session[];
  groups: Group[];
  memberships: GroupMembership[];
  agents: VersionThreeAgent[];
  messages: VersionThreeMessage[];
  runs: VersionThreeRun[];
  resources: ProtectedResource[];
  grants: ResourceGrant[];
  authorizationDecisions: AuthorizationDecision[];
  coordinationSessions: VersionThreeCoordinationSession[];
  coordinationSteps: CoordinationStep[];
  coordinationEvents: CoordinationEvent[];
}

interface LegacyDatabase {
  version: 1;
  agents: Array<Partial<VersionThreeAgent> & Pick<Agent, "id" | "name">>;
  messages: Array<Partial<VersionThreeMessage> & Pick<Message, "id" | "agentId" | "runId" | "role" | "content" | "createdAt">>;
  runs: Array<Partial<VersionThreeRun> & Pick<AgentRun, "id" | "agentId" | "status" | "prompt" | "createdAt">>;
}

interface VersionTwoDatabase extends Omit<VersionThreeDatabase, "version" | "coordinationSessions" | "coordinationSteps" | "coordinationEvents"> {
  version: 2;
}

interface VersionFourDatabase extends Omit<Database, "version" | "sharedFiles" | "artifactPublications" | "accessRequests" | "forwardIntentGrants"> {
  version: 4;
}

interface VersionFiveDatabase extends Omit<Database, "version" | "accessRequests" | "forwardIntentGrants"> {
  version: 5;
}

interface VersionSixDatabase extends Omit<Database, "version" | "forwardIntentGrants"> {
  version: 6;
}

const emptyDatabase = (): Database => ({
  version: 7,
  users: [],
  sessions: [],
  groups: [],
  memberships: [],
  agents: [],
  workspaces: [],
  projects: [],
  conversations: [],
  agentSessions: [],
  sharedFiles: [],
  artifactPublications: [],
  messages: [],
  directMessages: [],
  runs: [],
  resources: [],
  grants: [],
  forwardIntentGrants: [],
  accessRequests: [],
  authorizationDecisions: [],
  coordinationSessions: [],
  coordinationSteps: [],
  coordinationEvents: [],
});

function migrateLegacyDatabase(legacy: LegacyDatabase): VersionThreeDatabase {
  const migrated: VersionThreeDatabase = {
    version: 3,
    users: [],
    sessions: [],
    groups: [],
    memberships: [],
    agents: [],
    messages: [],
    runs: [],
    resources: [],
    grants: [],
    authorizationDecisions: [],
    coordinationSessions: [],
    coordinationSteps: [],
    coordinationEvents: [],
  };
  migrated.agents = legacy.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    role: typeof agent.role === "string" ? agent.role : "Coding Agent",
    description: typeof agent.description === "string" ? agent.description : "",
    instructions: typeof agent.instructions === "string" ? agent.instructions : "",
    color: typeof agent.color === "string" ? agent.color : "#6d5efc",
    scope: "personal",
    ownerUserId: null,
    groupId: null,
    createdByUserId: "",
    systemManaged: false,
    status: agent.status ?? "ready",
    workspacePath: agent.workspacePath ?? "",
    codexThreadId: agent.codexThreadId ?? null,
    lastError: agent.lastError ?? null,
    createdAt: agent.createdAt ?? new Date(0).toISOString(),
    updatedAt: agent.updatedAt ?? agent.createdAt ?? new Date(0).toISOString(),
  }));
  migrated.messages = legacy.messages.map((message) => ({
    id: message.id,
    agentId: message.agentId,
    runId: message.runId,
    humanId: message.humanId ?? null,
    conversationId: message.conversationId ?? null,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  }));
  migrated.runs = legacy.runs.map((run) => ({
    id: run.id,
    agentId: run.agentId,
    initiatingHumanId: run.initiatingHumanId ?? null,
    status: run.status,
    prompt: run.prompt,
    output: run.output ?? null,
    error: run.error ?? null,
    usage: run.usage ?? null,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    createdAt: run.createdAt,
  }));
  return migrated;
}

function migrateVersionTwoDatabase(previous: VersionTwoDatabase): VersionThreeDatabase {
  return {
    ...previous,
    version: 3,
    coordinationSessions: [],
    coordinationSteps: [],
    coordinationEvents: [],
  };
}

function migrateVersionThreeDatabase(previous: VersionThreeDatabase): Database {
  const migrated = emptyDatabase();
  migrated.users = previous.users;
  migrated.sessions = previous.sessions;
  migrated.groups = previous.groups;
  migrated.memberships = previous.memberships;
  migrated.agents = previous.agents.map(({ workspacePath: _workspace, codexThreadId: _thread, ...agent }) => agent);
  migrated.resources = previous.resources;
  migrated.grants = previous.grants;
  migrated.authorizationDecisions = previous.authorizationDecisions;
  migrated.coordinationSteps = previous.coordinationSteps;
  migrated.coordinationEvents = previous.coordinationEvents;

  const timestamp = new Date().toISOString();
  const workspaceByOwner = new Map<string, Database["workspaces"][number]>();
  const ensureWorkspace = (ownerType: "personal" | "group", ownerId: string) => {
    const key = `${ownerType}:${ownerId}`;
    const existing = workspaceByOwner.get(key);
    if (existing) return existing;
    const workspace: Database["workspaces"][number] = {
      id: randomUUID(),
      ownerType,
      ownerUserId: ownerType === "personal" ? ownerId : null,
      groupId: ownerType === "group" ? ownerId : null,
      relativePath: `${ownerType === "personal" ? "users" : "groups"}/${ownerId}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    migrated.workspaces.push(workspace);
    workspaceByOwner.set(key, workspace);
    return workspace;
  };
  for (const user of migrated.users) ensureWorkspace("personal", user.id);
  for (const group of migrated.groups) ensureWorkspace("group", group.id);

  const importedProjectByAgent = new Map<string, string>();
  for (const previousAgent of previous.agents) {
    if (!previousAgent.workspacePath) continue;
    const ownerType = previousAgent.scope === "personal" ? "personal" : "group";
    const ownerId = ownerType === "personal" ? previousAgent.ownerUserId : previousAgent.groupId;
    if (!ownerId) continue;
    const workspace = ensureWorkspace(ownerType, ownerId);
    const projectId = randomUUID();
    migrated.projects.push({
      id: projectId,
      workspaceId: workspace.id,
      sourceAgentId: previousAgent.id,
      name: `Imported ${previousAgent.name} project`,
      description: "Files preserved from the earlier Agent-owned workspace model.",
      relativePath: `projects/${projectId}`,
      createdByUserId: previousAgent.createdByUserId || ownerId,
      status: "active",
      createdAt: previousAgent.createdAt,
      updatedAt: previousAgent.updatedAt,
    });
    importedProjectByAgent.set(previousAgent.id, projectId);
  }

  const directConversationByKey = new Map<string, Database["conversations"][number]>();
  const ensureDirectConversation = (agentId: string, humanId: string | null) => {
    const key = `${agentId}:${humanId ?? "unknown"}`;
    const existing = directConversationByKey.get(key);
    if (existing) return existing;
    const agent = migrated.agents.find((item) => item.id === agentId);
    const conversation: Database["conversations"][number] = {
      id: randomUUID(),
      kind: "agent_dm",
      agentId,
      title: agent ? `Chat with ${agent.name}` : "Imported Agent chat",
      ownerUserId: humanId,
      groupId: agent?.scope === "group" || agent?.scope === "coordinator" ? agent.groupId : null,
      projectId:
        agent?.scope === "personal" ? importedProjectByAgent.get(agentId) ?? null : null,
      createdByUserId: humanId ?? "",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    migrated.conversations.push(conversation);
    directConversationByKey.set(key, conversation);
    return conversation;
  };

  migrated.messages = previous.messages.map((message) => {
    const conversation = ensureDirectConversation(message.agentId, message.humanId);
    return { ...message, conversationId: conversation.id };
  });
  migrated.runs = previous.runs.map((run) => {
    const conversation = ensureDirectConversation(run.agentId, run.initiatingHumanId);
    return {
      ...run,
      conversationId: conversation.id,
      projectId: conversation.projectId,
    };
  });

  for (const session of previous.coordinationSessions) {
    const workspace = ensureWorkspace("group", session.groupId);
    let projectId: string | null = null;
    if (session.kind === "task") {
      projectId = randomUUID();
      migrated.projects.push({
        id: projectId,
        workspaceId: workspace.id,
        sourceAgentId: null,
        name: session.title,
        description: session.objective ?? "",
        relativePath: `projects/${projectId}`,
        createdByUserId: session.createdByUserId,
        status: "active",
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    }
    const conversationId = randomUUID();
    migrated.conversations.push({
      id: conversationId,
      kind: session.kind,
      agentId: null,
      title: session.title,
      ownerUserId: null,
      groupId: session.groupId,
      projectId,
      createdByUserId: session.createdByUserId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
    migrated.coordinationSessions.push({ ...session, conversationId, projectId });
  }

  for (const previousAgent of previous.agents) {
    if (previousAgent.scope !== "personal" || !previousAgent.codexThreadId) continue;
    const conversation = ensureDirectConversation(previousAgent.id, previousAgent.ownerUserId);
    migrated.agentSessions.push({
      id: randomUUID(),
      agentId: previousAgent.id,
      conversationId: conversation.id,
      codexThreadId: previousAgent.codexThreadId,
      createdAt: previousAgent.createdAt,
      updatedAt: previousAgent.updatedAt,
    });
  }
  return migrated;
}

function migrateVersionFourDatabase(previous: VersionFourDatabase): VersionFiveDatabase {
  return {
    ...previous,
    version: 5,
    sharedFiles: [],
    artifactPublications: [],
  };
}

function migrateVersionFiveDatabase(previous: VersionFiveDatabase): VersionSixDatabase {
  return { ...previous, version: 6, accessRequests: [] };
}

function migrateVersionSixDatabase(previous: VersionSixDatabase): Database {
  return { ...previous, version: 7, forwardIntentGrants: [] };
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Database | LegacyDatabase | VersionTwoDatabase | VersionThreeDatabase | VersionFourDatabase | VersionFiveDatabase | VersionSixDatabase;
      if (parsed.version === 1 && Array.isArray(parsed.agents)) {
        this.data = migrateVersionThreeDatabase(migrateLegacyDatabase(parsed));
        await this.persist();
        return;
      }
      if (parsed.version === 2 && Array.isArray(parsed.users)) {
        this.data = migrateVersionThreeDatabase(migrateVersionTwoDatabase(parsed));
        await this.persist();
        return;
      }
      if (parsed.version === 3 && Array.isArray(parsed.users)) {
        this.data = migrateVersionThreeDatabase(parsed);
        await this.persist();
        return;
      }
      if (parsed.version === 4 && Array.isArray(parsed.users)) {
        this.data = migrateVersionSixDatabase(migrateVersionFiveDatabase(migrateVersionFourDatabase(parsed)));
        await this.persist();
        return;
      }
      if (parsed.version === 5 && Array.isArray(parsed.users)) {
        if (!Array.isArray(parsed.directMessages)) parsed.directMessages = [];
        this.data = migrateVersionSixDatabase(migrateVersionFiveDatabase(parsed));
        await this.persist();
        return;
      }
      if (parsed.version === 6 && Array.isArray(parsed.users)) {
        this.data = migrateVersionSixDatabase(parsed);
        await this.persist();
        return;
      }
      if (
        parsed.version !== 7 ||
        !Array.isArray(parsed.users) ||
        !Array.isArray(parsed.agents) ||
        !Array.isArray(parsed.workspaces) ||
        !Array.isArray(parsed.projects) ||
        !Array.isArray(parsed.conversations) ||
        !Array.isArray(parsed.agentSessions) ||
        !Array.isArray(parsed.directMessages) ||
        !Array.isArray(parsed.sharedFiles) ||
        !Array.isArray(parsed.artifactPublications) ||
        !Array.isArray(parsed.accessRequests) ||
        !Array.isArray(parsed.forwardIntentGrants) ||
        !Array.isArray(parsed.authorizationDecisions) ||
        !Array.isArray(parsed.coordinationSessions) ||
        !Array.isArray(parsed.coordinationSteps) ||
        !Array.isArray(parsed.coordinationEvents)
      ) {
        throw new Error("Unsupported database format");
      }
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
