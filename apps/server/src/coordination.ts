import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  CoordinationActorType,
  CoordinationContextImport,
  CoordinationEvent,
  CoordinationEventType,
  CoordinationKind,
  CoordinationMode,
  CoordinationSession,
  CoordinationStep,
  Database,
  MiddlewareEvidenceRequirement,
} from "./types.js";

const now = () => new Date().toISOString();

const terminalStatuses = new Set<CoordinationSession["status"]>([
  "completed",
  "stopped",
]);

export interface CreateCoordinationSessionInput {
  groupId: string;
  conversationId: string;
  projectId: string | null;
  kind: CoordinationKind;
  mode: CoordinationMode;
  title: string;
  objective?: string | undefined;
  createdByUserId: string;
  participantAgentIds: string[];
  coordinatorEnabled?: boolean | undefined;
  coordinatorAgentId?: string | null | undefined;
  maxRounds?: number | undefined;
  maxCallsPerRound?: number | undefined;
  middlewareEvidenceRequirements?: MiddlewareEvidenceRequirement[] | undefined;
  contextImport?: CoordinationContextImport | null | undefined;
}

export interface PlannedCoordinationStep {
  agentId: string;
  instruction: string;
}

export interface CoordinationSnapshot {
  session: CoordinationSession;
  steps: CoordinationStep[];
  events: CoordinationEvent[];
}

export interface CoordinationContextMessage {
  sequence: number;
  actorType: "human" | "agent";
  actorId: string | null;
  content: string;
}

interface AppendEventInput {
  type: CoordinationEventType;
  actorType: CoordinationActorType;
  actorId?: string | null | undefined;
  stepId?: string | null | undefined;
  content?: string | null | undefined;
  metadata?: Record<string, string | number | boolean | null> | undefined;
  timestamp?: string | undefined;
}

function requireSession(database: Database, sessionId: string): CoordinationSession {
  const session = database.coordinationSessions.find((item) => item.id === sessionId);
  if (!session) throw new HttpError(404, "Coordination session not found");
  return session;
}

function requireStep(database: Database, sessionId: string, stepId: string): CoordinationStep {
  const step = database.coordinationSteps.find(
    (item) => item.id === stepId && item.sessionId === sessionId,
  );
  if (!step) throw new HttpError(404, "Coordination step not found");
  return step;
}

function requireMutable(session: CoordinationSession): void {
  if (terminalStatuses.has(session.status)) {
    throw new HttpError(409, `Coordination session is ${session.status}`);
  }
}

function requireVersion(session: CoordinationSession, expectedVersion: number): void {
  if (session.version !== expectedVersion) {
    throw new HttpError(
      409,
      `Coordination session changed from version ${expectedVersion} to ${session.version}; refresh and retry`,
    );
  }
}

function roundApprovalBlocksExecution(session: CoordinationSession): boolean {
  const requestStatus = session.roundExtensionRequest?.status;
  return requestStatus === "pending" || (
    requestStatus === "rejected" &&
    session.callsInCurrentRound >= session.maxCallsPerRound
  );
}

function interruptionBlocksExecution(session: CoordinationSession): boolean {
  return session.interruption?.status === "cancelling" ||
    session.interruption?.status === "paused";
}

function createRoundExtensionRequest(
  database: Database,
  session: CoordinationSession,
  coordinatorAgentId: string | null,
  rationale: string,
  preserveCurrentPlan: boolean,
  timestamp: string,
): void {
  session.roundExtensionRequest = {
    id: randomUUID(),
    requestedAdditionalRounds: 1,
    rationale: rationale.slice(0, 2_000),
    contextThroughSequence: session.lastEventSequence,
    status: "pending",
    requestedAt: timestamp,
    resolvedAt: null,
    resolvedByUserId: null,
    approvedAdditionalRounds: null,
  };
  session.needsReplan = !preserveCurrentPlan;
  session.status = "waiting_for_human";
  appendEvent(database, session, {
    type: "round_extension.requested",
    actorType: coordinatorAgentId ? "coordinator" : "system",
    actorId: coordinatorAgentId,
    content: session.roundExtensionRequest.rationale,
    metadata: {
      requestedAdditionalRounds: 1,
      currentRound: session.currentRound,
      callsInCurrentRound: session.callsInCurrentRound,
      maxCallsPerRound: session.maxCallsPerRound,
      preserveCurrentPlan,
    },
    timestamp,
  });
}

function appendEvent(
  database: Database,
  session: CoordinationSession,
  input: AppendEventInput,
): CoordinationEvent {
  session.lastEventSequence += 1;
  const event: CoordinationEvent = {
    id: randomUUID(),
    sessionId: session.id,
    sequence: session.lastEventSequence,
    type: input.type,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    stepId: input.stepId ?? null,
    content: input.content ?? null,
    metadata: input.metadata ?? {},
    createdAt: input.timestamp ?? now(),
  };
  database.coordinationEvents.push(event);
  return event;
}

