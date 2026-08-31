import { describe, expect, it } from "vitest";
import { DEMO_GROUP_IDS, DEMO_RESOURCE_IDS, DEMO_USER_IDS } from "./demo-data.js";
import {
  evaluateResourceDisclosure,
  evaluateResourceForward,
  evaluateResourceProcess,
  evaluateResourceRead,
} from "./policy.js";
import type {
  Agent,
  GroupMembership,
  ProtectedResource,
  ResourceGrant,
  ForwardIntentGrant,
} from "./types.js";

const baseAgent: Agent = {
  id: "agent-alice",
  name: "Alice Assistant",
  role: "Personal Assistant",
  description: "",
  instructions: "",
  color: "#6d5efc",
  scope: "personal",
  ownerUserId: DEMO_USER_IDS.alice,
  groupId: null,
  createdByUserId: DEMO_USER_IDS.alice,
  systemManaged: false,
  status: "ready",
  workspacePath: "/tmp/alice",
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const alicePrivate: ProtectedResource = {
  id: DEMO_RESOURCE_IDS.alicePrivate,
  kind: "document",
  title: "Alice private",
  content: "private",
  scope: "private",
  ownerUserId: DEMO_USER_IDS.alice,
  groupId: null,
  createdByType: "human",
  createdById: DEMO_USER_IDS.alice,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const memberships: GroupMembership[] = [
  {
    groupId: DEMO_GROUP_IDS.alpha,
    userId: DEMO_USER_IDS.alice,
    role: "owner",
    createdAt: "2026-08-26T00:00:00.000Z",
  },
  {
    groupId: DEMO_GROUP_IDS.alpha,
    userId: DEMO_USER_IDS.bob,
    role: "member",
    createdAt: "2026-08-26T00:00:00.000Z",
  },
  {
    groupId: DEMO_GROUP_IDS.beta,
    userId: DEMO_USER_IDS.bob,
    role: "owner",
    createdAt: "2026-08-26T00:00:00.000Z",
  },
];

function grant(overrides: Partial<ResourceGrant> = {}): ResourceGrant {
  return {
    id: "grant-1",
    resourceId: alicePrivate.id,
    granteeAgentId: baseAgent.id,
    grantedByUserId: DEMO_USER_IDS.alice,
    action: "read",
    duration: "persistent",
    runId: null,
    taskId: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function forwardIntent(overrides: Partial<ForwardIntentGrant> = {}): ForwardIntentGrant {
  return {
    id: "forward-intent-1",
    initiatingHumanId: DEMO_USER_IDS.alice,
    agentId: baseAgent.id,
    runId: "run-1",
    conversationId: "conversation-1",
    sourceMessageId: "message-1",
    resourceId: alicePrivate.id,
    recipientUserId: DEMO_USER_IDS.bob,
    status: "active",
    expiresAt: "2026-08-26T01:00:00.000Z",
    deliveredMessageId: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    consumedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("Bouncer resource policy", () => {
  it("allows only a human-intent-bound forward of the owner's resource", () => {
    const input = {
      humanId: DEMO_USER_IDS.alice,
      agent: baseAgent,
      resource: alicePrivate,
      recipientUserId: DEMO_USER_IDS.bob,
      memberships,
      grants: [],
      runId: "run-1",
      now: new Date("2026-08-26T00:30:00.000Z"),
    };
    expect(evaluateResourceForward({ ...input, intentGrants: [] })).toMatchObject({
      decision: "deny",
      reasonCode: "HUMAN_FORWARD_INTENT_REQUIRED",
    });
    expect(evaluateResourceForward({ ...input, intentGrants: [forwardIntent()] })).toMatchObject({
      decision: "allow",
      reasonCode: "USER_INTENT_BOUND_FORWARD",
    });
  });

  it("never lets Alice authorize forwarding Bob's private resource to herself", () => {
    const bobPrivate = {
      ...alicePrivate,
      id: DEMO_RESOURCE_IDS.bobPrivate,
      ownerUserId: DEMO_USER_IDS.bob,
    };
    expect(evaluateResourceForward({
      humanId: DEMO_USER_IDS.alice,
      agent: baseAgent,
      resource: bobPrivate,
      recipientUserId: DEMO_USER_IDS.alice,
      memberships,
      grants: [],
      intentGrants: [forwardIntent({
        resourceId: bobPrivate.id,
        recipientUserId: DEMO_USER_IDS.alice,
      })],
      runId: "run-1",
    })).toMatchObject({
      decision: "deny",
      reasonCode: "CROSS_OWNER_FORWARD_DENIED",
    });
  });

  it("requires consent before an owner's personal Agent reads private data", () => {
    const denied = evaluateResourceRead({
      humanId: DEMO_USER_IDS.alice,
      agent: baseAgent,
      resource: alicePrivate,
      memberships,
      grants: [],
    });
    expect(denied).toMatchObject({
      decision: "deny",
      reasonCode: "PRIVATE_GRANT_REQUIRED",
    });

    const allowed = evaluateResourceRead({
      humanId: DEMO_USER_IDS.alice,
      agent: baseAgent,
      resource: alicePrivate,
      memberships,
      grants: [grant()],
    });
    expect(allowed).toMatchObject({
      decision: "allow",
      reasonCode: "EXPLICIT_PRIVATE_GRANT",
    });
  });

  it("does not treat a private read grant as raw-content disclosure approval", () => {
    const readGrant = grant({ action: "read", duration: "run", runId: "run-1" });
    const input = {
      humanId: DEMO_USER_IDS.alice,
      agent: baseAgent,
      resource: alicePrivate,
      memberships,
      grants: [readGrant],
      runId: "run-1",
    };
    expect(evaluateResourceRead(input)).toMatchObject({ decision: "allow" });
    expect(evaluateResourceDisclosure(input)).toMatchObject({
      decision: "deny",
      reasonCode: "PRIVATE_GRANT_REQUIRED",
    });

    expect(evaluateResourceDisclosure({
      ...input,
      grants: [grant({ action: "disclose", duration: "run", runId: "run-1" })],
    })).toMatchObject({
      decision: "allow",
      reasonCode: "DISCLOSURE_RECIPIENT_APPROVED",
    });
  });

  it("never lets a personal Agent read another human's private data", () => {
    const bobPrivate = {
      ...alicePrivate,
      id: DEMO_RESOURCE_IDS.bobPrivate,
      ownerUserId: DEMO_USER_IDS.bob,
    };
    const forgedGrant = grant({
      resourceId: bobPrivate.id,
      grantedByUserId: DEMO_USER_IDS.bob,
    });
    expect(
      evaluateResourceRead({
        humanId: DEMO_USER_IDS.alice,
        agent: baseAgent,
        resource: bobPrivate,
        memberships,
        grants: [forgedGrant],
      }),
    ).toMatchObject({
      decision: "deny",
      reasonCode: "PERSONAL_AGENT_OWNER_MISMATCH",
    });
  });

  it("does not let a dual-group human lend Beta access to an Alpha Agent", () => {
    const alphaAgent: Agent = {
      ...baseAgent,
      id: "alpha-agent",
      scope: "group",
      ownerUserId: null,
      groupId: DEMO_GROUP_IDS.alpha,
    };
    const betaResource: ProtectedResource = {
      ...alicePrivate,
      id: DEMO_RESOURCE_IDS.betaRoadmap,
      scope: "group",
      ownerUserId: null,
      groupId: DEMO_GROUP_IDS.beta,
    };
    expect(
      evaluateResourceRead({
        humanId: DEMO_USER_IDS.bob,
        agent: alphaAgent,
        resource: betaResource,
        memberships,
        grants: [],
      }),
    ).toMatchObject({ decision: "deny", reasonCode: "AGENT_GROUP_MISMATCH" });
  });

  it("requires the initiating human to be a current group member", () => {
    const alphaAgent: Agent = {
      ...baseAgent,
      id: "alpha-agent",
      scope: "group",
      ownerUserId: null,
      groupId: DEMO_GROUP_IDS.alpha,
    };
    const alphaResource: ProtectedResource = {
      ...alicePrivate,
      scope: "group",
      ownerUserId: null,
      groupId: DEMO_GROUP_IDS.alpha,
    };
    expect(
      evaluateResourceRead({
        humanId: DEMO_USER_IDS.emma,
        agent: alphaAgent,
        resource: alphaResource,
        memberships,
        grants: [],
      }),
    ).toMatchObject({ decision: "deny", reasonCode: "HUMAN_NOT_GROUP_MEMBER" });
  });

  it("limits coordinators to same-group task artifacts", () => {
    const coordinator: Agent = {
      ...baseAgent,
      id: "alpha-coordinator",
      scope: "coordinator",
      ownerUserId: null,
      groupId: DEMO_GROUP_IDS.alpha,
      systemManaged: true,
    };
    const groupDocument: ProtectedResource = {
      ...alicePrivate,
      scope: "group",
      ownerUserId: null,
      groupId: DEMO_GROUP_IDS.alpha,
    };
    expect(
      evaluateResourceRead({
        humanId: DEMO_USER_IDS.alice,
        agent: coordinator,
        resource: groupDocument,
        memberships,
        grants: [],
      }),
    ).toMatchObject({
      decision: "deny",
      reasonCode: "COORDINATOR_RESOURCE_ACCESS_DENIED",
    });
    expect(
      evaluateResourceRead({
        humanId: DEMO_USER_IDS.alice,
        agent: coordinator,
        resource: { ...groupDocument, kind: "task_artifact" },
        memberships,
        grants: [],
      }),
    ).toMatchObject({
      decision: "allow",
      reasonCode: "COORDINATOR_TASK_ARTIFACT_READ",
    });
  });

  it("honors task-scoped group grants only in the matching task", () => {
    const alphaAgent: Agent = {
      ...baseAgent,
      id: "alpha-agent",
      scope: "group",
      ownerUserId: null,
      groupId: DEMO_GROUP_IDS.alpha,
    };
    const taskGrant = grant({
      id: "task-grant",
      granteeAgentId: alphaAgent.id,
      duration: "task",
      taskId: "task-1",
    });
    expect(
      evaluateResourceRead({
        humanId: DEMO_USER_IDS.alice,
        agent: alphaAgent,
        resource: alicePrivate,
        memberships,
        grants: [taskGrant],
        taskId: "task-1",
      }),
    ).toMatchObject({ decision: "allow", reasonCode: "TASK_SCOPED_GRANT" });
    expect(
      evaluateResourceRead({
        humanId: DEMO_USER_IDS.alice,
        agent: alphaAgent,
        resource: alicePrivate,
        memberships,
        grants: [taskGrant],
        taskId: "task-2",
      }),
    ).toMatchObject({ decision: "deny", reasonCode: "PRIVATE_GRANT_REQUIRED" });
  });

  it("separates cross-user task processing from disclosure to the initiator", () => {
    const alphaAgent: Agent = {
      ...baseAgent,
      id: "alpha-privacy-agent",
      scope: "group",
      ownerUserId: null,
      groupId: DEMO_GROUP_IDS.alpha,
    };
    const bobPrivate: ProtectedResource = {
      ...alicePrivate,
      id: DEMO_RESOURCE_IDS.bobPrivate,
      ownerUserId: DEMO_USER_IDS.bob,
    };
    const processGrant = grant({
      resourceId: bobPrivate.id,
      granteeAgentId: alphaAgent.id,
      grantedByUserId: DEMO_USER_IDS.bob,
      action: "process",
      duration: "task",
      taskId: "task-1",
    });
    const input = {
      humanId: DEMO_USER_IDS.alice,
      agent: alphaAgent,
      resource: bobPrivate,
      memberships,
      grants: [processGrant],
      taskId: "task-1",
    };
    expect(evaluateResourceProcess(input)).toMatchObject({
      decision: "allow",
      reasonCode: "TASK_SCOPED_PROCESS_GRANT",
    });
    expect(evaluateResourceRead(input)).toMatchObject({
      decision: "deny",
      reasonCode: "PRIVATE_GRANT_REQUIRED",
    });
    expect(evaluateResourceDisclosure(input)).toMatchObject({
      decision: "deny",
      reasonCode: "PRIVATE_DISCLOSURE_RECIPIENT_DENIED",
    });
  });
});
