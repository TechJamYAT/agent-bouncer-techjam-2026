import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationEngine } from "./coordination.js";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeEngine(): Promise<CoordinationEngine> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-coordination-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return new CoordinationEngine(store);
}

async function createTask(engine: CoordinationEngine, mode: "manual" | "automatic") {
  return engine.create({
    groupId: "group-alpha",
    conversationId: "conversation-alpha-task",
    projectId: "project-alpha-task",
    kind: "task",
    mode,
    title: "Prepare launch plan",
    objective: "Produce a reviewed launch plan",
    createdByUserId: "alice",
    participantAgentIds: ["research-agent", "writer-agent"],
  });
}

describe("Coordination state machine", () => {
  it("runs an ordered manual task and gives later Agents the earlier output", async () => {
    const engine = await makeEngine();
    let snapshot = await createTask(engine, "manual");
    snapshot = await engine.appendHumanMessage(
      snapshot.session.id,
      "alice",
      "Use the current Alpha product brief.",
    );
    snapshot = await engine.replacePlan(
      snapshot.session.id,
      null,
      [
        { agentId: "research-agent", instruction: "Collect the key facts" },
        { agentId: "writer-agent", instruction: "Write the final plan" },
      ],
      snapshot.session.version,
    );

    expect(snapshot.session.status).toBe("waiting_for_human");
    const first = await engine.startNextStep(
      snapshot.session.id,
      "human",
      snapshot.session.version,
    );
    expect(engine.contextForStep(snapshot.session.id, first.step.id).map((item) => item.content))
      .toEqual(["Use the current Alpha product brief."]);

    snapshot = await engine.completeStep(
      snapshot.session.id,
      first.step.id,
      "research-agent",
      "Research found three launch risks.",
      "run-research",
    );
    expect(snapshot.session.status).toBe("waiting_for_human");
    expect(snapshot.session.manualAdvanceRequest?.status).toBe("pending");
    snapshot = await engine.resolveManualAdvance(
      snapshot.session.id,
      "alice",
      "approve",
      snapshot.session.version,
    );

    const second = await engine.startNextStep(
      snapshot.session.id,
      "human",
      snapshot.session.version,
    );
    expect(engine.contextForStep(snapshot.session.id, second.step.id).map((item) => item.content))
      .toEqual([
        "Use the current Alpha product brief.",
        "Research found three launch risks.",
      ]);

    snapshot = await engine.completeStep(
      snapshot.session.id,
      second.step.id,
      "writer-agent",
      "Final plan covers all three risks.",
      "run-writer",
    );
    expect(snapshot.session.status).toBe("completed");
    expect(snapshot.session.callsInCurrentRound).toBe(0);
    expect(snapshot.events.find((event) => event.type === "session.completed")?.metadata)
      .toMatchObject({ executedCalls: 2 });
    expect(snapshot.events.map((event) => event.sequence)).toEqual(
      snapshot.events.map((_, index) => index + 1),
    );
    expect(
      snapshot.events
        .filter((event) => event.type === "agent.message")
        .map((event) => event.actorId),
    ).toEqual(["research-agent", "writer-agent"]);
  });

  it("forces replanning when a human adds context during an automatic step", async () => {
    const engine = await makeEngine();
    let snapshot = await createTask(engine, "automatic");
    snapshot = await engine.appendHumanMessage(snapshot.session.id, "alice", "Start the task.");
    snapshot = await engine.replacePlan(
      snapshot.session.id,
      null,
      [
        { agentId: "research-agent", instruction: "Research" },
        { agentId: "writer-agent", instruction: "Write" },
      ],
      snapshot.session.version,
    );
    const first = await engine.startNextStep(
      snapshot.session.id,
      "automatic",
      snapshot.session.version,
    );

    snapshot = await engine.appendHumanMessage(
      snapshot.session.id,
      "alice",
      "Also include a rollback plan.",
    );
    snapshot = await engine.completeStep(
      snapshot.session.id,
      first.step.id,
      "research-agent",
      "Research complete.",
    );
    expect(snapshot.session.needsReplan).toBe(true);
    await expect(
      engine.startNextStep(snapshot.session.id, "automatic", snapshot.session.version),
    ).rejects.toThrow("requires the coordinator to replan");

    snapshot = await engine.replacePlan(
      snapshot.session.id,
      null,
      [{ agentId: "writer-agent", instruction: "Write with a rollback plan" }],
      snapshot.session.version,
    );
    const replanned = await engine.startNextStep(
      snapshot.session.id,
      "automatic",
      snapshot.session.version,
    );
    expect(engine.contextForStep(snapshot.session.id, replanned.step.id).map((item) => item.content))
      .toEqual(["Start the task.", "Also include a rollback plan.", "Research complete."]);
  });

  it("atomically starts a planned step only once", async () => {
    const engine = await makeEngine();
    let snapshot = await createTask(engine, "manual");
    snapshot = await engine.appendHumanMessage(snapshot.session.id, "alice", "Begin.");
    snapshot = await engine.replacePlan(
      snapshot.session.id,
      null,
      [{ agentId: "research-agent", instruction: "Research" }],
      snapshot.session.version,
    );

    const attempts = await Promise.allSettled([
      engine.startNextStep(snapshot.session.id, "human", snapshot.session.version),
      engine.startNextStep(snapshot.session.id, "human", snapshot.session.version),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(
      engine.get(snapshot.session.id).events.filter((event) => event.type === "step.started"),
    ).toHaveLength(1);
  });

  it("pauses an interrupted step without consuming allowance and can continue it", async () => {
    const engine = await makeEngine();
    let snapshot = await engine.create({
      groupId: "group-alpha",
      conversationId: "conversation-interrupt-continue",
      projectId: "project-interrupt-continue",
      kind: "task",
      mode: "manual",
      title: "Interrupt and continue",
      objective: "Pause safely and continue with new context",
      createdByUserId: "alice",
      participantAgentIds: ["research-agent"],
      coordinatorEnabled: true,
      coordinatorAgentId: "coordinator-agent",
    });
    snapshot = await engine.appendHumanMessage(snapshot.session.id, "alice", "Begin.");
    snapshot = await engine.replacePlan(
      snapshot.session.id,
      "coordinator-agent",
      [{ agentId: "research-agent", instruction: "Research" }],
      snapshot.session.version,
    );
    const started = await engine.startNextStep(
      snapshot.session.id,
      "human",
      snapshot.session.version,
    );
    snapshot = await engine.requestInterruption(
      snapshot.session.id,
      "alice",
      started.snapshot.session.version,
    );
    expect(snapshot.session.interruption?.status).toBe("cancelling");

    snapshot = await engine.finishInterruption(snapshot.session.id, started.step.id);
    expect(snapshot.session).toMatchObject({
      status: "waiting_for_human",
      callsInCurrentRound: 0,
      activeStepId: null,
      interruption: { status: "paused" },
    });
    expect(snapshot.steps.find((step) => step.id === started.step.id)?.status).toBe("cancelled");

    snapshot = await engine.appendHumanMessage(
      snapshot.session.id,
      "alice",
      "Use this additional requirement when continuing.",
    );
    expect(snapshot.session.status).toBe("waiting_for_human");
    snapshot = await engine.resolveInterruption(
      snapshot.session.id,
      "alice",
      "continue",
      snapshot.session.version,
    );
    expect(snapshot.session).toMatchObject({
      currentRound: 1,
      callsInCurrentRound: 0,
      needsReplan: true,
      interruption: { status: "continued" },
    });
    expect(snapshot.steps.find((step) => step.id === started.step.id)?.status).toBe("pending");
  });

  it("cancels the interrupted plan and resets allowance when opening a new round", async () => {
    const engine = await makeEngine();
    let snapshot = await createTask(engine, "manual");
    snapshot = await engine.appendHumanMessage(snapshot.session.id, "alice", "Begin.");
    snapshot = await engine.replacePlan(
      snapshot.session.id,
      null,
      [
        { agentId: "research-agent", instruction: "Research" },
        { agentId: "writer-agent", instruction: "Write" },
      ],
      snapshot.session.version,
    );
    const started = await engine.startNextStep(
      snapshot.session.id,
      "human",
      snapshot.session.version,
    );
    snapshot = await engine.requestInterruption(
      snapshot.session.id,
      "alice",
      started.snapshot.session.version,
    );
    snapshot = await engine.finishInterruption(snapshot.session.id, started.step.id);
    snapshot = await engine.resolveInterruption(
      snapshot.session.id,
      "alice",
      "new_round",
      snapshot.session.version,
    );

    expect(snapshot.session).toMatchObject({
      currentRound: 2,
      callsInCurrentRound: 0,
      needsReplan: true,
      interruption: { status: "new_round" },
    });
    expect(snapshot.steps.filter((step) => step.planVersion === 1).map((step) => step.status))
      .toEqual(["cancelled", "cancelled"]);
    expect(snapshot.events.some((event) => event.type === "round.restarted")).toBe(true);
  });

  it("counts actual Agent calls and requires manual approval after every completed step", async () => {
    const engine = await makeEngine();
    let snapshot = await engine.create({
      groupId: "group-alpha",
      conversationId: "conversation-call-allowance",
      projectId: "project-call-allowance",
      kind: "task",
      mode: "manual",
      title: "Bounded execution",
      objective: "Execute an ordered plan with human checkpoints",
      createdByUserId: "alice",
      participantAgentIds: ["research-agent", "writer-agent"],
      maxCallsPerRound: 2,
    });
    snapshot = await engine.appendHumanMessage(snapshot.session.id, "alice", "Begin.");
    snapshot = await engine.replacePlan(
      snapshot.session.id,
      null,
      [
        { agentId: "research-agent", instruction: "Research" },
        { agentId: "writer-agent", instruction: "Write" },
        { agentId: "research-agent", instruction: "Review" },
      ],
      snapshot.session.version,
    );

    const first = await engine.startNextStep(snapshot.session.id, "human", snapshot.session.version);
    snapshot = await engine.completeStep(snapshot.session.id, first.step.id, first.step.agentId, "Research done.");
    expect(snapshot.session.callsInCurrentRound).toBe(1);
    expect(snapshot.session.manualAdvanceRequest?.status).toBe("pending");

    snapshot = await engine.appendHumanMessage(snapshot.session.id, "bob", "Also cover rollback.");
    expect(snapshot.session.manualAdvanceRequest?.status).toBe("pending");
    snapshot = await engine.resolveManualAdvance(snapshot.session.id, "alice", "approve", snapshot.session.version);
    expect(snapshot.session.needsReplan).toBe(true);
    expect(snapshot.events.some((event) => event.type === "manual_advance.resolved")).toBe(true);
    snapshot = await engine.replacePlan(
      snapshot.session.id,
      null,
      [
        { agentId: "writer-agent", instruction: "Write with rollback" },
        { agentId: "research-agent", instruction: "Review" },
      ],
      snapshot.session.version,
    );
    const second = await engine.startNextStep(snapshot.session.id, "human", snapshot.session.version);
    snapshot = await engine.completeStep(snapshot.session.id, second.step.id, second.step.agentId, "Draft done.");
    expect(snapshot.session.callsInCurrentRound).toBe(2);
    expect(snapshot.session.needsReplan).toBe(false);
    expect(snapshot.session.manualAdvanceRequest?.status).not.toBe("pending");
    expect(snapshot.session.roundExtensionRequest).toMatchObject({
      status: "pending",
      requestedAdditionalRounds: 1,
    });
  });

  it("continues the original plan after a round approval when nobody interjects", async () => {
    const engine = await makeEngine();
    let snapshot = await engine.create({
      groupId: "group-alpha",
      conversationId: "conversation-resume-plan",
      projectId: "project-resume-plan",
      kind: "task",
      mode: "automatic",
      title: "Resume the original plan",
      objective: "Complete both originally scheduled steps",
      createdByUserId: "alice",
      participantAgentIds: ["research-agent", "writer-agent"],
      coordinatorEnabled: true,
      coordinatorAgentId: "coordinator-agent",
      maxCallsPerRound: 1,
    });
    snapshot = await engine.appendHumanMessage(snapshot.session.id, "alice", "Begin.");
    snapshot = await engine.replacePlan(
      snapshot.session.id,
      "coordinator-agent",
      [
        { agentId: "research-agent", instruction: "Research" },
        { agentId: "writer-agent", instruction: "Write" },
      ],
      snapshot.session.version,
    );
    const originalPlanVersion = snapshot.session.planVersion;
    const first = await engine.startNextStep(
      snapshot.session.id,
      "automatic",
      snapshot.session.version,
    );
    snapshot = await engine.completeStep(
      snapshot.session.id,
      first.step.id,
      first.step.agentId,
      "Research done.",
    );

    expect(snapshot.session).toMatchObject({
      status: "waiting_for_human",
      needsReplan: false,
      callsInCurrentRound: 1,
      roundExtensionRequest: { status: "pending" },
    });
    expect(snapshot.events.filter((event) => event.type === "coordinator.decision")).toHaveLength(0);

    snapshot = await engine.resolveRoundExtension(
      snapshot.session.id,
      "alice",
      "approve",
      1,
      snapshot.session.version,
    );
    expect(snapshot.session).toMatchObject({
      currentRound: 2,
      callsInCurrentRound: 0,
      planVersion: originalPlanVersion,
      needsReplan: false,
    });
    expect(snapshot.events.at(-1)?.metadata).toMatchObject({ resumedOriginalPlan: true });

    const second = await engine.startNextStep(
      snapshot.session.id,
      "automatic",
      snapshot.session.version,
    );
    expect(second.step.agentId).toBe("writer-agent");
    snapshot = await engine.completeStep(
      snapshot.session.id,
      second.step.id,
      second.step.agentId,
      "Writing done.",
    );
    expect(snapshot.session.needsReplan).toBe(true);
    expect(snapshot.session.status).toBe("active");
  });

  it("replans after round approval when a human interjects during the quota pause", async () => {
    const engine = await makeEngine();
    let snapshot = await engine.create({
      groupId: "group-alpha",
      conversationId: "conversation-replan-after-interjection",
      projectId: "project-replan-after-interjection",
      kind: "task",
      mode: "automatic",
      title: "Replan after interjection",
      objective: "Incorporate late context",
      createdByUserId: "alice",
      participantAgentIds: ["research-agent", "writer-agent"],
      coordinatorEnabled: true,
      coordinatorAgentId: "coordinator-agent",
      maxCallsPerRound: 1,
    });
    snapshot = await engine.appendHumanMessage(snapshot.session.id, "alice", "Begin.");
    snapshot = await engine.replacePlan(
      snapshot.session.id,
      "coordinator-agent",
      [
        { agentId: "research-agent", instruction: "Research" },
        { agentId: "writer-agent", instruction: "Write" },
      ],
      snapshot.session.version,
    );
    const first = await engine.startNextStep(
      snapshot.session.id,
      "automatic",
      snapshot.session.version,
    );
    snapshot = await engine.completeStep(
      snapshot.session.id,
      first.step.id,
      first.step.agentId,
      "Research done.",
    );
    snapshot = await engine.appendHumanMessage(
      snapshot.session.id,
      "alice",
      "Change the requested output before continuing.",
    );
    snapshot = await engine.resolveRoundExtension(
      snapshot.session.id,
      "alice",
      "approve",
      1,
      snapshot.session.version,
    );

    expect(snapshot.session.needsReplan).toBe(true);
    expect(snapshot.events.at(-1)?.metadata).toMatchObject({ resumedOriginalPlan: false });
    await expect(
      engine.startNextStep(snapshot.session.id, "automatic", snapshot.session.version),
    ).rejects.toThrow("requires the coordinator to replan");
  });

  it("waits for a coordinator decision after each enabled task round", async () => {
    const engine = await makeEngine();
    let snapshot = await engine.create({
      groupId: "group-alpha",
      conversationId: "conversation-coordinated-task",
      projectId: "project-coordinated-task",
      kind: "task",
      mode: "automatic",
      title: "Coordinated task",
      objective: "Produce a complete result",
      createdByUserId: "alice",
      participantAgentIds: ["research-agent"],
      coordinatorEnabled: true,
      coordinatorAgentId: "coordinator-agent",
      maxRounds: 6,
    });
    snapshot = await engine.appendHumanMessage(snapshot.session.id, "alice", "Begin.");
    snapshot = await engine.replacePlan(
      snapshot.session.id,
      "coordinator-agent",
      [{ agentId: "research-agent", instruction: "Research" }],
      snapshot.session.version,
      "Research is required first.",
    );
    const started = await engine.startNextStep(
      snapshot.session.id,
      "automatic",
      snapshot.session.version,
    );
    snapshot = await engine.completeStep(
      snapshot.session.id,
      started.step.id,
      "research-agent",
      "Research complete.",
    );
    expect(snapshot.session.status).toBe("active");
    expect(snapshot.session.needsReplan).toBe(true);
    expect(snapshot.events.some((event) => event.type === "round.completed")).toBe(true);

    snapshot = await engine.completeByCoordinator(
      snapshot.session.id,
      "coordinator-agent",
      "The objective is satisfied.",
      snapshot.session.version,
    );
    expect(snapshot.session.status).toBe("completed");
    expect(snapshot.session.callsInCurrentRound).toBe(0);
    expect(snapshot.events.find((event) => event.type === "session.completed")?.metadata)
      .toMatchObject({ executedCalls: 1, decidedByCoordinator: true });
    expect(snapshot.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "coordinator.decision",
          content: "The objective is satisfied.",
        }),
      ]),
    );
  });

  it("requires the task initiator to resolve a coordinator round extension request", async () => {
    const engine = await makeEngine();
    let snapshot = await engine.create({
      groupId: "group-alpha",
      conversationId: "conversation-round-extension",
      projectId: "project-round-extension",
      kind: "task",
      mode: "automatic",
      title: "Bounded task",
      objective: "Finish within a user-approved budget",
      createdByUserId: "alice",
      participantAgentIds: ["research-agent"],
      coordinatorEnabled: true,
      coordinatorAgentId: "coordinator-agent",
      maxRounds: 2,
    });
    snapshot = await engine.requestRoundExtension(
      snapshot.session.id,
      "coordinator-agent",
      "The objective is incomplete and needs two focused rounds.",
      2,
      snapshot.session.version,
    );
    expect(snapshot.session.status).toBe("waiting_for_human");
    expect(snapshot.session.roundExtensionRequest).toMatchObject({
      requestedAdditionalRounds: 1,
      status: "pending",
    });
    expect(snapshot.events.at(-1)?.type).toBe("round_extension.requested");

    snapshot = await engine.appendHumanMessage(
      snapshot.session.id,
      "alice",
      "Use this only after the extra round is approved.",
    );
    expect(snapshot.session.status).toBe("waiting_for_human");
    expect(snapshot.session.needsReplan).toBe(true);
    expect(snapshot.session.roundExtensionRequest?.status).toBe("pending");
    expect(snapshot.events.at(-1)).toMatchObject({
      type: "human.message",
      content: "Use this only after the extra round is approved.",
    });
    await expect(
      engine.replacePlan(
        snapshot.session.id,
        "coordinator-agent",
        [{ agentId: "research-agent", instruction: "React before approval" }],
        snapshot.session.version,
      ),
    ).rejects.toThrow("approve the round extension");

    snapshot = await engine.resolveRoundExtension(
      snapshot.session.id,
      "alice",
      "approve",
      1,
      snapshot.session.version,
    );
    expect(snapshot.session.currentRound).toBe(2);
    expect(snapshot.session.callsInCurrentRound).toBe(0);
    expect(snapshot.session.status).toBe("active");
    expect(snapshot.session.needsReplan).toBe(true);
    expect(snapshot.session.roundExtensionRequest).toMatchObject({
      status: "approved",
      approvedAdditionalRounds: 1,
      resolvedByUserId: "alice",
    });
    expect(snapshot.events.at(-1)?.type).toBe("round_extension.resolved");
  });

  it("records failure, retry, and stop transitions", async () => {
    const engine = await makeEngine();
    let snapshot = await createTask(engine, "manual");
    snapshot = await engine.appendHumanMessage(snapshot.session.id, "alice", "Begin.");
    snapshot = await engine.replacePlan(
      snapshot.session.id,
      null,
      [{ agentId: "research-agent", instruction: "Research" }],
      snapshot.session.version,
    );
    const first = await engine.startNextStep(
      snapshot.session.id,
      "human",
      snapshot.session.version,
    );
    snapshot = await engine.failStep(snapshot.session.id, first.step.id, "Agent timed out");
    expect(snapshot.session.status).toBe("failed");
    snapshot = await engine.retryStep(
      snapshot.session.id,
      first.step.id,
      "alice",
      snapshot.session.version,
    );
    const retry = await engine.startNextStep(
      snapshot.session.id,
      "human",
      snapshot.session.version,
    );
    expect(retry.step.attempt).toBe(2);
    snapshot = await engine.stop(snapshot.session.id, "alice");
    expect(snapshot.session.status).toBe("stopped");
    expect(snapshot.steps.find((step) => step.id === first.step.id)?.status).toBe("cancelled");
    expect(snapshot.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["step.failed", "step.retry_scheduled", "session.stopped"]),
    );
  });
});
