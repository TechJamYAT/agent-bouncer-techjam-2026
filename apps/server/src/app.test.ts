import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DEMO_GROUP_IDS, DEMO_RESOURCE_IDS, DEMO_USER_IDS } from "./demo-data.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeApp(
  authToken = "",
  nodeEnv: "test" | "production" = "test",
  runnerOverride?: AgentRunner,
) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-http-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: nodeEnv,
    HOST: "127.0.0.1",
    APP_AUTH_TOKEN: authToken,
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const runner: AgentRunner = runnerOverride ?? {
    run: async () => ({ output: "done", threadId: "test-thread", usage: null }),
    cancel: async () => false,
    isAvailable: async () => true,
  };
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return { app: await createApp(config, service), service };
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0] ?? "";
}

async function login(
  app: Awaited<ReturnType<typeof createApp>>,
  authorization?: string,
  username = "alice",
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: authorization ? { authorization } : undefined,
    payload: { username, password: "launchpad-demo" },
  });
  expect(response.statusCode).toBe(200);
  return cookieFrom(response);
}

describe("HTTP boundary", () => {
  it("requires both the optional platform token and a user session", async () => {
    const { app } = await makeApp("a-strong-test-token");
    const authorization = "Bearer a-strong-test-token";

    const missingPlatformToken = await app.inject({ method: "GET", url: "/api/agents" });
    expect(missingPlatformToken.statusCode).toBe(401);

    const missingUserSession = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization },
    });
    expect(missingUserSession.statusCode).toBe(401);

    const cookie = await login(app, authorization);
    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization, cookie },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes after authentication", async () => {
    const { app } = await makeApp();
    const cookie = await login(app);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", cookie },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("does not expose the removed public knowledge scope", async () => {
    const { app } = await makeApp();
    const cookie = await login(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/resources",
      headers: { cookie },
      payload: { title: "Public note", content: "not allowed", scope: "public" },
    });
    expect(response.statusCode).toBe(400);
    const listed = await app.inject({ method: "GET", url: "/api/resources", headers: { cookie } });
    expect(listed.json().resources).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ scope: "public" })]),
    );
    await app.close();
  });

  it("rejects forged identity and Runtime-boundary fields at the HTTP boundary", async () => {
    const { app } = await makeApp();
    const cookie = await login(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { name: "Alice Assistant", scope: "personal" },
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().agent.id as string;

    const attack = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/resources/${DEMO_RESOURCE_IDS.bobPrivate}/read`,
      headers: { cookie },
      payload: {
        humanId: DEMO_USER_IDS.bob,
        runId: "30000000-0000-4000-8000-000000000001",
        taskId: "30000000-0000-4000-8000-000000000002",
      },
    });
    expect(attack.statusCode).toBe(400);

    const session = await app.inject({ method: "GET", url: "/api/session", headers: { cookie } });
    expect(session.json().user.id).toBe(DEMO_USER_IDS.alice);
    await app.close();
  });

  it("enforces an active Run credential through the Runtime HTTP boundary", async () => {
    let capturedRuntimeToken = "";
    let finishRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const runner: AgentRunner = {
      run: async (request) => {
        capturedRuntimeToken = request.runtimeEnvironment?.LAUNCHPAD_RUNTIME_TOKEN ?? "";
        await runGate;
        return { output: "done", threadId: "runtime-http-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { app, service } = await makeApp("", "test", runner);
    const cookie = await login(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { name: "Runtime HTTP Reader", scope: "personal" },
    });
    const agentId = created.json().agent.id as string;
    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: { cookie },
      payload: {
        content: "Read the attached private notes",
        resourceReferences: [{
          ownerUsername: "alice",
          title: "Alice — Private Interview Notes",
        }],
      },
    });
    expect(started.statusCode).toBe(202);
    const runId = started.json().run.id as string;
    await expect.poll(() => capturedRuntimeToken).not.toBe("");

    const allowed = await app.inject({
      method: "POST",
      url: "/api/runtime/resources/read",
      headers: { authorization: `Bearer ${capturedRuntimeToken}` },
      payload: {
        ownerUsername: "alice",
        title: "Alice — Private Interview Notes",
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().decision).toMatchObject({
      runId,
      decision: "allow",
      reasonCode: "EXPLICIT_PRIVATE_GRANT",
    });

    const deniedExact = await app.inject({
      method: "POST",
      url: "/api/runtime/resources/read",
      headers: { authorization: `Bearer ${capturedRuntimeToken}` },
      payload: {
        ownerUsername: "bob",
        title: "Bob — Private Launch Notes",
      },
    });
    const deniedUnknown = await app.inject({
      method: "POST",
      url: "/api/runtime/resources/read",
      headers: { authorization: `Bearer ${capturedRuntimeToken}` },
      payload: {
        ownerUsername: "bob",
        title: "A title that does not exist",
      },
    });
    expect(deniedExact.statusCode).toBe(403);
    expect(deniedUnknown.statusCode).toBe(403);
    expect(deniedExact.json()).toEqual(deniedUnknown.json());
    expect(service.listDecisions(DEMO_USER_IDS.alice)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId,
          targetId: DEMO_RESOURCE_IDS.bobPrivate,
          decision: "deny",
          reasonCode: "PERSONAL_AGENT_OWNER_MISMATCH",
        }),
      ]),
    );

    finishRun();
    await expect.poll(() => service.getRun(runId).status).toBe("completed");
    const expired = await app.inject({
      method: "POST",
      url: "/api/runtime/resources/read",
      headers: { authorization: `Bearer ${capturedRuntimeToken}` },
      payload: {
        ownerUsername: "alice",
        title: "Alice — Private Interview Notes",
      },
    });
    expect(expired.statusCode).toBe(401);
    await app.close();
  });

  it("preserves policy reason codes in the production app", async () => {
    const { app } = await makeApp("", "production");
    const cookie = await login(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie },
      payload: { name: "Policy Probe", scope: "personal" },
    });
    const agentId = created.json().agent.id as string;
    const denied = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/resources/${DEMO_RESOURCE_IDS.alicePrivate}/read`,
      headers: { cookie },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ reasonCode: "PRIVATE_GRANT_REQUIRED" });
    await app.close();
  });

  it("keeps coordination sessions inside the group boundary without an Agent-count cap", async () => {
    const { app } = await makeApp();
    const aliceCookie = await login(app);
    const participantAgentIds: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const created = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { cookie: aliceCookie },
        payload: {
          name: `Alpha Agent ${index}`,
          scope: "group",
          groupId: DEMO_GROUP_IDS.alpha,
        },
      });
      expect(created.statusCode).toBe(201);
      participantAgentIds.push(created.json().agent.id as string);
    }

    const createdSession = await app.inject({
      method: "POST",
      url: `/api/groups/${DEMO_GROUP_IDS.alpha}/coordination-sessions`,
      headers: { cookie: aliceCookie },
      payload: {
        kind: "task",
        mode: "manual",
        title: "Alpha launch task",
        objective: "Prepare the launch",
        participantAgentIds,
      },
    });
    expect(createdSession.statusCode).toBe(201);
    expect(createdSession.json().session.participantAgentIds).toHaveLength(5);
    const sessionId = createdSession.json().session.id as string;

    const bobCookie = await login(app, undefined, "bob");
    const memberRead = await app.inject({
      method: "GET",
      url: `/api/coordination-sessions/${sessionId}`,
      headers: { cookie: bobCookie },
    });
    expect(memberRead.statusCode).toBe(200);

    const projectFiles = await app.inject({
      method: "GET",
      url: `/api/coordination-sessions/${sessionId}/project/files`,
      headers: { cookie: bobCookie },
    });
    expect(projectFiles.statusCode).toBe(200);
    expect(projectFiles.json().files).toEqual(
      expect.arrayContaining([expect.objectContaining({ relativePath: "AGENTS.md" })]),
    );
    const projectPreview = await app.inject({
      method: "GET",
      url: `/api/coordination-sessions/${sessionId}/project/file?path=AGENTS.md`,
      headers: { cookie: bobCookie },
    });
    expect(projectPreview.statusCode).toBe(200);
    expect(projectPreview.json().file).toMatchObject({ kind: "text", relativePath: "AGENTS.md" });
    const projectArchive = await app.inject({
      method: "GET",
      url: `/api/coordination-sessions/${sessionId}/project/archive`,
      headers: { cookie: bobCookie },
    });
    expect(projectArchive.statusCode).toBe(200);
    expect(projectArchive.headers["content-type"]).toContain("application/zip");
    expect(projectArchive.rawPayload.readUInt32LE(0)).toBe(0x04034b50);

    const memberControl = await app.inject({
      method: "PATCH",
      url: `/api/coordination-sessions/${sessionId}/mode`,
      headers: { cookie: bobCookie },
      payload: {
        mode: "automatic",
        expectedVersion: memberRead.json().session.version,
      },
    });
    expect(memberControl.statusCode).toBe(403);

    const emmaCookie = await login(app, undefined, "emma");
    const outsiderRead = await app.inject({
      method: "GET",
      url: `/api/coordination-sessions/${sessionId}`,
      headers: { cookie: emmaCookie },
    });
    expect(outsiderRead.statusCode).toBe(403);
    const outsiderFiles = await app.inject({
      method: "GET",
      url: `/api/coordination-sessions/${sessionId}/project/files`,
      headers: { cookie: emmaCookie },
    });
    expect(outsiderFiles.statusCode).toBe(403);
    await app.close();
  });
});
