import type { Agent, Group, GroupMembership, ProtectedResource, User } from "./types.js";

export const DEMO_USER_IDS = {
  alice: "00000000-0000-4000-8000-000000000001",
  bob: "00000000-0000-4000-8000-000000000002",
  carol: "00000000-0000-4000-8000-000000000003",
  david: "00000000-0000-4000-8000-000000000004",
  emma: "00000000-0000-4000-8000-000000000005",
} as const;

export const DEMO_GROUP_IDS = {
  alpha: "10000000-0000-4000-8000-000000000001",
  beta: "10000000-0000-4000-8000-000000000002",
} as const;

export const DEMO_AGENT_IDS = {
  case: "30000000-0000-4000-8000-000000000001",
} as const;

export const DEMO_RESOURCE_IDS = {
  alicePrivate: "20000000-0000-4000-8000-000000000002",
  bobPrivate: "20000000-0000-4000-8000-000000000003",
  alphaBrief: "20000000-0000-4000-8000-000000000004",
  betaRoadmap: "20000000-0000-4000-8000-000000000005",
} as const;

const SEEDED_AT = "2026-08-26T00:00:00.000Z";

export function demoUsers(passwordHash: string): User[] {
  return Object.entries(DEMO_USER_IDS).map(([username, id]) => ({
    id,
    username,
    displayName: (username[0]?.toUpperCase() ?? "") + username.slice(1),
    passwordHash,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  }));
}

export function demoGroups(): Group[] {
  return [
    {
      id: DEMO_GROUP_IDS.alpha,
      name: "Alpha Product Team",
      description: "A cross-functional product delivery group.",
      createdByUserId: DEMO_USER_IDS.alice,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
    {
      id: DEMO_GROUP_IDS.beta,
      name: "Beta Product Team",
      description: "A separate team with an independent security boundary.",
      createdByUserId: DEMO_USER_IDS.bob,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
  ];
}

export function demoMemberships(): GroupMembership[] {
  return [
    { groupId: DEMO_GROUP_IDS.alpha, userId: DEMO_USER_IDS.alice, role: "owner", createdAt: SEEDED_AT },
    { groupId: DEMO_GROUP_IDS.alpha, userId: DEMO_USER_IDS.bob, role: "member", createdAt: SEEDED_AT },
    { groupId: DEMO_GROUP_IDS.alpha, userId: DEMO_USER_IDS.carol, role: "member", createdAt: SEEDED_AT },
    { groupId: DEMO_GROUP_IDS.beta, userId: DEMO_USER_IDS.bob, role: "owner", createdAt: SEEDED_AT },
    { groupId: DEMO_GROUP_IDS.beta, userId: DEMO_USER_IDS.david, role: "member", createdAt: SEEDED_AT },
  ];
}

export function demoAgents(): Agent[] {
  return [
    {
      id: DEMO_AGENT_IDS.case,
      name: "Case",
      role: "Launch Risk Reviewer",
      description: "Reviews protected launch notes through Bouncer sealed processing.",
      instructions: [
        "For protected resources, follow the workspace vault instructions exactly.",
        "Use sealed assess for analysis and disclose only when the task asks to share source text.",
        "Never invent policy results or reveal protected content from memory.",
      ].join(" "),
      color: "#6d5efc",
      scope: "group",
      ownerUserId: null,
      groupId: DEMO_GROUP_IDS.alpha,
      createdByUserId: DEMO_USER_IDS.alice,
      systemManaged: false,
      status: "ready",
      lastError: null,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
  ];
}

export function demoResources(): ProtectedResource[] {
  return [
    {
      id: DEMO_RESOURCE_IDS.alicePrivate,
      kind: "document",
      title: "Alice — Private Interview Notes",
      content: "Users want a guided handoff between specialist Agents.",
      scope: "private",
      ownerUserId: DEMO_USER_IDS.alice,
      groupId: null,
      createdByType: "human",
      createdById: DEMO_USER_IDS.alice,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
    {
      id: DEMO_RESOURCE_IDS.bobPrivate,
      kind: "document",
      title: "Bob — Private Launch Notes",
      content: "Confidential: Beta launch assumptions and risk notes.",
      scope: "private",
      ownerUserId: DEMO_USER_IDS.bob,
      groupId: null,
      createdByType: "human",
      createdById: DEMO_USER_IDS.bob,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
    {
      id: DEMO_RESOURCE_IDS.alphaBrief,
      kind: "document",
      title: "Alpha Product Brief",
      content: "Build a permission-aware workspace for guided Agent collaboration.",
      scope: "group",
      ownerUserId: null,
      groupId: DEMO_GROUP_IDS.alpha,
      createdByType: "human",
      createdById: DEMO_USER_IDS.alice,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
    {
      id: DEMO_RESOURCE_IDS.betaRoadmap,
      kind: "document",
      title: "Beta Confidential Roadmap",
      content: "Confidential: Beta-only milestones and release dates.",
      scope: "group",
      ownerUserId: null,
      groupId: DEMO_GROUP_IDS.beta,
      createdByType: "human",
      createdById: DEMO_USER_IDS.bob,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
    },
  ];
}
