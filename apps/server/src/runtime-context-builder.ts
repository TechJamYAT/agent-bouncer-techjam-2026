import type { AgentPromptBuilder } from "./agent-prompt-builder.js";
import type { CoordinationEngine, CoordinationSnapshot } from "./coordination.js";
import type { JsonStore } from "./store.js";
import type { Agent, AgentRun, Conversation, Database, Workspace } from "./types.js";
import type { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

/** Builds the bounded data snapshot written into each Runtime workspace. */
export class RuntimeContextBuilder {
  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly coordination: CoordinationEngine,
    private readonly prompts: AgentPromptBuilder,
    private readonly workspaceForConversation: (
      database: Database,
      conversation: Conversation,
    ) => Workspace,
  ) {}

  async build(
    agent: Agent,
    run: AgentRun,
    coordination?: { snapshot: CoordinationSnapshot; stepId: string | null } | undefined,
  ): Promise<Record<string, unknown>> {
    const database = this.store.snapshot();
    const conversation = database.conversations.find((item) => item.id === run.conversationId);
    if (!conversation) throw new Error("The Runtime conversation no longer exists");
    if (conversation.agentId && conversation.agentId !== agent.id) {
      throw new Error("The Runtime Agent does not match the conversation boundary");
    }
    if (conversation.projectId !== run.projectId) {
      throw new Error("The Runtime project does not match the conversation boundary");
    }
    const human = run.initiatingHumanId
      ? database.users.find((item) => item.id === run.initiatingHumanId) ?? null
      : null;
    const membership = conversation.groupId && human
      ? database.memberships.find(
          (item) => item.groupId === conversation.groupId && item.userId === human.id,
        ) ?? null
      : null;
    const workspace = this.workspaceForConversation(database, conversation);
    const project = run.projectId
      ? database.projects.find(
          (item) => item.id === run.projectId && item.workspaceId === workspace.id,
        ) ?? null
      : null;
    if (run.projectId && !project) {
      throw new Error("The Runtime project is outside its owner workspace");
    }
    const sharedFiles = await this.workspaces.listSharedFiles(workspace);
    const coordinationMessages = coordination
      ? coordination.stepId
        ? this.coordination.contextForStep(
            coordination.snapshot.session.id,
            coordination.stepId,
          )
        : coordination.snapshot.events
            .filter(
              (event) =>
                (event.type === "human.message" || event.type === "agent.message") &&
                event.content !== null,
            )
            .map((event) => ({
              sequence: event.sequence,
              actorType: event.actorType as "human" | "agent",
              actorId: event.actorId,
              content: event.content!,
            }))
      : null;
    const currentConversationHistory = coordinationMessages
      ? coordinationMessages.map((message) => {
          const actor = message.actorType === "human"
            ? database.users.find((item) => item.id === message.actorId)
            : database.agents.find((item) => item.id === message.actorId);
          return {
            sequence: message.sequence,
            actorType: message.actorType,
            actorId: message.actorId,
            actorName: actor
              ? "displayName" in actor ? actor.displayName : actor.name
              : null,
            content: message.content,
          };
        })
      : database.messages
          .filter((message) => message.conversationId === conversation.id)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .map((message, index) => ({
            sequence: index + 1,
            actorType: message.role === "user" ? "human" : "agent",
            actorId: message.role === "user" ? message.humanId : message.agentId,
            actorName: message.role === "user" ? human?.displayName ?? null : agent.name,
            content: message.content,
            createdAt: message.createdAt,
          }));

    let groupVisibleHistory: Array<Record<string, unknown>> = [];
    let groupVisibleHistorySource: Record<string, unknown> | null = null;
    if (conversation.kind === "agent_dm" && conversation.groupId) {
      const groupChat = database.coordinationSessions
        .filter(
          (session) =>
            session.kind === "group_chat" && session.groupId === conversation.groupId,
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (groupChat) {
        groupVisibleHistorySource = {
          conversationId: groupChat.conversationId,
          sessionId: groupChat.id,
          title: groupChat.title,
        };
        groupVisibleHistory = database.coordinationEvents
          .filter(
            (event) =>
              event.sessionId === groupChat.id &&
              (event.type === "human.message" || event.type === "agent.message") &&
              event.content !== null,
          )
          .sort((left, right) => left.sequence - right.sequence)
          .slice(-100)
          .map((event) => {
            const actor = event.actorType === "human"
              ? database.users.find((item) => item.id === event.actorId)
              : database.agents.find((item) => item.id === event.actorId);
            return {
              sequence: event.sequence,
              actorType: event.actorType,
              actorId: event.actorId,
              actorName: actor
                ? "displayName" in actor ? actor.displayName : actor.name
                : null,
              content: event.content,
              createdAt: event.createdAt,
            };
          });
      }
    }
    const importedHistory = coordination?.snapshot.session.contextImport?.messages.map(
      (message) => {
        const actor = message.actorType === "human"
          ? database.users.find((item) => item.id === message.actorId)
          : database.agents.find((item) => item.id === message.actorId);
        return {
          sourceEventId: message.sourceEventId,
          sourceSequence: message.sourceSequence,
          actorType: message.actorType,
          actorId: message.actorId,
          actorName: actor
            ? "displayName" in actor ? actor.displayName : actor.name
            : null,
          content: message.content,
          createdAt: message.createdAt,
        };
      },
    ) ?? [];

    return {
      schemaVersion: 1,
      generatedAt: now(),
      authority: "informational_snapshot_only",
      policyAuthority: "server_control_plane",
      run: {
        id: run.id,
        statusAtSnapshot: "running",
        initiatingHumanId: run.initiatingHumanId,
      },
      agent: {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        description: agent.description,
        scope: agent.scope,
        ownerUserId: agent.ownerUserId,
        groupId: agent.groupId,
      },
      currentHuman: human
        ? {
            id: human.id,
            username: human.username,
            displayName: human.displayName,
            groupRole: membership?.role ?? null,
          }
        : null,
      conversation: {
        id: conversation.id,
        kind: conversation.kind,
        title: conversation.title,
        ownerUserId: conversation.ownerUserId,
        groupId: conversation.groupId,
        projectId: conversation.projectId,
        audience: conversation.kind === "agent_dm"
          ? conversation.groupId ? "current_human_and_group_agent" : "current_human_and_personal_agent"
          : "current_group_members_and_participant_agents",
      },
      group: this.prompts.groupContextData(agent),
      histories: {
        imported: importedHistory,
        importSource: coordination?.snapshot.session.contextImport
          ? {
              mode: coordination.snapshot.session.contextImport.mode,
              conversationId:
                coordination.snapshot.session.contextImport.sourceConversationId,
              title: coordination.snapshot.session.contextImport.sourceTitle,
            }
          : null,
        currentConversation: currentConversationHistory,
        groupVisible: groupVisibleHistory,
        groupVisibleSource: groupVisibleHistorySource,
        policy: {
          currentConversationOnly: true,
          otherPrivateConversations: "denied",
          otherGroups: "denied",
          taskImports: "not_attached_unless_platform_authorizes_selection",
        },
      },
      workspace: {
        id: workspace.id,
        ownerType: workspace.ownerType,
        ownerUserId: workspace.ownerUserId,
        groupId: workspace.groupId,
        project: project
          ? {
              id: project.id,
              name: project.name,
              description: project.description,
              status: project.status,
            }
          : null,
        sharedFileIndex: sharedFiles,
        permissions: {
          currentRuntime: "read_write",
          ownerSharedFiles: "read_only_via_control_plane_tool",
          publishToOwnerShared: project ? "human_approval_required" : "not_available",
          otherWorkspaces: "denied",
        },
      },
      coordination: coordination
        ? {
            sessionId: coordination.snapshot.session.id,
            stepId: coordination.stepId,
            kind: coordination.snapshot.session.kind,
            mode: coordination.snapshot.session.mode,
            controllerUserId: coordination.snapshot.session.controllerUserId,
            participantAgentIds: coordination.snapshot.session.participantAgentIds,
          }
        : null,
    };
  }
}
