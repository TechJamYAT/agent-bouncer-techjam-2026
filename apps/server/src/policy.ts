import type {
  Agent,
  GroupMembership,
  ProtectedResource,
  ResourceGrant,
} from "./types.js";

export interface ResourceReadPolicyInput {
  humanId: string;
  agent: Agent;
  resource: ProtectedResource;
  memberships: GroupMembership[];
  grants: ResourceGrant[];
  runId?: string | undefined;
  taskId?: string | undefined;
  now?: Date | undefined;
}

export interface PolicyResult {
  decision: "allow" | "deny";
  reasonCode: string;
  detail: string;
}

const allow = (reasonCode: string, detail: string): PolicyResult => ({
  decision: "allow",
  reasonCode,
  detail,
});

const deny = (reasonCode: string, detail: string): PolicyResult => ({
  decision: "deny",
  reasonCode,
  detail,
});

function hasActiveGrant(input: ResourceReadPolicyInput): boolean {
  const now = input.now ?? new Date();
  return input.grants.some((grant) => {
    if (
      grant.resourceId !== input.resource.id ||
      grant.granteeAgentId !== input.agent.id ||
      grant.action !== "read" ||
      grant.revokedAt !== null
    ) {
      return false;
    }
    if (grant.expiresAt && new Date(grant.expiresAt) <= now) return false;
    if (grant.duration === "run") return grant.runId !== null && grant.runId === input.runId;
    if (grant.duration === "task") {
      return grant.taskId !== null && grant.taskId === input.taskId;
    }
    return true;
  });
}

function isMember(memberships: GroupMembership[], groupId: string, userId: string): boolean {
  return memberships.some(
    (membership) => membership.groupId === groupId && membership.userId === userId,
  );
}

export function evaluateResourceRead(input: ResourceReadPolicyInput): PolicyResult {
  const { agent, humanId, memberships, resource } = input;

  if (agent.status === "stopped" || agent.status === "error") {
    return deny("AGENT_DISABLED", "The executing Agent is not enabled.");
  }

  if (agent.scope === "personal") {
    if (!agent.ownerUserId || agent.ownerUserId !== humanId) {
      return deny(
        "PERSONAL_AGENT_OWNER_MISMATCH",
        "Only the owning human may use this personal Agent.",
      );
    }
    if (resource.scope === "group") {
      return deny(
        "PERSONAL_AGENT_GROUP_ACCESS_DENIED",
        "Personal Agents do not inherit their owner's group memberships.",
      );
    }
    if (resource.ownerUserId !== agent.ownerUserId) {
      return deny(
        "PERSONAL_AGENT_OWNER_MISMATCH",
        "A personal Agent can never read another human's private resource.",
      );
    }
    return hasActiveGrant(input)
      ? allow("EXPLICIT_PRIVATE_GRANT", "The owner granted this Agent read access.")
      : deny("PRIVATE_GRANT_REQUIRED", "The private resource owner has not granted access.");
  }

  const groupId = agent.groupId;
  if (!groupId) {
    return deny("AGENT_GROUP_MISMATCH", "The group Agent has no group owner.");
  }
  if (!isMember(memberships, groupId, humanId)) {
    return deny(
      "HUMAN_NOT_GROUP_MEMBER",
      "The initiating human is not a current member of the Agent's group.",
    );
  }
  if (agent.scope === "coordinator") {
    if (
      resource.scope === "group" &&
      resource.groupId === groupId &&
      resource.kind === "task_artifact"
    ) {
      return allow(
        "COORDINATOR_TASK_ARTIFACT_READ",
        "The coordinator may read same-group task artifacts for orchestration.",
      );
    }
    return deny(
      "COORDINATOR_RESOURCE_ACCESS_DENIED",
      "Coordinators receive resource metadata and task artifacts, not source document contents.",
    );
  }
  if (resource.scope === "group") {
    return resource.groupId === groupId
      ? allow("SAME_GROUP_RESOURCE", "The Agent and resource belong to the same group.")
      : deny("AGENT_GROUP_MISMATCH", "A group Agent cannot read another group's resource.");
  }
  if (!resource.ownerUserId || !isMember(memberships, groupId, resource.ownerUserId)) {
    return deny(
      "PRIVATE_OWNER_NOT_GROUP_MEMBER",
      "A group Agent cannot read a non-member's private resource.",
    );
  }
  return hasActiveGrant(input)
    ? allow("TASK_SCOPED_GRANT", "The owner granted this group Agent temporary access.")
    : deny("PRIVATE_GRANT_REQUIRED", "The private resource owner has not granted access.");
}