function touch(session: CoordinationSession, timestamp = now()): void {
  session.version += 1;
  session.updatedAt = timestamp;
}

function pauseInterruptedStep(
  database: Database,
  session: CoordinationSession,
  step: CoordinationStep,
  timestamp: string,
): void {
  const interruption = session.interruption;
  if (
    !interruption ||
    interruption.status !== "cancelling" ||
    interruption.stepId !== step.id
  ) {
    throw new HttpError(409, "No interruption is pending for this coordination step");
  }
  step.status = "cancelled";
  step.error = null;
  step.completedAt = timestamp;
  session.activeStepId = null;
  session.status = "waiting_for_human";
  session.manualAdvanceRequest = null;
  interruption.status = "paused";
  interruption.interruptedAt = timestamp;
  appendEvent(database, session, {
    type: "round.interrupted",
    actorType: "human",
    actorId: interruption.requestedByUserId,
    stepId: step.id,
    content: "当前 Agent 调用已中断，等待发起者选择继续当前轮次或新开一轮。",
    metadata: {
      round: session.currentRound,
      callsInCurrentRound: session.callsInCurrentRound,
      agentId: step.agentId,
    },
    timestamp,
  });
}

function orderedSteps(database: Database, sessionId: string): CoordinationStep[] {
  return database.coordinationSteps
    .filter((step) => step.sessionId === sessionId)
    .sort(
      (left, right) =>
        left.planVersion - right.planVersion || left.position - right.position,
    );
}

export class CoordinationEngine {
  constructor(private readonly store: JsonStore) {}

  async create(input: CreateCoordinationSessionInput): Promise<CoordinationSnapshot> {
    const timestamp = now();
    const session: CoordinationSession = {
      id: randomUUID(),
      groupId: input.groupId,
      conversationId: input.conversationId,
      projectId: input.projectId,
      kind: input.kind,
      mode: input.mode,
      title: input.title.trim(),
      objective: input.objective?.trim() || null,
      middlewareEvidenceRequirements: structuredClone(
        input.middlewareEvidenceRequirements ?? [],
      ),
      createdByUserId: input.createdByUserId,
      controllerUserId: input.createdByUserId,
      participantAgentIds: [...new Set(input.participantAgentIds)],
      coordinatorEnabled: input.coordinatorEnabled === true,
      coordinatorAgentId: input.coordinatorAgentId ?? null,
      maxRounds: Math.max(1, Math.min(50, input.maxRounds ?? 6)),
      maxCallsPerRound: Math.max(1, Math.min(50, input.maxCallsPerRound ?? 4)),
      currentRound: 1,
      callsInCurrentRound: 0,
      roundExtensionRequest: null,
      manualAdvanceRequest: null,
      interruption: null,
      contextImport: input.contextImport ?? null,
      status: "active",
      version: 1,
      lastEventSequence: 0,
      planVersion: 0,
      needsReplan: true,
      activeStepId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    await this.store.mutate((database) => {
      database.coordinationSessions.push(session);
      appendEvent(database, session, {
        type: "session.created",
        actorType: "human",
        actorId: input.createdByUserId,
        metadata: {
          kind: input.kind,
          mode: input.mode,
          participantCount: session.participantAgentIds.length,
          coordinatorEnabled: session.coordinatorEnabled,
          coordinatorAgentId: session.coordinatorAgentId,
          maxRounds: session.maxRounds,
          maxCallsPerRound: session.maxCallsPerRound,
          contextImportMode: session.contextImport?.mode ?? "none",
          contextMessageCount: session.contextImport?.messages.length ?? 0,
        },
        timestamp,
      });
    });
    return this.get(session.id);
  }

  list(groupId: string): CoordinationSession[] {
    return this.store
      .snapshot()
      .coordinationSessions.filter((session) => session.groupId === groupId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(sessionId: string): CoordinationSnapshot {
    const database = this.store.snapshot();
    const session = requireSession(database, sessionId);
    return {
      session,
      steps: orderedSteps(database, sessionId),
      events: database.coordinationEvents
        .filter((event) => event.sessionId === sessionId)
        .sort((left, right) => left.sequence - right.sequence),
    };
  }

  contextForStep(sessionId: string, stepId: string): CoordinationContextMessage[] {
    const database = this.store.snapshot();
    const step = requireStep(database, sessionId, stepId);
    if (step.contextThroughSequence === null) {
      throw new HttpError(409, "The step has not started and has no context snapshot");
    }
    return database.coordinationEvents
      .filter(
        (event) =>
          event.sessionId === sessionId &&
          event.sequence <= step.contextThroughSequence! &&
          (event.type === "human.message" || event.type === "agent.message") &&
          event.content !== null,
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map((event) => ({
        sequence: event.sequence,
        actorType: event.actorType as "human" | "agent",
        actorId: event.actorId,
        content: event.content!,
      }));
  }

  async setMode(
    sessionId: string,
    mode: CoordinationMode,
    actorId: string,
    expectedVersion: number,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      requireVersion(session, expectedVersion);
      if (session.mode === mode) return;
      session.mode = mode;
      if (
        session.status === "waiting_for_human" &&
        mode === "automatic" &&
        !roundApprovalBlocksExecution(session) &&
        !interruptionBlocksExecution(session)
      ) {
        session.status = "active";
      } else if (session.status === "active" && mode === "manual") {
        session.status = "waiting_for_human";
      }
      if (mode === "manual" && session.coordinatorEnabled) {
        // A manual advance authorizes a fresh coordinator evaluation, not a
        // direct jump into a step left over from an automatic plan.
        session.needsReplan = true;
      }
      appendEvent(database, session, {
        type: "mode.changed",
        actorType: "human",
        actorId,
        metadata: { mode },
      });
      touch(session);
    });
    return this.get(sessionId);
  }

  async setCallAllowance(
    sessionId: string,
    maxCallsPerRound: number,
    actorId: string,
    expectedVersion: number,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      requireVersion(session, expectedVersion);
      if (session.activeStepId !== null) {
        throw new HttpError(409, "Cannot change the call allowance while an Agent is running");
      }
      if (
        session.manualAdvanceRequest?.status === "pending" ||
        session.roundExtensionRequest?.status === "pending"
      ) {
        throw new HttpError(409, "Resolve the pending permission request before changing the allowance");
      }
      const nextAllowance = Math.max(1, Math.min(50, Math.trunc(maxCallsPerRound)));
      if (session.maxCallsPerRound === nextAllowance) return;
      session.maxCallsPerRound = nextAllowance;
      appendEvent(database, session, {
        type: "allowance.changed",
        actorType: "human",
        actorId,
        metadata: {
          maxCallsPerRound: nextAllowance,
          callsInCurrentRound: session.callsInCurrentRound,
        },
      });
      touch(session);
    });
    return this.get(sessionId);
  }

