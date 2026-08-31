import type {
  Agent,
  ForwardIntentGrant,
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

export interface ResourceForwardPolicyInput extends ResourceReadPolicyInput {
  recipientUserId: string;
  intentGrants: ForwardIntentGrant[];
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

function activeGrant(
  input: ResourceReadPolicyInput,
  allowedActions: ResourceGrant["action"][],
): ResourceGrant | null {
  const now = input.now ?? new Date();
  return input.grants.find((grant) => {
    if (
      grant.resourceId !== input.resource.id ||
      grant.granteeAgentId !== input.agent.id ||
      !allowedActions.includes(grant.action) ||
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
  }) ?? null;
}

function isMember(memberships: GroupMembership[], groupId: string, userId: string): boolean {
  return memberships.some(
    (membership) => membership.groupId === groupId && membership.userId === userId,
  );
}

function evaluateResourceAccess(
  input: ResourceReadPolicyInput,
  mode: "read" | "process",
): PolicyResult {
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
    return activeGrant(input, mode === "process" ? ["read", "process"] : ["read"])
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
  const grant = activeGrant(input, mode === "process" ? ["read", "process"] : ["read"]);
  return grant
    ? allow(
        grant.action === "process" ? "TASK_SCOPED_PROCESS_GRANT" : "TASK_SCOPED_GRANT",
        grant.action === "process"
          ? "The owner granted this group Agent sealed processing access for the task."
          : "The owner granted this group Agent temporary read access.",
      )
    : deny("PRIVATE_GRANT_REQUIRED", "The private resource owner has not granted access.");
}

export function evaluateResourceRead(input: ResourceReadPolicyInput): PolicyResult {
  return evaluateResourceAccess(input, "read");
}

export function evaluateResourceProcess(input: ResourceReadPolicyInput): PolicyResult {
  return evaluateResourceAccess(input, "process");
}

export function evaluateResourceDisclosure(input: ResourceReadPolicyInput): PolicyResult {
  if (input.resource.scope === "private") {
    if (input.resource.ownerUserId !== input.humanId) {
      return deny(
        "PRIVATE_DISCLOSURE_RECIPIENT_DENIED",
        "Processing permission does not authorize disclosure to the initiating human.",
      );
    }
    const disclosureGrant = activeGrant(input, ["disclose"]);
    return disclosureGrant
      ? allow(
          "DISCLOSURE_RECIPIENT_APPROVED",
          "The resource owner approved disclosure to the initiating human for this Run.",
        )
      : deny(
          "PRIVATE_GRANT_REQUIRED",
          "Read or processing permission does not authorize raw private-content disclosure.",
        );
  }
  const read = evaluateResourceRead(input);
  return read.decision === "deny"
    ? read
    : allow(
        "DISCLOSURE_RECIPIENT_APPROVED",
        "The initiating human is permitted to receive the protected resource contents.",
      );
}

export function evaluateResourceForward(input: ResourceForwardPolicyInput): PolicyResult {
  const { agent, humanId, resource, recipientUserId } = input;
  if (agent.status === "stopped" || agent.status === "error") {
    return deny("AGENT_DISABLED", "The executing Agent is not enabled.");
  }
  if (resource.scope !== "private" || resource.ownerUserId !== humanId) {
    return deny(
      "CROSS_OWNER_FORWARD_DENIED",
      "The initiating human cannot authorize forwarding another owner's private resource.",
    );
  }
  if (recipientUserId === humanId) {
    return deny(
      "FORWARD_RECIPIENT_INVALID",
      "Forwarding requires a distinct registered recipient.",
    );
  }
  if (agent.scope === "personal" && agent.ownerUserId !== humanId) {
    return deny(
      "PERSONAL_AGENT_OWNER_MISMATCH",
      "Only the owning human may use this personal Agent.",
    );
  }
  if (agent.groupId && !isMember(input.memberships, agent.groupId, humanId)) {
    return deny(
      "HUMAN_NOT_GROUP_MEMBER",
      "The initiating human is not a current member of the Agent's group.",
    );
  }
  const timestamp = input.now ?? new Date();
  const intent = input.intentGrants.find((grant) =>
    grant.initiatingHumanId === humanId &&
    grant.agentId === agent.id &&
    grant.runId === input.runId &&
    grant.resourceId === resource.id &&
    grant.recipientUserId === recipientUserId &&
    grant.status === "active" &&
    grant.revokedAt === null &&
    new Date(grant.expiresAt) > timestamp
  );
  return intent
    ? allow(
        "USER_INTENT_BOUND_FORWARD",
        "A human-authored message authorized this exact resource and recipient for the current Run.",
      )
    : deny(
        "HUMAN_FORWARD_INTENT_REQUIRED",
        "Agent output and protected content cannot authorize an external forward.",
      );
}
