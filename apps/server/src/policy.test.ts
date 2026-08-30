import { describe, expect, it } from "vitest";
import { DEMO_GROUP_IDS, DEMO_RESOURCE_IDS, DEMO_USER_IDS } from "./demo-data.js";
import {
  evaluateResourceDisclosure,
  evaluateResourceProcess,
  evaluateResourceRead,
} from "./policy.js";
import type {
  Agent,
  GroupMembership,
  ProtectedResource,
  ResourceGrant,
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

describe("Bouncer resource policy", () => {
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