  async setCoordinatorEnabled(
    sessionId: string,
    enabled: boolean,
    coordinatorAgentId: string,
    actorId: string,
    expectedVersion?: number | undefined,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      if (expectedVersion !== undefined) requireVersion(session, expectedVersion);
      if (session.activeStepId !== null) {
        throw new HttpError(409, "Cannot change the coordinator while an Agent is running");
      }
      if (roundApprovalBlocksExecution(session)) {
        throw new HttpError(409, "Resolve and approve the round extension before changing the coordinator");
      }
      if (
        session.coordinatorEnabled === enabled &&
        session.coordinatorAgentId === coordinatorAgentId
      ) return;
      const timestamp = now();
      for (const step of database.coordinationSteps) {
        if (step.sessionId === sessionId && step.status === "pending") {
          step.status = "cancelled";
          step.completedAt = timestamp;
        }
      }
      session.coordinatorEnabled = enabled;
      session.coordinatorAgentId = coordinatorAgentId;
      session.needsReplan = true;
      session.status = session.mode === "manual" ? "waiting_for_human" : "active";
      appendEvent(database, session, {
        type: enabled ? "coordinator.enabled" : "coordinator.disabled",
        actorType: "human",
        actorId,
        metadata: { coordinatorAgentId },
        timestamp,
      });
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async appendHumanMessage(
    sessionId: string,
    humanId: string,
    content: string,
  ): Promise<CoordinationSnapshot> {
    const trimmed = content.trim();
    if (!trimmed) throw new HttpError(400, "Message content is required");
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      const hasHumanMessage = database.coordinationEvents.some(
        (event) => event.sessionId === session.id && event.type === "human.message",
      );
      const responseAlreadyInProgress = hasHumanMessage && (
        session.status === "running" ||
        session.needsReplan ||
        session.manualAdvanceRequest?.status === "pending" ||
        database.coordinationSteps.some(
          (step) =>
            step.sessionId === session.id &&
            step.planVersion === session.planVersion &&
            step.status === "pending",
        )
      );
      appendEvent(database, session, {
        type: "human.message",
        actorType: "human",
        actorId: humanId,
        content: trimmed,
      });
      if (session.kind === "group_chat" && !responseAlreadyInProgress) {
        session.controllerUserId = humanId;
      }
      session.needsReplan = true;
      if (session.status !== "running") {
        session.status = roundApprovalBlocksExecution(session) || interruptionBlocksExecution(session)
          ? "waiting_for_human"
          : "active";
      }
      touch(session);
    });
    return this.get(sessionId);
  }

  async replacePlan(
    sessionId: string,
    coordinatorAgentId: string | null,
    plannedSteps: PlannedCoordinationStep[],
    expectedVersion: number,
    rationale?: string | undefined,
  ): Promise<CoordinationSnapshot> {
    if (plannedSteps.length === 0) {
      throw new HttpError(400, "A coordination plan requires at least one step");
    }
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      requireVersion(session, expectedVersion);
      if (session.activeStepId !== null) {
        throw new HttpError(409, "Cannot replace a plan while a step is running");
      }
      if (roundApprovalBlocksExecution(session)) {
        throw new HttpError(409, "Resolve and approve the round extension before replanning");
      }
      for (const planned of plannedSteps) {
        if (!session.participantAgentIds.includes(planned.agentId)) {
          if (session.kind === "group_chat") {
            session.participantAgentIds.push(planned.agentId);
          } else {
            throw new HttpError(403, "Planned Agent is not a participant in this session");
          }
        }
        if (!planned.instruction.trim()) {
          throw new HttpError(400, "Every coordination step requires an instruction");
        }
      }
      const timestamp = now();
      for (const existing of database.coordinationSteps) {
        if (existing.sessionId === sessionId && existing.status === "pending") {
          existing.status = "cancelled";
          existing.completedAt = timestamp;
        }
      }
      session.planVersion += 1;
      appendEvent(database, session, {
        type: "plan.replaced",
        actorType: "coordinator",
        actorId: coordinatorAgentId,
        metadata: {
          planVersion: session.planVersion,
          stepCount: plannedSteps.length,
          contextThroughSequence: session.lastEventSequence,
          rationale: rationale?.slice(0, 2_000) ?? "",
        },
        timestamp,
      });
      plannedSteps.forEach((planned, index) => {
        const step: CoordinationStep = {
          id: randomUUID(),
          sessionId,
          planVersion: session.planVersion,
          position: index + 1,
          agentId: planned.agentId,
          instruction: planned.instruction.trim(),
          status: "pending",
          attempt: 0,
          contextThroughSequence: null,
          runId: null,
          outputEventId: null,
          error: null,
          createdAt: timestamp,
          startedAt: null,
          completedAt: null,
        };
        database.coordinationSteps.push(step);
        appendEvent(database, session, {
          type: "step.queued",
          actorType: "coordinator",
          actorId: coordinatorAgentId,
          stepId: step.id,
          metadata: {
            planVersion: step.planVersion,
            position: step.position,
            agentId: step.agentId,
          },
          timestamp,
        });
      });
      session.needsReplan = false;
      session.status = session.mode === "manual" ? "waiting_for_human" : "active";
      session.completedAt = null;
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async startNextStep(
    sessionId: string,
    trigger: "human" | "automatic",
    expectedVersion: number,
  ): Promise<{ snapshot: CoordinationSnapshot; step: CoordinationStep }> {
    let startedStepId = "";
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      requireVersion(session, expectedVersion);
      if (session.activeStepId !== null) {
        throw new HttpError(409, "A coordination step is already running");
      }
      if (session.manualAdvanceRequest?.status === "pending") {
        throw new HttpError(409, "The next manual step requires approval");
      }
      if (interruptionBlocksExecution(session)) {
        throw new HttpError(409, "Resolve the interrupted round before starting another Agent");
      }
      if (roundApprovalBlocksExecution(session)) {
        throw new HttpError(409, "The next execution round requires approval");
      }
      if (session.callsInCurrentRound >= session.maxCallsPerRound) {
        throw new HttpError(409, "The current execution round has reached its Agent-call allowance");
      }
      if (session.needsReplan) {
        throw new HttpError(409, "New human context requires the coordinator to replan");
      }
      if (session.mode === "manual" && trigger !== "human") {
        throw new HttpError(409, "Manual mode requires a human advance action");
      }
      if (session.mode === "automatic" && trigger !== "automatic") {
        throw new HttpError(409, "Automatic mode advances through the scheduler");
      }
      const next = database.coordinationSteps
        .filter(
          (step) =>
            step.sessionId === sessionId &&
            step.planVersion === session.planVersion &&
            step.status === "pending",
        )
        .sort((left, right) => left.position - right.position)[0];
      if (!next) throw new HttpError(409, "No pending coordination step is available");
      const timestamp = now();
      next.status = "running";
      next.attempt += 1;
      next.contextThroughSequence = session.lastEventSequence;
      next.startedAt = timestamp;
      next.completedAt = null;
      next.error = null;
      session.activeStepId = next.id;
      session.status = "running";
      appendEvent(database, session, {
        type: "step.started",
        actorType: "system",
        stepId: next.id,
        metadata: {
          agentId: next.agentId,
          attempt: next.attempt,
          contextThroughSequence: next.contextThroughSequence,
          trigger,
        },
        timestamp,
      });
      touch(session, timestamp);
      startedStepId = next.id;
    });
    const snapshot = this.get(sessionId);
    const step = snapshot.steps.find((item) => item.id === startedStepId);
    if (!step) throw new Error("Started coordination step disappeared");
    return { snapshot, step };
  }

  async requestInterruption(
    sessionId: string,
    humanId: string,
    expectedVersion: number,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      requireVersion(session, expectedVersion);
      if (session.status !== "running" || session.activeStepId === null) {
        throw new HttpError(409, "Only a running coordination round can be interrupted");
      }
      if (interruptionBlocksExecution(session)) {
        throw new HttpError(409, "This coordination round is already being interrupted");
      }
      const timestamp = now();
      session.interruption = {
        id: randomUUID(),
        stepId: session.activeStepId,
        requestedByUserId: humanId,
        status: "cancelling",
        requestedAt: timestamp,
        interruptedAt: null,
        resolvedAt: null,
        resolvedByUserId: null,
      };
      appendEvent(database, session, {
        type: "round.interrupt_requested",
        actorType: "human",
        actorId: humanId,
        stepId: session.activeStepId,
        content: "发起者请求中断当前 Agent 调用。",
        metadata: { round: session.currentRound },
        timestamp,
      });
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async finishInterruption(
    sessionId: string,
    stepId: string,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      const step = requireStep(database, sessionId, stepId);
      if (session.activeStepId !== step.id || step.status !== "running") {
        throw new HttpError(409, "The interrupted step is no longer running");
      }
      const timestamp = now();
      pauseInterruptedStep(database, session, step, timestamp);
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async resolveInterruption(
    sessionId: string,
    humanId: string,
    action: "continue" | "new_round",
    expectedVersion: number,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      requireVersion(session, expectedVersion);
      const interruption = session.interruption;
      if (!interruption || interruption.status !== "paused") {
        throw new HttpError(409, "No interrupted round is waiting to be resumed");
      }
      const timestamp = now();
      const interruptedStep = requireStep(database, sessionId, interruption.stepId);
      if (action === "continue") {
        if (interruptedStep.status !== "cancelled") {
          throw new HttpError(409, "The interrupted step cannot be continued");
        }
        interruptedStep.status = "pending";
        interruptedStep.error = null;
        interruptedStep.contextThroughSequence = null;
        interruptedStep.startedAt = null;
        interruptedStep.completedAt = null;
        session.needsReplan = session.needsReplan || session.coordinatorEnabled;
        interruption.status = "continued";
        appendEvent(database, session, {
          type: "round.resumed",
          actorType: "human",
          actorId: humanId,
          stepId: interruptedStep.id,
          content: "发起者选择继续当前轮次。",
          metadata: {
            round: session.currentRound,
            callsInCurrentRound: session.callsInCurrentRound,
          },
          timestamp,
        });
      } else {
        for (const step of database.coordinationSteps) {
          if (
            step.sessionId === session.id &&
            step.planVersion === session.planVersion &&
            step.status === "pending"
          ) {
            step.status = "cancelled";
            step.completedAt = timestamp;
          }
        }
        const previousRound = session.currentRound;
        session.currentRound += 1;
        session.callsInCurrentRound = 0;
        session.needsReplan = true;
        interruption.status = "new_round";
        appendEvent(database, session, {
          type: "round.restarted",
          actorType: "human",
          actorId: humanId,
          stepId: interruptedStep.id,
          content: "发起者结束被中断的轮次并新开一轮。",
          metadata: { previousRound, newRound: session.currentRound },
          timestamp,
        });
      }
      interruption.resolvedAt = timestamp;
      interruption.resolvedByUserId = humanId;
      session.status = session.mode === "manual" ? "waiting_for_human" : "active";
      session.manualAdvanceRequest = null;
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async completeStep(
    sessionId: string,
    stepId: string,
    agentId: string,
    content: string,
    runId: string | null = null,
  ): Promise<CoordinationSnapshot> {
    const trimmed = content.trim();
    if (!trimmed) throw new HttpError(400, "Agent output is required");
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      const step = requireStep(database, sessionId, stepId);
      if (session.activeStepId !== step.id || step.status !== "running") {
        throw new HttpError(409, "The coordination step is not the active running step");
      }
      if (step.agentId !== agentId) {
        throw new HttpError(403, "Only the selected Agent may complete this step");
      }
      const timestamp = now();
      if (
        session.interruption?.status === "cancelling" &&
        session.interruption.stepId === step.id
      ) {
        pauseInterruptedStep(database, session, step, timestamp);
        touch(session, timestamp);
        return;
      }
      const outputEvent = appendEvent(database, session, {
        type: "agent.message",
        actorType: "agent",
        actorId: agentId,
        stepId,
        content: trimmed,
        metadata: { runId },
        timestamp,
      });
      step.status = "completed";
      step.runId = runId;
      step.outputEventId = outputEvent.id;
      step.completedAt = timestamp;
      session.callsInCurrentRound += 1;
      appendEvent(database, session, {
        type: "step.completed",
        actorType: "system",
        stepId,
        metadata: { agentId, runId },
        timestamp,
      });
      session.activeStepId = null;
      const hasPendingStep = database.coordinationSteps.some(
        (candidate) =>
          candidate.sessionId === sessionId &&
          candidate.planVersion === session.planVersion &&
          candidate.status === "pending",
      );
      const roundLimitReached = session.callsInCurrentRound >= session.maxCallsPerRound;
      if (roundLimitReached) {
        appendEvent(database, session, {
          type: "round.completed",
          actorType: "system",
          metadata: {
            round: session.currentRound,
            executedCalls: session.callsInCurrentRound,
            maxCallsPerRound: session.maxCallsPerRound,
          },
          timestamp,
        });
        if (hasPendingStep) {
          createRoundExtensionRequest(
            database,
            session,
            null,
            "本轮 Agent 调用额度已用完；原调度计划仍有步骤待执行，批准后将从断点继续。",
            true,
            timestamp,
          );
        } else {
          // The planned work is complete. The coordinator may now decide
          // whether the task is finished or another plan is necessary.
          session.needsReplan = true;
        }
      }
      if (
        !roundLimitReached &&
        session.coordinatorEnabled &&
        !session.needsReplan &&
        !hasPendingStep
      ) {
        session.needsReplan = true;
        session.status = session.mode === "manual" ? "waiting_for_human" : "active";
        appendEvent(database, session, {
          type: "round.completed",
          actorType: "system",
          metadata: { round: session.planVersion },
          timestamp,
        });
      } else if (
        session.roundExtensionRequest?.status === "pending" ||
        session.needsReplan ||
        hasPendingStep ||
        session.kind === "group_chat"
      ) {
        session.status = session.mode === "manual" ? "waiting_for_human" : "active";
        if (session.roundExtensionRequest?.status === "pending") {
          session.status = "waiting_for_human";
        }
      } else {
        const executedCalls = session.callsInCurrentRound;
        session.status = "completed";
        session.completedAt = timestamp;
        appendEvent(database, session, {
          type: "session.completed",
          actorType: "system",
          metadata: { planVersion: session.planVersion, executedCalls },
          timestamp,
        });
        session.callsInCurrentRound = 0;
      }
      if (
        session.mode === "manual" &&
        session.status === "waiting_for_human" &&
        session.roundExtensionRequest?.status !== "pending" &&
        (hasPendingStep || session.needsReplan || session.kind === "group_chat")
      ) {
        session.manualAdvanceRequest = {
          id: randomUUID(),
          afterStepId: step.id,
          rationale: roundLimitReached
            ? `本轮已执行 ${session.callsInCurrentRound}/${session.maxCallsPerRound} 次，需要调度 Agent 判断是否申请下一轮。`
            : "当前 Agent 已完成回复。无人补充时将按原计划执行下一步；有新信息时才由调度 Agent 重新规划。",
          status: "pending",
          requestedAt: timestamp,
          resolvedAt: null,
          resolvedByUserId: null,
        };
        appendEvent(database, session, {
          type: "manual_advance.requested",
          actorType: "system",
          stepId: step.id,
          content: session.manualAdvanceRequest.rationale,
          metadata: {
            currentRound: session.currentRound,
            callsInCurrentRound: session.callsInCurrentRound,
            maxCallsPerRound: session.maxCallsPerRound,
          },
          timestamp,
        });
      }
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async resolveManualAdvance(
    sessionId: string,
    humanId: string,
    decision: "approve" | "reject",
    expectedVersion: number,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      requireVersion(session, expectedVersion);
      const request = session.manualAdvanceRequest;
      if (!request || request.status !== "pending") {
        throw new HttpError(409, "No manual next-step request is pending");
      }
      const timestamp = now();
      request.status = decision === "approve" ? "approved" : "rejected";
      request.resolvedAt = timestamp;
      request.resolvedByUserId = humanId;
      session.status = "waiting_for_human";
      if (decision === "reject") {
        for (const step of database.coordinationSteps) {
          if (
            step.sessionId === session.id &&
            step.planVersion === session.planVersion &&
            step.status === "pending"
          ) {
            step.status = "cancelled";
            step.completedAt = timestamp;
          }
        }
        session.needsReplan = false;
      }
      appendEvent(database, session, {
        type: "manual_advance.resolved",
        actorType: "human",
        actorId: humanId,
        stepId: request.afterStepId,
        metadata: {
          decision,
          resumedOriginalPlan: decision === "approve" && !session.needsReplan,
        },
        timestamp,
      });
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async completeByCoordinator(
    sessionId: string,
    coordinatorAgentId: string,
    rationale: string,
    expectedVersion: number,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      requireVersion(session, expectedVersion);
      if (!session.coordinatorEnabled || session.coordinatorAgentId !== coordinatorAgentId) {
        throw new HttpError(403, "Only this task's enabled coordinator may complete it");
      }
      if (session.activeStepId !== null) {
        throw new HttpError(409, "The coordinator cannot complete a running step");
      }
      const hasCompletedStep = database.coordinationSteps.some(
        (step) => step.sessionId === sessionId && step.status === "completed",
      );
      if (!hasCompletedStep) {
        throw new HttpError(409, "The coordinator cannot complete a task before any Agent contributes");
      }
      const timestamp = now();
      const executedCalls = session.callsInCurrentRound;
      const completionSummary = rationale.trim().slice(0, 2_000);
      const completionMessage = /本次任务(?:已|已经)?结束/.test(completionSummary)
        ? completionSummary
        : `${completionSummary}\n\n本次任务已结束。`;
      session.needsReplan = false;
      session.status = "completed";
      session.completedAt = timestamp;
      appendEvent(database, session, {
        type: "coordinator.decision",
        actorType: "coordinator",
        actorId: coordinatorAgentId,
        content: rationale.slice(0, 2_000),
        metadata: { decision: "complete", round: session.planVersion, executedCalls },
        timestamp,
      });
      appendEvent(database, session, {
        type: "agent.message",
        actorType: "agent",
        actorId: coordinatorAgentId,
        content: completionMessage,
        metadata: { coordinatorAnnouncement: true, decision: "complete" },
        timestamp,
      });
      appendEvent(database, session, {
        type: "session.completed",
        actorType: "system",
        metadata: { planVersion: session.planVersion, decidedByCoordinator: true, executedCalls },
        timestamp,
      });
      session.callsInCurrentRound = 0;
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async pauseForHuman(
    sessionId: string,
    coordinatorAgentId: string,
    rationale: string,
    expectedVersion: number,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      requireVersion(session, expectedVersion);
      if (!session.coordinatorEnabled || session.coordinatorAgentId !== coordinatorAgentId) {
        throw new HttpError(403, "Only this task's enabled coordinator may pause it");
      }
      if (session.activeStepId !== null) {
        throw new HttpError(409, "The coordinator cannot pause a running step");
      }
      const timestamp = now();
      session.needsReplan = false;
      session.status = "waiting_for_human";
      appendEvent(database, session, {
        type: "coordinator.decision",
        actorType: "coordinator",
        actorId: coordinatorAgentId,
        content: rationale.slice(0, 2_000),
        metadata: { decision: "await_human", round: session.planVersion },
        timestamp,
      });
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async requestRoundExtension(
    sessionId: string,
    coordinatorAgentId: string | null,
    rationale: string,
    requestedAdditionalRounds: number,
    expectedVersion: number,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      requireVersion(session, expectedVersion);
      if (
        session.coordinatorEnabled
          ? session.coordinatorAgentId !== coordinatorAgentId
          : coordinatorAgentId !== null
      ) {
        throw new HttpError(403, "The round request actor does not match this coordination session");
      }
      if (session.activeStepId !== null) {
        throw new HttpError(409, "The coordinator cannot request more rounds while a step is running");
      }
      if (session.roundExtensionRequest?.status === "pending") {
        throw new HttpError(409, "A round extension request is already pending");
      }
      const timestamp = now();
      createRoundExtensionRequest(
        database,
        session,
        coordinatorAgentId,
        rationale,
        false,
        timestamp,
      );
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async resolveRoundExtension(
    sessionId: string,
    humanId: string,
    decision: "approve" | "reject",
    additionalRounds: number | undefined,
    expectedVersion: number,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      requireVersion(session, expectedVersion);
      const request = session.roundExtensionRequest;
      if (!request || request.status !== "pending") {
        throw new HttpError(409, "No round extension request is pending");
      }
      const timestamp = now();
      const approvedRounds = decision === "approve" ? 1 : null;
      request.status = decision === "approve" ? "approved" : "rejected";
      request.resolvedAt = timestamp;
      request.resolvedByUserId = humanId;
      request.approvedAdditionalRounds = approvedRounds;
      if (approvedRounds !== null) {
        const hasPendingOriginalStep = database.coordinationSteps.some(
          (step) =>
            step.sessionId === session.id &&
            step.planVersion === session.planVersion &&
            step.status === "pending",
        );
        const hasHumanInterjection = database.coordinationEvents.some(
          (event) =>
            event.sessionId === session.id &&
            event.type === "human.message" &&
            event.sequence > request.contextThroughSequence,
        );
        const resumeOriginalPlan =
          hasPendingOriginalStep && !hasHumanInterjection && !session.needsReplan;
        session.currentRound += 1;
        session.callsInCurrentRound = 0;
        session.needsReplan = !resumeOriginalPlan;
        session.status = session.mode === "manual" ? "waiting_for_human" : "active";
      } else {
        for (const step of database.coordinationSteps) {
          if (
            step.sessionId === session.id &&
            step.planVersion === session.planVersion &&
            step.status === "pending"
          ) {
            step.status = "cancelled";
            step.completedAt = timestamp;
          }
        }
        session.needsReplan = false;
        session.status = "waiting_for_human";
      }
      appendEvent(database, session, {
        type: "round_extension.resolved",
        actorType: "human",
        actorId: humanId,
        metadata: {
          decision,
          approvedAdditionalRounds: approvedRounds ?? 0,
          newRound: session.currentRound,
          maxCallsPerRound: session.maxCallsPerRound,
          resumedOriginalPlan: approvedRounds !== null && !session.needsReplan,
        },
        timestamp,
      });
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async failStep(
    sessionId: string,
    stepId: string,
    error: string,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      const step = requireStep(database, sessionId, stepId);
      if (session.activeStepId !== step.id || step.status !== "running") {
        throw new HttpError(409, "The coordination step is not the active running step");
      }
      const timestamp = now();
      step.status = "failed";
      step.error = error;
      step.completedAt = timestamp;
      session.activeStepId = null;
      session.status = "failed";
      appendEvent(database, session, {
        type: "step.failed",
        actorType: "system",
        stepId,
        metadata: { error },
        timestamp,
      });
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async retryStep(
    sessionId: string,
    stepId: string,
    actorId: string,
    expectedVersion: number,
  ): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      requireMutable(session);
      requireVersion(session, expectedVersion);
      if (session.activeStepId !== null) {
        throw new HttpError(409, "Cannot retry while another step is running");
      }
      if (session.needsReplan) {
        throw new HttpError(409, "New human context requires the coordinator to replan");
      }
      const step = requireStep(database, sessionId, stepId);
      if (step.status !== "failed") throw new HttpError(409, "Only a failed step may be retried");
      const timestamp = now();
      step.status = "pending";
      step.error = null;
      step.startedAt = null;
      step.completedAt = null;
      step.contextThroughSequence = null;
      session.status = session.mode === "manual" ? "waiting_for_human" : "active";
      appendEvent(database, session, {
        type: "step.retry_scheduled",
        actorType: "human",
        actorId,
        stepId,
        metadata: { nextAttempt: step.attempt + 1 },
        timestamp,
      });
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async stop(sessionId: string, actorId: string): Promise<CoordinationSnapshot> {
    await this.store.mutate((database) => {
      const session = requireSession(database, sessionId);
      if (session.status === "stopped") return;
      if (session.status === "completed") {
        throw new HttpError(409, "A completed coordination session cannot be stopped");
      }
      const timestamp = now();
      const executedCalls = session.callsInCurrentRound;
      for (const step of database.coordinationSteps) {
        if (
          step.sessionId === sessionId &&
          (step.status === "pending" || step.status === "running")
        ) {
          step.status = "cancelled";
          step.completedAt = timestamp;
        }
      }
      session.activeStepId = null;
      session.status = "stopped";
      session.completedAt = timestamp;
      appendEvent(database, session, {
        type: "session.stopped",
        actorType: "human",
        actorId,
        metadata: { executedCalls },
        timestamp,
      });
      session.callsInCurrentRound = 0;
      touch(session, timestamp);
    });
    return this.get(sessionId);
  }

  async recoverInterruptedSessions(): Promise<void> {
    await this.store.mutate((database) => {
      const timestamp = now();
      for (const session of database.coordinationSessions) {
        if (session.status !== "running" || session.activeStepId === null) continue;
        const step = database.coordinationSteps.find(
          (candidate) => candidate.id === session.activeStepId,
        );
        if (
          step?.status === "running" &&
          session.interruption?.status === "cancelling" &&
          session.interruption.stepId === step.id
        ) {
          pauseInterruptedStep(database, session, step, timestamp);
          touch(session, timestamp);
          continue;
        }
        if (step?.status === "running") {
          step.status = "failed";
          step.error = "Server restarted while this coordination step was active";
          step.completedAt = timestamp;
          appendEvent(database, session, {
            type: "step.failed",
            actorType: "system",
            stepId: step.id,
            metadata: { error: step.error, recoveredAfterRestart: true },
            timestamp,
          });
        }
        session.activeStepId = null;
        session.status = "failed";
        touch(session, timestamp);
      }
    });
  }
}
