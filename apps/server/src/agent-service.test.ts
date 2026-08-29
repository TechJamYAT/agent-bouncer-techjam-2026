import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService, redactAuditDetail } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { DEMO_GROUP_IDS, DEMO_RESOURCE_IDS, DEMO_USER_IDS } from "./demo-data.js";
import { RunCancelledError } from "./errors.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("restricts group Agent creation and management to group owners and admins", async () => {
    const service = await makeService();
    await expect(
      service.createAgent(
        { name: "Bob Alpha Agent", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
        DEMO_USER_IDS.bob,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const aliceAgent = await service.createAgent(
      { name: "Alice Alpha Agent", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );

    await expect(
      service.updateAgent(aliceAgent.id, { description: "Bob tries to edit" }, DEMO_USER_IDS.bob),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.updateAgent(aliceAgent.id, { description: "Owner moderation" }, DEMO_USER_IDS.alice),
    ).resolves.toMatchObject({ description: "Owner moderation" });
    await expect(service.deleteAgent(aliceAgent.id, DEMO_USER_IDS.alice)).resolves.toHaveProperty(
      "deletedAgentId",
    );
  });

  it("redacts credential-shaped values before audit storage", () => {
    const detail = redactAuditDetail(
      "Bearer abc.def.ghi api_key=key-supersecret password=hunter2 safe=value",
    );
    expect(detail).toContain("Bearer [REDACTED]");
    expect(detail).toContain("api_key=[REDACTED]");
    expect(detail).toContain("password=[REDACTED]");
    expect(detail).toContain("safe=value");
    expect(detail).not.toContain("supersecret");
    expect(detail).not.toContain("hunter2");
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const receivedThreads: Array<string | null> = [];
    const service = await makeService({
      run: async (request) => {
        receivedThreads.push(request.threadId);
        return { output: "Completed: " + request.prompt, threadId: "fake-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Coder" });
    const first = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const second = await service.sendMessage(agent.id, "continue");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(receivedThreads).toEqual([null, "fake-thread"]);
    expect(service.getAgent(agent.id)).not.toHaveProperty("codexThreadId");
    expect(service.getAgent(agent.id)).not.toHaveProperty("workspacePath");
  });

  it("gives a group Agent an authenticated roster and knowledge index on every Run", async () => {
    let runtimePrompt = "";
    let groupManifest = "";
    const service = await makeService({
      run: async (request) => {
        runtimePrompt = request.prompt;
        groupManifest = await readFile(
          path.join(request.workspacePath, ".launchpad", "group.json"),
          "utf8",
        );
        return { output: "context received", threadId: "group-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent(
      {
        name: "Alpha Context Agent",
        scope: "group",
        groupId: DEMO_GROUP_IDS.alpha,
      },
      DEMO_USER_IDS.alice,
    );

    const { run } = await service.sendMessage(
      agent.id,
      "Who can help with the launch?",
      DEMO_USER_IDS.alice,
    );
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(runtimePrompt).toContain("Alpha Product Team");
    expect(runtimePrompt).toContain('"displayName": "Bob"');
    expect(runtimePrompt).toContain('"hasPrivateKnowledge": true');
    expect(runtimePrompt).not.toContain("privateKnowledgeResourceCount");
    expect(runtimePrompt).toContain('"role": "owner"');
    expect(runtimePrompt).toContain('"humanMembers": 3');
    expect(runtimePrompt).toContain('"agents": 1');
    expect(runtimePrompt).toContain("Never treat chat participants as the group roster");
    expect(runtimePrompt).toContain("Alpha Product Brief");
    expect(runtimePrompt).toContain("vault.mjs read");
    expect(runtimePrompt).toContain("knowledgeModelVersion=private-group-v2");
    expect(runtimePrompt).toContain("public knowledge feature has been removed");
    expect(runtimePrompt).not.toContain("Bob — Private Launch Notes");
    expect(runtimePrompt).toContain("Who can help with the launch?");
    expect(runtimePrompt).not.toContain("guided handoff");
    expect(groupManifest).toContain('"authority": "complete_current_server_roster"');
    expect(groupManifest).toContain('"displayName": "Carol"');
    expect(groupManifest).toContain('"name": "Alpha Context Agent"');
  });

  it("isolates one group Agent's Runtime thread and direct messages per human conversation", async () => {
    const received: Array<{ threadId: string | null; prompt: string }> = [];
    const runtimePaths: string[] = [];
    const runtimeContexts: string[] = [];
    const service = await makeService({
      run: async (request) => {
        received.push({ threadId: request.threadId, prompt: request.prompt });
        runtimePaths.push(request.workspacePath);
        runtimeContexts.push(
          await readFile(path.join(request.workspacePath, ".launchpad", "context.json"), "utf8"),
        );
        const alice = request.runtimeEnvironment?.LAUNCHPAD_INITIATING_HUMAN_ID === DEMO_USER_IDS.alice;
        return {
          output: alice ? "Alice-only response" : "Bob-only response",
          threadId: alice ? "alice-group-agent-thread" : "bob-group-agent-thread",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent(
      { name: "Shared Alpha Agent", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    let groupChat = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "group_chat",
      mode: "manual",
      title: "Visible Alpha chat",
      participantAgentIds: [],
    });
    groupChat = await service.appendCoordinationMessage(
      DEMO_USER_IDS.bob,
      groupChat.session.id,
      "Group-visible launch update",
    );

    const aliceFirst = await service.sendMessage(agent.id, "Alice private turn", DEMO_USER_IDS.alice);
    await expect.poll(() => service.getRun(aliceFirst.run.id).status).toBe("completed");
    const bobFirst = await service.sendMessage(agent.id, "Bob private turn", DEMO_USER_IDS.bob);
    await expect.poll(() => service.getRun(bobFirst.run.id).status).toBe("completed");
    const aliceSecond = await service.sendMessage(agent.id, "Alice continues", DEMO_USER_IDS.alice);
    await expect.poll(() => service.getRun(aliceSecond.run.id).status).toBe("completed");

    expect(received.map((item) => item.threadId)).toEqual([
      null,
      null,
      "alice-group-agent-thread",
    ]);
    expect(runtimePaths[0]).not.toBe(runtimePaths[1]);
    expect(runtimePaths[0]).toBe(runtimePaths[2]);
    expect(runtimeContexts[0]).toContain("Alice private turn");
    expect(runtimeContexts[0]).not.toContain("Bob private turn");
    expect(runtimeContexts[1]).toContain("Bob private turn");
    expect(runtimeContexts[1]).not.toContain("Alice private turn");
    expect(runtimeContexts[2]).toContain("Alice private turn");
    expect(runtimeContexts[2]).toContain("Alice-only response");
    expect(runtimeContexts[2]).not.toContain("Bob private turn");
    expect(runtimeContexts.every((context) => context.includes("Group-visible launch update")))
      .toBe(true);
    expect(runtimeContexts.every((context) => !context.includes("Beta roadmap"))).toBe(true);
    expect(service.getMessages(agent.id, DEMO_USER_IDS.bob).map((item) => item.content))
      .toEqual(["Bob private turn", "Bob-only response"]);
    await expect(
      Promise.resolve().then(() => service.getRun(aliceFirst.run.id, DEMO_USER_IDS.bob)),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("gives each Run an ephemeral, identity-bound resource credential", async () => {
    let service!: AgentService;
    let capturedToken = "";
    let runtimeWorkspace = "";
    const runner: AgentRunner = {
      run: async (request) => {
        runtimeWorkspace = request.workspacePath;
        capturedToken = request.runtimeEnvironment?.LAUNCHPAD_RUNTIME_TOKEN ?? "";
        expect(capturedToken).not.toBe("");
        expect(request.runtimeEnvironment?.LAUNCHPAD_CONTROL_PLANE_URL).toContain("127.0.0.1");
        const listed = service.listResourcesForRuntime(capturedToken);
        expect(listed.some((resource) => resource.id === DEMO_RESOURCE_IDS.alicePrivate)).toBe(true);
        expect(listed.every((resource) => !("content" in resource))).toBe(true);
        const catalog = service.getResourceCatalogForRuntime(capturedToken);
        expect(catalog.publicKnowledgeFeature).toBe("removed");
        expect(catalog.privateKnowledgeOwners).toEqual([
          expect.objectContaining({
            username: "alice",
            hasPrivateKnowledge: true,
            detailVisibility: "existence_only",
          }),
        ]);
        expect(JSON.stringify(catalog.privateKnowledgeOwners)).not.toContain(
          "Bob — Private Launch Notes",
        );
        const attachedPrivateRead = await service.readResourceForRuntimeByReference(capturedToken, {
          ownerUsername: "alice",
          title: "Alice — Private Interview Notes",
        });
        expect(attachedPrivateRead.decision.reasonCode).toBe("EXPLICIT_PRIVATE_GRANT");
        await expect(
          service.readResourceForRuntimeByReference(capturedToken, {
            ownerUsername: "bob",
            title: "Bob — Private Launch Notes",
          }),
        ).rejects.toMatchObject({
          statusCode: 403,
          message: "Access Denied: RESOURCE_REFERENCE_UNAVAILABLE",
        });
        await expect(
          service.readResourceForRuntimeByReference(capturedToken, {
            ownerUsername: "bob",
            title: "A title that does not exist",
          }),
        ).rejects.toMatchObject({
          statusCode: 403,
          message: "Access Denied: RESOURCE_REFERENCE_UNAVAILABLE",
        });
        return { output: "used the protected resource tool", threadId: "runtime-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    service = await makeService(runner);
    const agent = await service.createAgent({ name: "Runtime Reader" });
    const { run } = await service.sendMessage(
      agent.id,
      "read the attached private notes",
      DEMO_USER_IDS.alice,
      [{ ownerUsername: "alice", title: "Alice — Private Interview Notes" }],
    );
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const tool = await readFile(
      path.join(runtimeWorkspace, ".launchpad", "tools", "vault.mjs"),
      "utf8",
    );
    expect(tool).toContain("LAUNCHPAD_RUNTIME_TOKEN");
    expect(tool).toContain("--owner");
    expect(tool).toContain("ownerUsername");
    expect(tool).not.toContain("test-key");
    expect(
      service.listDecisions(DEMO_USER_IDS.alice).some(
        (decision) =>
          decision.targetId === DEMO_RESOURCE_IDS.bobPrivate &&
          decision.decision === "deny" &&
          decision.reasonCode === "PERSONAL_AGENT_OWNER_MISMATCH",
      ),
    ).toBe(true);
    expect(() => service.listResourcesForRuntime(capturedToken)).toThrowError(
      "Runtime credential is invalid or expired",
    );
    const completedRunGrant = service.listGrants(DEMO_USER_IDS.alice).find(
      (grant) => grant.runId === run.id,
    );
    expect(completedRunGrant?.revokedAt).not.toBeNull();
    expect(service.listDecisions(DEMO_USER_IDS.alice)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: run.id,
          action: "grant:revoke",
          reasonCode: "RUN_SCOPE_ENDED",
          targetLabel: "Alice — Private Interview Notes",
          targetOwnerName: "Alice",
        }),
      ]),
    );
  });
});

describe("Track B end-to-end policy", () => {
  it("creates auditable knowledge resources and exposes only the owner's grants", async () => {
    const service = await makeService();
    const resource = await service.createResource(DEMO_USER_IDS.alice, {
      title: "Alice launch notes",
      content: "Private launch context",
      scope: "private",
    });
    const agent = await service.createAgent(
      { name: "Alice Knowledge Agent" },
      DEMO_USER_IDS.alice,
    );
    const grant = await service.createGrant(DEMO_USER_IDS.alice, {
      agentId: agent.id,
      resourceId: resource.id,
      duration: "persistent",
    });

    expect(service.listGrants(DEMO_USER_IDS.alice)).toContainEqual(grant);
    expect(service.listGrants(DEMO_USER_IDS.bob)).not.toContainEqual(grant);
    await expect(
      service.createGrant(DEMO_USER_IDS.alice, {
        agentId: agent.id,
        resourceId: resource.id,
        duration: "persistent",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await service.revokeGrant(DEMO_USER_IDS.alice, grant.id);
    expect(service.listGrants(DEMO_USER_IDS.alice).find((item) => item.id === grant.id)?.revokedAt)
      .not.toBeNull();
    expect(service.listDecisions(DEMO_USER_IDS.alice).map((item) => item.reasonCode))
      .toContain("PRIVATE_RESOURCE_CREATED");
  });

  it("records successful group membership changes in the authorization history", async () => {
    const service = await makeService();

    await service.addMember(
      DEMO_USER_IDS.alice,
      DEMO_GROUP_IDS.alpha,
      DEMO_USER_IDS.emma,
      "member",
    );
    await service.removeMember(
      DEMO_USER_IDS.alice,
      DEMO_GROUP_IDS.alpha,
      DEMO_USER_IDS.emma,
    );

    expect(service.listDecisions(DEMO_USER_IDS.alice).map((item) => item.reasonCode))
      .toEqual(expect.arrayContaining(["GROUP_MEMBER_ADDED", "GROUP_MEMBER_REMOVED"]));
  });

  it("denies Alice before consent, allows after consent, and always denies Bob's private data", async () => {
    const service = await makeService();
    const agent = await service.createAgent(
      { name: "Alice Assistant", role: "Personal Assistant" },
      DEMO_USER_IDS.alice,
    );

    await expect(
      service.readResourceAsAgent(
        DEMO_USER_IDS.alice,
        agent.id,
        DEMO_RESOURCE_IDS.alicePrivate,
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Access Denied: PRIVATE_GRANT_REQUIRED",
    });

    await service.createGrant(DEMO_USER_IDS.alice, {
      agentId: agent.id,
      resourceId: DEMO_RESOURCE_IDS.alicePrivate,
      duration: "persistent",
    });
    const allowed = await service.readResourceAsAgent(
      DEMO_USER_IDS.alice,
      agent.id,
      DEMO_RESOURCE_IDS.alicePrivate,
    );
    expect(allowed.resource.content).toContain("guided handoff");
    expect(allowed.decision.reasonCode).toBe("EXPLICIT_PRIVATE_GRANT");

    await expect(
      service.readResourceAsAgent(
        DEMO_USER_IDS.alice,
        agent.id,
        DEMO_RESOURCE_IDS.bobPrivate,
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Access Denied: PERSONAL_AGENT_OWNER_MISMATCH",
    });

    expect(service.listDecisions(DEMO_USER_IDS.alice).map((item) => item.reasonCode))
      .toEqual(expect.arrayContaining([
        "PRIVATE_GRANT_REQUIRED",
        "EXPLICIT_PRIVATE_GRANT",
        "PERSONAL_AGENT_OWNER_MISMATCH",
      ]));
  });

  it("denies an Alpha Agent access to Beta even when Bob initiates", async () => {
    const service = await makeService();
    const alphaAgent = await service.createAgent(
      {
        name: "Alpha Programmer",
        role: "Programmer",
        scope: "group",
        groupId: DEMO_GROUP_IDS.alpha,
      },
      DEMO_USER_IDS.alice,
    );

    const sameGroup = await service.readResourceAsAgent(
      DEMO_USER_IDS.bob,
      alphaAgent.id,
      DEMO_RESOURCE_IDS.alphaBrief,
    );
    expect(sameGroup.decision.reasonCode).toBe("SAME_GROUP_RESOURCE");

    await expect(
      service.readResourceAsAgent(
        DEMO_USER_IDS.bob,
        alphaAgent.id,
        DEMO_RESOURCE_IDS.betaRoadmap,
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Access Denied: AGENT_GROUP_MISMATCH",
    });
  });
});

describe("Multi-Agent coordination Runtime", () => {
  it("lets only the initiator interrupt a running round and continue it", async () => {
    let activeReject: ((error: Error) => void) | null = null;
    let workerCalls = 0;
    const service = await makeService({
      run: async () => {
        workerCalls += 1;
        if (workerCalls === 1) {
          return new Promise<RunnerResult>((_resolve, reject) => {
            activeReject = reject;
          });
        }
        return { output: "Completed after the initiator resumed the round.", threadId: null, usage: null };
      },
      cancel: async () => {
        activeReject?.(new RunCancelledError());
        activeReject = null;
        return true;
      },
      isAvailable: async () => true,
    });
    const worker = await service.createAgent(
      { name: "Interruptible Worker", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    let task = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "task",
      mode: "manual",
      title: "Interruptible task",
      objective: "Allow the initiator to pause and continue",
      participantAgentIds: [worker.id],
    });
    const launched = await service.advanceCoordinationSession(
      DEMO_USER_IDS.alice,
      task.session.id,
      task.session.version,
    );
    await expect.poll(() => activeReject !== null).toBe(true);
    task = service.getCoordinationSession(DEMO_USER_IDS.alice, task.session.id);

    await expect(
      service.interruptCoordinationSession(
        DEMO_USER_IDS.bob,
        task.session.id,
        task.session.version,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    task = await service.interruptCoordinationSession(
      DEMO_USER_IDS.alice,
      task.session.id,
      task.session.version,
    );
    expect(service.getRun(launched.run!.id).status).toBe("cancelled");
    expect(task.session).toMatchObject({
      status: "waiting_for_human",
      callsInCurrentRound: 0,
      interruption: { status: "paused", requestedByUserId: DEMO_USER_IDS.alice },
    });

    const resumed = await service.resolveCoordinationInterruption(
      DEMO_USER_IDS.alice,
      task.session.id,
      "continue",
      task.session.version,
    );
    expect(resumed.run).not.toBeNull();
    await expect.poll(() => service.getRun(resumed.run!.id).status).toBe("completed");
    task = service.getCoordinationSession(DEMO_USER_IDS.alice, task.session.id);
    expect(task.session.status).toBe("completed");
    expect(task.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "round.interrupt_requested" }),
      expect.objectContaining({ type: "round.interrupted" }),
      expect.objectContaining({ type: "round.resumed" }),
    ]));
  });

  it("keeps the original coordinator plan across manual checkpoints without new context", async () => {
    let firstAgentId = "";
    let secondAgentId = "";
    let coordinatorCalls = 0;
    const specialistCalls: string[] = [];
    const service = await makeService({
      run: async (request) => {
        if (request.agentId === firstAgentId || request.agentId === secondAgentId) {
          specialistCalls.push(request.agentId);
          return {
            output: request.agentId === firstAgentId
              ? "The first specialist committed new evidence."
              : "The second specialist incorporated that evidence.",
            threadId: null,
            usage: null,
          };
        }
        coordinatorCalls += 1;
        if (coordinatorCalls === 1) {
          return {
            output: JSON.stringify({
              decision: "continue",
              rationale: "Start with evidence, then prepare the result.",
              steps: [
                { agentId: firstAgentId, instruction: "Collect the evidence." },
                { agentId: secondAgentId, instruction: "Prepare the result." },
              ],
            }),
            threadId: null,
            usage: null,
          };
        }
        return {
          output: JSON.stringify({
            decision: "complete",
            rationale: "Both reviewed contributions now satisfy the objective.",
            steps: [],
          }),
          threadId: null,
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const firstAgent = await service.createAgent(
      { name: "Evidence Agent", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    const secondAgent = await service.createAgent(
      { name: "Result Agent", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    firstAgentId = firstAgent.id;
    secondAgentId = secondAgent.id;
    let task = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "task",
      mode: "manual",
      title: "Manual coordinator checkpoints",
      objective: "Produce a result from reviewed evidence",
      participantAgentIds: [firstAgent.id, secondAgent.id],
      coordinatorEnabled: true,
    });

    const first = await service.advanceCoordinationSession(
      DEMO_USER_IDS.alice,
      task.session.id,
      task.session.version,
    );
    await expect.poll(() => service.getRun(first.run!.id).status).toBe("completed");
    task = service.getCoordinationSession(DEMO_USER_IDS.alice, task.session.id);
    expect(coordinatorCalls).toBe(1);
    expect(task.session.manualAdvanceRequest?.status).toBe("pending");

    const second = await service.resolveCoordinationManualAdvance(
      DEMO_USER_IDS.alice,
      task.session.id,
      "approve",
      task.session.version,
    );
    await expect.poll(() => service.getRun(second.run!.id).status).toBe("completed");
    task = service.getCoordinationSession(DEMO_USER_IDS.alice, task.session.id);
    expect(coordinatorCalls).toBe(1);
    expect(specialistCalls).toEqual([firstAgent.id, secondAgent.id]);
    expect(task.events.filter((event) => event.type === "plan.replaced")).toHaveLength(1);

    const completed = await service.resolveCoordinationManualAdvance(
      DEMO_USER_IDS.alice,
      task.session.id,
      "approve",
      task.session.version,
    );
    expect(completed.run).toBeNull();
    expect(completed.snapshot.session.status).toBe("completed");
    expect(coordinatorCalls).toBe(2);
  });

  it("lets automatic mode use a system coordinator to continue or complete across rounds", async () => {
    let workerId = "";
    let coordinatorCalls = 0;
    const service = await makeService({
      run: async (request) => {
        if (request.agentId === workerId) {
          return { output: "The specialist produced a complete reviewed result.", threadId: "worker-thread", usage: null };
        }
        coordinatorCalls += 1;
        return coordinatorCalls === 1
          ? {
              output: JSON.stringify({
                decision: "continue",
                rationale: "One specialist contribution is needed.",
                steps: [{ agentId: workerId, instruction: "Produce and review the requested result." }],
              }),
              threadId: "coordinator-thread",
              usage: null,
            }
          : {
              output: JSON.stringify({
                decision: "complete",
                rationale: "The reviewed result satisfies the objective.",
                steps: [],
              }),
              threadId: "coordinator-thread",
              usage: null,
            };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const worker = await service.createAgent(
      { name: "Review Worker", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    workerId = worker.id;
    let task = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "task",
      mode: "automatic",
      title: "Coordinator loop",
      objective: "Produce a reviewed result",
      participantAgentIds: [worker.id],
      coordinatorEnabled: true,
    });
    expect(task.session).toMatchObject({
      coordinatorEnabled: true,
      planVersion: 0,
      needsReplan: true,
    });
    expect(service.listAgents(DEMO_USER_IDS.alice)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "coordinator", systemManaged: true }),
      ]),
    );

    await expect.poll(
      () => service.getCoordinationSession(DEMO_USER_IDS.alice, task.session.id).session.status,
    ).toBe("completed");
    task = service.getCoordinationSession(DEMO_USER_IDS.alice, task.session.id);
    expect(coordinatorCalls).toBe(2);
    expect(task.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "round.completed" }),
        expect.objectContaining({ type: "coordinator.decision", content: "The reviewed result satisfies the objective." }),
        expect.objectContaining({
          type: "agent.message",
          actorType: "agent",
          content: expect.stringContaining("本次任务已结束。"),
        }),
      ]),
    );
  });

  it("resumes an approved unfinished plan without calling the coordinator again", async () => {
    let workerId = "";
    let coordinatorCalls = 0;
    let workerCalls = 0;
    const service = await makeService({
      run: async (request) => {
        if (request.agentId === workerId) {
          workerCalls += 1;
          return {
            output: `Original plan step ${workerCalls} completed.`,
            threadId: "worker-thread",
            usage: null,
          };
        }
        coordinatorCalls += 1;
        return coordinatorCalls === 1
          ? {
              output: JSON.stringify({
                decision: "continue",
                rationale: "The original design requires two ordered specialist steps.",
                steps: [
                  { agentId: workerId, instruction: "Complete original step one." },
                  { agentId: workerId, instruction: "Complete original step two." },
                ],
              }),
              threadId: "coordinator-thread",
              usage: null,
            }
          : {
              output: JSON.stringify({
                decision: "complete",
                rationale: "Both steps in the original design are complete.",
                steps: [],
              }),
              threadId: "coordinator-thread",
              usage: null,
            };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const worker = await service.createAgent(
      { name: "Original Plan Worker", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    workerId = worker.id;
    const created = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "task",
      mode: "automatic",
      title: "Continue an approved plan",
      objective: "Execute both steps without redundant replanning",
      participantAgentIds: [worker.id],
      coordinatorEnabled: true,
      maxCallsPerRound: 1,
    });

    await expect.poll(
      () => service.getCoordinationSession(DEMO_USER_IDS.alice, created.session.id)
        .session.roundExtensionRequest?.status,
    ).toBe("pending");
    let paused = service.getCoordinationSession(DEMO_USER_IDS.alice, created.session.id);
    expect(coordinatorCalls).toBe(1);
    expect(workerCalls).toBe(1);
    expect(paused.session.needsReplan).toBe(false);
    expect(paused.events.some((event) => event.metadata.coordinatorAnnouncement === true)).toBe(false);

    await service.resolveCoordinationRoundExtension(
      DEMO_USER_IDS.alice,
      created.session.id,
      "approve",
      1,
      paused.session.version,
    );
    await expect.poll(
      () => service.getCoordinationSession(DEMO_USER_IDS.alice, created.session.id).session.status,
    ).toBe("completed");
    const completed = service.getCoordinationSession(DEMO_USER_IDS.alice, created.session.id);
    expect(workerCalls).toBe(2);
    expect(coordinatorCalls).toBe(2);
    expect(completed.events.filter((event) => event.type === "plan.replaced")).toHaveLength(1);
    expect(completed.events.at(-2)).toMatchObject({
      type: "agent.message",
      content: expect.stringContaining("本次任务已结束。"),
    });
  });

  it("keeps the coordinator paused when humans add context during a pending round request", async () => {
    let workerId = "";
    let coordinatorCalls = 0;
    const service = await makeService({
      run: async (request) => {
        if (request.agentId === workerId) {
          return { output: "The first-round contribution is complete.", threadId: null, usage: null };
        }
        coordinatorCalls += 1;
        if (coordinatorCalls <= 2) {
          return {
            output: JSON.stringify({
              decision: "continue",
              rationale: "Another specialist step would be useful.",
              steps: [{ agentId: workerId, instruction: "Continue the task." }],
            }),
            threadId: null,
            usage: null,
          };
        }
        return {
          output: JSON.stringify({
            decision: "complete",
            rationale: "The approved context is now incorporated.",
            steps: [],
          }),
          threadId: null,
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const worker = await service.createAgent(
      { name: "Round Worker", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    workerId = worker.id;
    const created = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "task",
      mode: "automatic",
      title: "Approval-gated continuation",
      objective: "Complete a bounded two-round task",
      participantAgentIds: [worker.id],
      coordinatorEnabled: true,
      maxCallsPerRound: 1,
    });

    await expect.poll(
      () => service.getCoordinationSession(DEMO_USER_IDS.alice, created.session.id)
        .session.roundExtensionRequest?.status,
    ).toBe("pending");
    expect(coordinatorCalls).toBe(2);

    const paused = await service.appendCoordinationMessage(
      DEMO_USER_IDS.alice,
      created.session.id,
      "Add this requirement after I approve the next round.",
    );
    expect(paused.session.status).toBe("waiting_for_human");
    expect(paused.session.roundExtensionRequest?.status).toBe("pending");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(coordinatorCalls).toBe(2);

    await service.resolveCoordinationRoundExtension(
      DEMO_USER_IDS.alice,
      created.session.id,
      "approve",
      1,
      paused.session.version,
    );
    await expect.poll(
      () => service.getCoordinationSession(DEMO_USER_IDS.alice, created.session.id).session.status,
    ).toBe("completed");
    expect(coordinatorCalls).toBe(3);
  });

  it("lets the group-chat coordinator choose a subset and stop the current response cycle", async () => {
    let selectedAgentId = "";
    let coordinatorCalls = 0;
    const calledAgents: string[] = [];
    const service = await makeService({
      run: async (request) => {
        if (request.agentId === selectedAgentId) {
          calledAgents.push(request.agentId);
          return { output: "Only the relevant specialist replied.", threadId: "specialist-thread", usage: null };
        }
        coordinatorCalls += 1;
        return coordinatorCalls === 1
          ? {
              output: JSON.stringify({
                decision: "continue",
                rationale: "Only the second specialist is relevant.",
                steps: [{ agentId: selectedAgentId, instruction: "Answer the latest human message." }],
              }),
              threadId: "chat-coordinator-thread",
              usage: null,
            }
          : {
              output: JSON.stringify({
                decision: "complete",
                rationale: "The current conversational response is complete.",
                steps: [],
              }),
              threadId: "chat-coordinator-thread",
              usage: null,
            };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const irrelevant = await service.createAgent(
      { name: "Irrelevant Specialist", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    const selected = await service.createAgent(
      { name: "Relevant Specialist", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    selectedAgentId = selected.id;
    const chat = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "group_chat",
      mode: "automatic",
      title: "Selective group chat",
      participantAgentIds: [irrelevant.id, selected.id],
      coordinatorEnabled: true,
    });
    await service.appendCoordinationMessage(
      DEMO_USER_IDS.alice,
      chat.session.id,
      "Ask only the relevant specialist.",
    );

    await expect.poll(
      () => service.getCoordinationSession(DEMO_USER_IDS.alice, chat.session.id).session.status,
    ).toBe("waiting_for_human");
    const completed = service.getCoordinationSession(DEMO_USER_IDS.alice, chat.session.id);
    expect(coordinatorCalls).toBe(2);
    expect(calledAgents).toEqual([selected.id]);
    expect(completed.events.filter((event) => event.type === "agent.message").map((event) => event.actorId))
      .toEqual([selected.id]);
    expect(completed.session.status).not.toBe("completed");
  });

  it("snapshots only the explicitly selected same-group chat messages into a task", async () => {
    let runtimePrompt = "";
    const service = await makeService({
      run: async (request) => {
        runtimePrompt = request.prompt;
        return { output: "used selected context", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent(
      { name: "Context Worker", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    let chat = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "group_chat",
      mode: "manual",
      title: "Import source",
      participantAgentIds: [],
    });
    chat = await service.appendCoordinationMessage(
      DEMO_USER_IDS.alice,
      chat.session.id,
      "Include this launch decision",
    );
    chat = await service.appendCoordinationMessage(
      DEMO_USER_IDS.bob,
      chat.session.id,
      "Do not include this unrelated note",
    );
    const sourceMessages = chat.events.filter((event) => event.type === "human.message");
    const task = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "task",
      mode: "manual",
      title: "Selected context task",
      objective: "Use the explicitly attached decision",
      participantAgentIds: [agent.id],
      contextImport: {
        mode: "selected",
        sourceConversationId: chat.session.conversationId,
        eventIds: [sourceMessages[0]!.id],
      },
    });

    expect(task.session.contextImport).toMatchObject({
      mode: "selected",
      sourceConversationId: chat.session.conversationId,
      messages: [{ content: "Include this launch decision" }],
    });
    const launched = await service.advanceCoordinationSession(
      DEMO_USER_IDS.alice,
      task.session.id,
      task.session.version,
    );
    await expect.poll(() => service.getRun(launched.run.id).status).toBe("completed");
    expect(runtimePrompt).toContain("[Imported Human Alice · source #");
    expect(runtimePrompt).toContain("Include this launch decision");
    expect(runtimePrompt).not.toContain("Do not include this unrelated note");

    const betaChat = await service.createCoordinationSession(DEMO_USER_IDS.bob, {
      groupId: DEMO_GROUP_IDS.beta,
      kind: "group_chat",
      mode: "manual",
      title: "Beta private chat",
      participantAgentIds: [],
    });
    await expect(
      service.createCoordinationSession(DEMO_USER_IDS.alice, {
        groupId: DEMO_GROUP_IDS.alpha,
        kind: "task",
        mode: "manual",
        title: "Cross-group import attack",
        objective: "Attempt a forbidden import",
        participantAgentIds: [agent.id],
        contextImport: {
          mode: "full",
          sourceConversationId: betaChat.session.conversationId,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Access Denied: CONTEXT_SOURCE_GROUP_MISMATCH",
    });
  });

  it("publishes an exact task artifact only after the requesting human approves it", async () => {
    let service!: AgentService;
    let publicationId = "";
    let projectPath = "";
    const runner: AgentRunner = {
      run: async (request) => {
        projectPath = request.workspacePath;
        await writeFile(path.join(projectPath, "result.md"), "approved result\n");
        const token = request.runtimeEnvironment?.LAUNCHPAD_RUNTIME_TOKEN ?? "";
        expect(await service.listSharedFilesForRuntime(token)).toEqual([]);
        const publication = await service.proposeArtifactPublicationForRuntime(token, {
          sourceRelativePath: "result.md",
          destinationRelativePath: "deliverables/result.md",
        });
        publicationId = publication.id;
        return { output: "Result is awaiting approval.", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    service = await makeService(runner);
    const agent = await service.createAgent(
      { name: "Publisher", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    const task = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "task",
      mode: "manual",
      title: "Publish reviewed result",
      objective: "Create one approved deliverable",
      participantAgentIds: [agent.id],
    });
    const launched = await service.advanceCoordinationSession(
      DEMO_USER_IDS.alice,
      task.session.id,
      task.session.version,
    );
    await expect.poll(() => service.getRun(launched.run.id).status).toBe("completed");
    expect(service.listArtifactPublications(DEMO_USER_IDS.alice)[0]).toMatchObject({
      id: publicationId,
      status: "pending",
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(
      service.reviewArtifactPublication(DEMO_USER_IDS.bob, publicationId, "approve"),
    ).rejects.toMatchObject({ statusCode: 403 });

    const approved = await service.reviewArtifactPublication(
      DEMO_USER_IDS.alice,
      publicationId,
      "approve",
    );
    expect(approved.publication.status).toBe("approved");
    expect(await readFile(path.resolve(projectPath, "..", "..", "shared", "deliverables", "result.md"), "utf8"))
      .toBe("approved result\n");
    expect(service.listDecisions(DEMO_USER_IDS.alice).map((item) => item.reasonCode))
      .toEqual(expect.arrayContaining([
        "ARTIFACT_AWAITING_HUMAN_APPROVAL",
        "SHARED_FILE_PUBLISH_APPROVED",
      ]));
  });

  it("requires a new approval if the task file changes after it was proposed", async () => {
    let service!: AgentService;
    let publicationId = "";
    let sourcePath = "";
    service = await makeService({
      run: async (request) => {
        sourcePath = path.join(request.workspacePath, "mutable.txt");
        await writeFile(sourcePath, "version one");
        const publication = await service.proposeArtifactPublicationForRuntime(
          request.runtimeEnvironment?.LAUNCHPAD_RUNTIME_TOKEN ?? "",
          { sourceRelativePath: "mutable.txt", destinationRelativePath: "mutable.txt" },
        );
        publicationId = publication.id;
        return { output: "proposal created", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent(
      { name: "Mutable Publisher", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    const task = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "task",
      mode: "manual",
      title: "Hash-bound approval",
      objective: "Propose an exact file",
      participantAgentIds: [agent.id],
    });
    const launched = await service.advanceCoordinationSession(
      DEMO_USER_IDS.alice,
      task.session.id,
      task.session.version,
    );
    await expect.poll(() => service.getRun(launched.run.id).status).toBe("completed");
    await writeFile(sourcePath, "version two");

    await expect(
      service.reviewArtifactPublication(DEMO_USER_IDS.alice, publicationId, "approve"),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "The proposed source file changed after approval was requested",
    });
    expect(service.listArtifactPublications(DEMO_USER_IDS.alice)[0]?.status).toBe("pending");
  });

  it("requires the original publisher or a group manager to overwrite a shared file", async () => {
    let service!: AgentService;
    const publicationIds: string[] = [];
    service = await makeService({
      run: async (request) => {
        const humanId = request.runtimeEnvironment?.LAUNCHPAD_INITIATING_HUMAN_ID ?? "";
        await writeFile(path.join(request.workspacePath, "shared-name.txt"), humanId);
        const publication = await service.proposeArtifactPublicationForRuntime(
          request.runtimeEnvironment?.LAUNCHPAD_RUNTIME_TOKEN ?? "",
          { sourceRelativePath: "shared-name.txt", destinationRelativePath: "shared-name.txt" },
        );
        publicationIds.push(publication.id);
        return { output: "proposed", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent(
      { name: "Shared File Agent", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    const runTask = async (humanId: string, title: string) => {
      const task = await service.createCoordinationSession(humanId, {
        groupId: DEMO_GROUP_IDS.alpha,
        kind: "task",
        mode: "manual",
        title,
        objective: "Propose the same shared destination",
        participantAgentIds: [agent.id],
      });
      const launched = await service.advanceCoordinationSession(
        humanId,
        task.session.id,
        task.session.version,
      );
      await expect.poll(() => service.getRun(launched.run.id).status).toBe("completed");
    };

    await runTask(DEMO_USER_IDS.alice, "Alice publishes first");
    await service.reviewArtifactPublication(DEMO_USER_IDS.alice, publicationIds[0]!, "approve");
    await runTask(DEMO_USER_IDS.bob, "Bob proposes overwrite");
    await expect(
      service.reviewArtifactPublication(DEMO_USER_IDS.bob, publicationIds[1]!, "approve"),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Only the shared-file owner or a group manager may overwrite it",
    });
    await expect(
      service.reviewArtifactPublication(DEMO_USER_IDS.alice, publicationIds[1]!, "approve"),
    ).resolves.toMatchObject({ publication: { status: "approved" } });
  });

  it("does not let a projectless direct-message Run propose a shared artifact", async () => {
    let service!: AgentService;
    let denial: unknown;
    service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "dm.txt"), "private draft");
        try {
          await service.proposeArtifactPublicationForRuntime(
            request.runtimeEnvironment?.LAUNCHPAD_RUNTIME_TOKEN ?? "",
            { sourceRelativePath: "dm.txt", destinationRelativePath: "dm.txt" },
          );
        } catch (error) {
          denial = error;
        }
        return { output: "kept private", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Personal Draft Agent" }, DEMO_USER_IDS.alice);
    const { run } = await service.sendMessage(agent.id, "draft without publishing", DEMO_USER_IDS.alice);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(denial).toMatchObject({ statusCode: 403 });
    expect(service.listArtifactPublications(DEMO_USER_IDS.alice)).toEqual([]);
  });

  it("rejects a task grant when the supplied task does not include the target Agent", async () => {
    const service = await makeService();
    const excludedAgent = await service.createAgent(
      { name: "Excluded Reader", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    const participant = await service.createAgent(
      { name: "Task Participant", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    const task = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "task",
      mode: "manual",
      title: "Bound grant task",
      objective: "Use only the selected Agent",
      participantAgentIds: [participant.id],
    });

    await expect(
      service.createGrant(DEMO_USER_IDS.alice, {
        agentId: excludedAgent.id,
        resourceId: DEMO_RESOURCE_IDS.alicePrivate,
        duration: "task",
        taskId: task.session.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "The task grant does not match an active same-group task for this Agent",
    });
  });

  it("revokes task-scoped private access when the task completes", async () => {
    const service = await makeService();
    const agent = await service.createAgent(
      {
        name: "Alpha Private Reader",
        scope: "group",
        groupId: DEMO_GROUP_IDS.alpha,
      },
      DEMO_USER_IDS.alice,
    );
    const snapshot = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "task",
      mode: "manual",
      title: "Temporary access task",
      objective: "Use the approved source once",
      participantAgentIds: [agent.id],
    });
    await service.createGrant(DEMO_USER_IDS.alice, {
      agentId: agent.id,
      resourceId: DEMO_RESOURCE_IDS.alicePrivate,
      duration: "task",
      taskId: snapshot.session.id,
    });

    await expect(
      service.readResourceAsAgent(
        DEMO_USER_IDS.alice,
        agent.id,
        DEMO_RESOURCE_IDS.alicePrivate,
        { taskId: snapshot.session.id },
      ),
    ).resolves.toMatchObject({ decision: { reasonCode: "TASK_SCOPED_GRANT" } });

    await service.advanceCoordinationSession(
      DEMO_USER_IDS.alice,
      snapshot.session.id,
      snapshot.session.version,
    );
    await expect.poll(
      () => service.getCoordinationSession(DEMO_USER_IDS.alice, snapshot.session.id).session.status,
    ).toBe("completed");

    await expect(
      service.readResourceAsAgent(
        DEMO_USER_IDS.alice,
        agent.id,
        DEMO_RESOURCE_IDS.alicePrivate,
        { taskId: snapshot.session.id },
      ),
    ).rejects.toMatchObject({ message: "Access Denied: PRIVATE_GRANT_REQUIRED" });
    expect(service.listDecisions(DEMO_USER_IDS.alice).map((item) => item.reasonCode))
      .toContain("TASK_COMPLETED");
  });

  it("runs independent Agents in order and injects earlier output into the later context", async () => {
    const prompts: string[] = [];
    const runtimePaths: string[] = [];
    const runtimeContexts: string[] = [];
    let call = 0;
    const service = await makeService({
      run: async (request) => {
        prompts.push(request.prompt);
        runtimePaths.push(request.workspacePath);
        runtimeContexts.push(
          await readFile(path.join(request.workspacePath, ".launchpad", "context.json"), "utf8"),
        );
        call += 1;
        return {
          output: call === 1 ? "Research handoff: validate permissions." : "Writer used the research handoff.",
          threadId: `coordination-thread-${call}`,
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const researcher = await service.createAgent(
      { name: "Researcher", role: "Researcher", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    const writer = await service.createAgent(
      { name: "Writer", role: "Writer", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    let snapshot = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "task",
      mode: "manual",
      title: "Launch brief",
      objective: "Prepare a secure launch brief",
      participantAgentIds: [researcher.id, writer.id],
    });
    expect(snapshot.steps.map((step) => step.agentId)).toEqual([researcher.id, writer.id]);

    const first = await service.advanceCoordinationSession(
      DEMO_USER_IDS.alice,
      snapshot.session.id,
      snapshot.session.version,
    );
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    snapshot = service.getCoordinationSession(DEMO_USER_IDS.alice, snapshot.session.id);
    expect(snapshot.session.status).toBe("waiting_for_human");

    const second = await service.resolveCoordinationManualAdvance(
      DEMO_USER_IDS.alice,
      snapshot.session.id,
      "approve",
      snapshot.session.version,
    );
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    snapshot = service.getCoordinationSession(DEMO_USER_IDS.alice, snapshot.session.id);
    expect(snapshot.session.status).toBe("completed");
    expect(prompts[1]).toContain("[Agent Researcher] Research handoff: validate permissions.");
    expect(prompts[0]).not.toContain("Writer used the research handoff");
    expect(runtimeContexts[0]).not.toContain("Research handoff: validate permissions.");
    expect(runtimeContexts[1]).toContain("Research handoff: validate permissions.");
    expect(runtimeContexts[1]).toContain(`"id": "${writer.id}"`);
    expect(runtimeContexts.every((context) => !context.includes("Beta Product Team"))).toBe(true);
    expect(runtimePaths[0]).toBe(runtimePaths[1]);
    expect(runtimePaths[0]).toContain(path.join("groups", DEMO_GROUP_IDS.alpha, "projects"));
    expect(researcher).not.toHaveProperty("codexThreadId");
    expect(writer).not.toHaveProperty("codexThreadId");
  });

  it("continues all planned steps without a click in automatic mode", async () => {
    const calls: string[] = [];
    const service = await makeService({
      run: async (request) => {
        calls.push(request.agentId);
        return { output: `Completed by ${request.agentId}`, threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const firstAgent = await service.createAgent(
      { name: "First", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    const secondAgent = await service.createAgent(
      { name: "Second", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    const created = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "task",
      mode: "automatic",
      title: "Automatic handoff",
      objective: "Complete both contributions",
      participantAgentIds: [firstAgent.id, secondAgent.id],
    });

    await expect.poll(
      () => service.getCoordinationSession(DEMO_USER_IDS.alice, created.session.id).session.status,
    ).toBe("completed");
    expect(calls).toEqual([firstAgent.id, secondAgent.id]);
  });

  it("keeps a human group chat usable before Agents join and lets a member request a reply", async () => {
    let initiatingHumanId = "";
    let contextAtRun = "";
    const service = await makeService({
      run: async (request) => {
        initiatingHumanId = request.runtimeEnvironment?.LAUNCHPAD_INITIATING_HUMAN_ID ?? "";
        contextAtRun = await readFile(
          path.join(request.workspacePath, ".launchpad", "context.json"),
          "utf8",
        );
        return { output: "Group Agent joined the discussion.", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    let chat = await service.createCoordinationSession(DEMO_USER_IDS.alice, {
      groupId: DEMO_GROUP_IDS.alpha,
      kind: "group_chat",
      mode: "manual",
      title: "Alpha group chat",
      participantAgentIds: [],
    });
    expect(chat.session.participantAgentIds).toEqual([]);
    expect(
      service.listGroups(DEMO_USER_IDS.alice).find((group) => group.id === DEMO_GROUP_IDS.alpha)
        ?.lastActivityAt,
    ).toBeNull();

    chat = await service.appendCoordinationMessage(
      DEMO_USER_IDS.bob,
      chat.session.id,
      "Can an Agent review this?",
    );
    expect(chat.events.find((event) => event.type === "human.message")?.actorId)
      .toBe(DEMO_USER_IDS.bob);
    expect(
      service.listGroups(DEMO_USER_IDS.alice).find((group) => group.id === DEMO_GROUP_IDS.alpha)
        ?.lastActivityAt,
    ).toBe(chat.events.find((event) => event.type === "human.message")?.createdAt);

    const agent = await service.createAgent(
      { name: "Reviewer", scope: "group", groupId: DEMO_GROUP_IDS.alpha },
      DEMO_USER_IDS.alice,
    );
    const launched = await service.advanceCoordinationSession(
      DEMO_USER_IDS.bob,
      chat.session.id,
      chat.session.version,
    );
    await expect.poll(() => service.getRun(launched.run.id).status).toBe("completed");
    expect(initiatingHumanId).toBe(DEMO_USER_IDS.bob);
    expect(contextAtRun).toContain('"username": "bob"');
    chat = service.getCoordinationSession(DEMO_USER_IDS.bob, chat.session.id);
    expect(chat.session.participantAgentIds).toContain(agent.id);
    expect(chat.events.find((event) => event.type === "agent.message")?.content)
      .toBe("Group Agent joined the discussion.");
  });
});

describe("Unified direct conversations", () => {
  it("lists human and Agent peers together and persists private human messages", async () => {
    const service = await makeService();
    const agent = await service.createAgent(
      { name: "Alice Personal Agent", scope: "personal" },
      DEMO_USER_IDS.alice,
    );
    const before = service.listDirectConversations(DEMO_USER_IDS.alice);
    expect(before).toEqual(expect.arrayContaining([
      expect.objectContaining({ peerType: "human", peerId: DEMO_USER_IDS.bob }),
      expect.objectContaining({ peerType: "agent", peerId: agent.id }),
    ]));

    await service.sendHumanDirectMessage(
      DEMO_USER_IDS.alice,
      DEMO_USER_IDS.bob,
      "Private hello to Bob",
    );
    await service.sendHumanDirectMessage(
      DEMO_USER_IDS.bob,
      DEMO_USER_IDS.alice,
      "Private reply to Alice",
    );
    expect(service.getHumanDirectMessages(DEMO_USER_IDS.alice, DEMO_USER_IDS.bob))
      .toEqual([
        expect.objectContaining({ senderUserId: DEMO_USER_IDS.alice, content: "Private hello to Bob" }),
        expect.objectContaining({ senderUserId: DEMO_USER_IDS.bob, content: "Private reply to Alice" }),
      ]);
    expect(service.getHumanDirectMessages(DEMO_USER_IDS.carol, DEMO_USER_IDS.bob)).toEqual([]);
    expect(service.listDirectConversations(DEMO_USER_IDS.alice)[0]).toMatchObject({
      peerType: "human",
      peerId: DEMO_USER_IDS.bob,
      preview: "Private reply to Alice",
    });
    await expect(
      service.sendHumanDirectMessage(DEMO_USER_IDS.alice, DEMO_USER_IDS.alice, "self"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
