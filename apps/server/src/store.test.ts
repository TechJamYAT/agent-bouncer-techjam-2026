import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("migrates Agent-owned workspaces and discards unsafe shared group threads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-v3-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const timestamp = new Date().toISOString();
    const baseAgent = {
      role: "Assistant",
      description: "",
      instructions: "",
      color: "#000000",
      createdByUserId: "user-alice",
      systemManaged: false,
      status: "ready",
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await writeFile(filePath, JSON.stringify({
      version: 3,
      users: [{
        id: "user-alice",
        username: "alice",
        displayName: "Alice",
        passwordHash: "unused",
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      sessions: [],
      groups: [{
        id: "group-alpha",
        name: "Alpha",
        description: "",
        createdByUserId: "user-alice",
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      memberships: [{ groupId: "group-alpha", userId: "user-alice", role: "owner", createdAt: timestamp }],
      agents: [
        {
          ...baseAgent,
          id: "personal-agent",
          name: "Personal",
          scope: "personal",
          ownerUserId: "user-alice",
          groupId: null,
          workspacePath: "/legacy/personal-agent",
          codexThreadId: "safe-personal-thread",
        },
        {
          ...baseAgent,
          id: "group-agent",
          name: "Group",
          scope: "group",
          ownerUserId: null,
          groupId: "group-alpha",
          workspacePath: "/legacy/group-agent",
          codexThreadId: "potentially-mixed-group-thread",
        },
      ],
      messages: [
        { id: "message-1", agentId: "personal-agent", runId: "run-1", humanId: "user-alice", conversationId: null, role: "user", content: "hello", createdAt: timestamp },
        { id: "message-2", agentId: "group-agent", runId: "run-2", humanId: "user-alice", conversationId: null, role: "user", content: "group hello", createdAt: timestamp },
      ],
      runs: [],
      resources: [],
      grants: [],
      authorizationDecisions: [],
      coordinationSessions: [],
      coordinationSteps: [],
      coordinationEvents: [],
    }));

    const store = new JsonStore(filePath);
    await store.initialize();
    const database = store.snapshot();
    expect(database.version).toBe(5);
    expect(database.workspaces).toHaveLength(2);
    expect(database.projects.map((item) => item.sourceAgentId)).toEqual(
      expect.arrayContaining(["personal-agent", "group-agent"]),
    );
    expect(database.agents[0]).not.toHaveProperty("workspacePath");
    expect(database.agents[0]).not.toHaveProperty("codexThreadId");
    expect(database.agentSessions).toHaveLength(1);
    expect(database.agentSessions[0]).toMatchObject({
      agentId: "personal-agent",
      codexThreadId: "safe-personal-thread",
    });
    expect(database.agentSessions.some((item) => item.agentId === "group-agent")).toBe(false);
  });

  it("migrates version 2 data without losing existing records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-migration-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const initial = new JsonStore(filePath);
    await initial.initialize();
    await initial.mutate((database) => {
      database.messages.push({
        id: "message-before-migration",
        agentId: "agent-1",
        runId: "run-1",
        humanId: null,
        conversationId: "legacy-conversation",
        role: "user",
        content: "preserve me",
        createdAt: new Date().toISOString(),
      });
    });
    const versionTwo = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    versionTwo.version = 2;
    delete versionTwo.coordinationSessions;
    delete versionTwo.coordinationSteps;
    delete versionTwo.coordinationEvents;
    delete versionTwo.workspaces;
    delete versionTwo.projects;
    delete versionTwo.conversations;
    delete versionTwo.agentSessions;
    delete versionTwo.sharedFiles;
    delete versionTwo.artifactPublications;
    await writeFile(filePath, JSON.stringify(versionTwo));

    const migrated = new JsonStore(filePath);
    await migrated.initialize();
    expect(migrated.snapshot().version).toBe(5);
    expect(migrated.snapshot().messages[0]?.content).toBe("preserve me");
    expect(migrated.snapshot().messages[0]?.conversationId).toBeTruthy();
    expect(migrated.snapshot().conversations).toHaveLength(1);
    expect(migrated.snapshot().coordinationSessions).toEqual([]);
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          humanId: "user-1",
          conversationId: "conversation-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        humanId: "user-1",
        conversationId: "conversation-1",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});
