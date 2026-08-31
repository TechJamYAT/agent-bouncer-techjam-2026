import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { JsonStore } from "./store.js";
import type {
  AccessRequest,
  AuthorizationAction,
  AuthorizationDecision,
  MiddlewareEvidenceRequirement,
} from "./types.js";

const now = () => new Date().toISOString();
type DecisionInput = Omit<AuthorizationDecision, "id" | "occurredAt" | "policyVersion">;

interface ProtectedResourceWorkflowHooks {
  recordDecision(input: DecisionInput): Promise<AuthorizationDecision>;
  queueResume(request: AccessRequest): void;
}

/**
 * Owns the durable approval state machine around protected-resource requests.
 * Runtime execution remains in AgentService and is invoked only after this
 * service has committed the corresponding request/decision transition.
 */
export class ProtectedResourceWorkflowService {
  private readonly approvalTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly hooks: ProtectedResourceWorkflowHooks,
  ) {}

  async bindContinuation(
    request: AccessRequest,
    continuation: {
      action: "read" | "disclose" | "forward";
      resourceId: string;
      recipientUserId?: string | null | undefined;
    },
  ): Promise<AccessRequest> {
    return this.store.mutate((database) => {
      const stored = database.accessRequests.find((item) => item.id === request.id);
      if (!stored) throw new Error("Access request no longer exists");
      const recipientUserId = continuation.recipientUserId ?? null;
      if (
        stored.continuationAction &&
        (
          stored.continuationAction !== continuation.action ||
          stored.continuationResourceId !== continuation.resourceId ||
          (stored.continuationRecipientUserId ?? null) !== recipientUserId
        )
      ) {
        throw new HttpError(409, "This approval already has a different protected-action continuation");
      }
      stored.continuationAction = continuation.action;
      stored.continuationResourceId = continuation.resourceId;
      stored.continuationRecipientUserId = recipientUserId;
      return structuredClone(stored);
    });
  }

  async storeAndPause(request: AccessRequest): Promise<void> {
    const timestamp = now();
    await this.store.mutate((database) => {
      database.accessRequests.push(request);
      const run = database.runs.find((item) => item.id === request.runId);
      if (run && !["completed", "failed", "cancelled"].includes(run.status)) {
        run.status = "waiting_for_approval";
        run.middlewareEvidenceStatus = "pending";
        run.completedAt = null;
        run.error = null;
      }
      const agent = database.agents.find((item) => item.id === request.agentId);
      if (agent && agent.status !== "stopped" && agent.status !== "deleted") {
        agent.status = "busy";
        agent.lastError = null;
        agent.updatedAt = timestamp;
      }
    });
  }

  hasFinalEvidence(request: AccessRequest): boolean {
    if (request.status !== "approved") return false;
    const expectedAction: AuthorizationAction = request.action === "list"
      ? "resource:list"
      : request.action === "read"
        ? "resource:read"
        : request.action === "disclose"
          ? "resource:disclose"
          : "resource:forward";
    const expectedTargetId = request.action === "list"
      ? request.ownerUserId
      : request.resourceId;
    const database = this.store.snapshot();
    const recipient = database.users.find((item) => item.id === request.recipientUserId);
    return database.authorizationDecisions.some((decision) =>
      decision.runId === request.runId &&
      decision.executingAgentId === request.agentId &&
      decision.action === expectedAction &&
      decision.targetId === expectedTargetId &&
      decision.decision === "allow" &&
      (!request.resolvedAt || decision.occurredAt >= request.resolvedAt) &&
      (request.action !== "forward" ||
        decision.requestEvidence?.body?.requestId === request.id ||
        decision.requestEvidence?.body?.recipientUsername === recipient?.username)
    );
  }

  materializeApprovedResult(request: AccessRequest): Record<string, unknown> {
    if (request.status !== "approved" || !this.hasFinalEvidence(request)) {
      throw new Error("Approved access request does not have final policy evidence");
    }
    const database = this.store.snapshot();
    const owner = database.users.find((item) => item.id === request.ownerUserId);
    if (!owner) throw new Error("Approved access request owner no longer exists");
    if (request.action === "list") {
      return {
        action: "list",
        catalog: {
          ownerUsername: owner.username,
          visibility: "metadata_only",
          resources: database.resources
            .filter((resource) =>
              resource.scope === "private" && resource.ownerUserId === owner.id
            )
            .sort((left, right) => left.title.localeCompare(right.title))
            .map((resource) => ({
              title: resource.title,
              kind: resource.kind,
              createdAt: resource.createdAt,
            })),
          notice: "Metadata-only catalog access does not authorize reading, processing, disclosure, or forwarding.",
        },
      };
    }
    const resource = database.resources.find((item) => item.id === request.resourceId);
    if (!resource) throw new Error("Approved access request resource no longer exists");
    if (request.action === "read" || request.action === "disclose") {
      return {
        action: request.action,
        resource: {
          title: resource.title,
          kind: resource.kind,
          content: resource.content,
        },
        policy: {
          decision: "allow",
          reasonCode: request.action === "read"
            ? "TASK_SCOPED_GRANT"
            : "DISCLOSURE_RECIPIENT_APPROVED",
          policyVersion: "bouncer-v1",
        },
      };
    }
    const recipient = database.users.find((item) => item.id === request.recipientUserId);
    const intent = database.forwardIntentGrants.find((item) =>
      item.runId === request.runId &&
      item.resourceId === resource.id &&
      item.recipientUserId === request.recipientUserId &&
      item.status === "consumed" &&
      item.deliveredMessageId !== null
    );
    const delivered = intent?.deliveredMessageId
      ? database.directMessages.find((item) => item.id === intent.deliveredMessageId)
      : null;
    if (!recipient || !intent || !delivered) {
      throw new Error("Approved forward receipt is unavailable");
    }
    return {
      action: "forward",
      receipt: {
        forwardIntentId: intent.id,
        resourceTitle: resource.title,
        recipientUsername: recipient.username,
        deliveredMessageId: delivered.id,
        deliveredAt: delivered.createdAt,
      },
      policy: {
        decision: "allow",
        reasonCode: "USER_INTENT_BOUND_FORWARD",
        policyVersion: "bouncer-v1",
      },
    };
  }

  scheduleTimeout(request: AccessRequest): void {
    const existing = this.approvalTimers.get(request.id);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, new Date(request.expiresAt).getTime() - Date.now());
    const timer = setTimeout(() => {
      this.approvalTimers.delete(request.id);
      const latest = this.store.snapshot().accessRequests.find((item) => item.id === request.id);
      if (!latest || latest.status !== "pending") return;
      void this.finish(latest, "expired", null).catch(() => undefined);
    }, Math.min(delay, 2_147_483_647));
    timer.unref();
    this.approvalTimers.set(request.id, timer);
  }

  async finish(
    request: AccessRequest,
    status: "approved" | "rejected" | "expired",
    resolvedByUserId: string | null,
  ): Promise<void> {
    const timestamp = now();
    const updated = await this.store.mutate((database) => {
      const stored = database.accessRequests.find((item) => item.id === request.id);
      if (!stored || stored.status !== "pending") return null;
      stored.status = status;
      stored.resolvedAt = timestamp;
      stored.resolvedByUserId = resolvedByUserId;
      if (status === "approved" && (stored.action === "read" || stored.action === "disclose")) {
        if (!stored.resourceId) throw new Error("Resource approval is missing its resource binding");
        const grantAction = stored.action;
        const duplicate = database.grants.some((grant) =>
          grant.resourceId === stored.resourceId &&
          grant.granteeAgentId === stored.agentId &&
          grant.action === grantAction &&
          grant.duration === "run" &&
          grant.runId === stored.runId &&
          grant.revokedAt === null
        );
        if (!duplicate) {
          database.grants.push({
            id: randomUUID(),
            resourceId: stored.resourceId,
            granteeAgentId: stored.agentId,
            grantedByUserId: stored.ownerUserId,
            action: grantAction,
            duration: "run",
            runId: stored.runId,
            taskId: null,
            expiresAt: null,
            revokedAt: null,
            createdAt: timestamp,
          });
        }
      } else if (status === "approved" && stored.action === "forward") {
        if (!stored.resourceId) throw new Error("Forward approval is missing its resource binding");
        const sourceMessage = database.messages.find(
          (message) => message.runId === stored.runId && message.role === "user",
        );
        if (!sourceMessage) throw new Error("Forward approval has no source human message");
        const duplicate = database.forwardIntentGrants.some((intent) =>
          intent.runId === stored.runId &&
          intent.resourceId === stored.resourceId &&
          intent.recipientUserId === stored.recipientUserId &&
          intent.status === "active"
        );
        if (!duplicate) {
          database.forwardIntentGrants.push({
            id: randomUUID(),
            initiatingHumanId: stored.requesterHumanId,
            agentId: stored.agentId,
            runId: stored.runId,
            conversationId: stored.conversationId,
            sourceMessageId: sourceMessage.id,
            resourceId: stored.resourceId,
            recipientUserId: stored.recipientUserId,
            status: "active",
            expiresAt: new Date(Date.now() + this.config.codexTimeoutMs + 60_000).toISOString(),
            deliveredMessageId: null,
            createdAt: timestamp,
            consumedAt: null,
            revokedAt: null,
          });
        }
      }
      if (status === "approved") {
        const run = database.runs.find((item) => item.id === stored.runId);
        if (run) {
          const requirement: MiddlewareEvidenceRequirement = stored.action === "list"
            ? {
                action: "resource:list",
                decision: "allow",
                targetId: stored.ownerUserId,
                reasonCode: "PRIVATE_CATALOG_METADATA_APPROVED",
              }
            : stored.action === "read"
              ? {
                  action: "resource:read",
                  decision: "allow",
                  targetId: stored.resourceId!,
                  reasonCode: "TASK_SCOPED_GRANT",
                }
              : stored.action === "disclose"
                ? {
                    action: "resource:disclose",
                    decision: "allow",
                    targetId: stored.resourceId!,
                    reasonCode: "DISCLOSURE_RECIPIENT_APPROVED",
                  }
                : {
                    action: "resource:forward",
                    decision: "allow",
                    targetId: stored.resourceId!,
                    reasonCode: "USER_INTENT_BOUND_FORWARD",
                  };
          run.middlewareEvidenceRequirements ??= [];
          if (!run.middlewareEvidenceRequirements.some((item) =>
            item.action === requirement.action &&
            item.decision === requirement.decision &&
            item.targetId === requirement.targetId &&
            item.reasonCode === requirement.reasonCode
          )) {
            run.middlewareEvidenceRequirements.push(requirement);
          }
          run.middlewareEvidenceStatus = "pending";
        }
      }
      return structuredClone(stored);
    });
    if (!updated) return;
    this.clearTimer(updated.id);
    await this.hooks.recordDecision({
      initiatingHumanId: updated.requesterHumanId,
      executingAgentId: updated.agentId,
      runId: updated.runId,
      taskId: null,
      conversationId: updated.conversationId,
      action: status === "approved"
        ? "approval:approve"
        : status === "rejected"
          ? "approval:reject"
          : "approval:expire",
      targetType: "access_request",
      targetId: updated.id,
      decision: status === "approved" ? "allow" : "deny",
      reasonCode: status === "approved"
        ? "RESOURCE_OWNER_APPROVED"
        : status === "rejected"
          ? "RESOURCE_OWNER_REJECTED"
          : "APPROVAL_TIMEOUT_DENIED",
      detail: status === "approved"
        ? `The resource owner approved ${request.action} for this Run only.`
        : status === "rejected"
          ? `The resource owner rejected ${request.action}.`
          : `The approval deadline passed, so ${request.action} was denied by default.`,
    });
    this.hooks.queueResume(updated);
  }

  async cancelWaitingRuns(agentId: string, humanId: string): Promise<void> {
    const timestamp = now();
    const cancelledRequests = await this.store.mutate((database) => {
      const waitingRunIds = new Set(
        database.runs
          .filter((run) => run.agentId === agentId && run.status === "waiting_for_approval")
          .map((run) => run.id),
      );
      if (waitingRunIds.size === 0) return [] as AccessRequest[];
      for (const run of database.runs) {
        if (!waitingRunIds.has(run.id)) continue;
        run.status = "cancelled";
        run.error = "Agent was stopped while waiting for protected-resource approval";
        run.completedAt = timestamp;
      }
      const requests = database.accessRequests.filter(
        (request) => waitingRunIds.has(request.runId) && request.status === "pending",
      );
      for (const request of requests) {
        request.status = "rejected";
        request.resolvedAt = timestamp;
        request.resolvedByUserId = humanId;
      }
      return structuredClone(requests);
    });
    for (const request of cancelledRequests) {
      this.clearTimer(request.id);
      await this.hooks.recordDecision({
        initiatingHumanId: request.requesterHumanId,
        executingAgentId: request.agentId,
        runId: request.runId,
        taskId: null,
        conversationId: request.conversationId,
        action: "approval:reject",
        targetType: "access_request",
        targetId: request.id,
        decision: "deny",
        reasonCode: "AGENT_STOPPED",
        detail: "The Agent was stopped while the protected-resource request was waiting for approval.",
      });
    }
  }

  private clearTimer(requestId: string): void {
    const timer = this.approvalTimers.get(requestId);
    if (timer) clearTimeout(timer);
    this.approvalTimers.delete(requestId);
  }
}
