import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService, PublicUser } from "./agent-service.js";

const SESSION_COOKIE = "launchpad_session";

const idParams = z.object({ id: z.string().uuid() });
const agentResourceParams = z.object({ id: z.string().uuid(), resourceId: z.string().uuid() });
const groupUserParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });
const loginBody = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(128),
});
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
  color: z.string().trim().max(32).optional(),
  scope: z.enum(["personal", "group"]).optional(),
  groupId: z.string().uuid().optional(),
});
const updateAgentBody = createAgentBody
  .omit({ scope: true, groupId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  resourceReferences: z.array(z.object({
    ownerUsername: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(200),
  }).strict()).max(10).optional(),
}).strict();
const createGroupBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
});
const addMemberBody = z.object({
  userId: z.string().uuid(),
  role: z.enum(["admin", "member"]).default("member"),
});
const createResourceBody = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().max(100_000),
  scope: z.enum(["private", "group"]),
  groupId: z.string().uuid().optional(),
});
const createGrantBody = z.object({
  agentId: z.string().uuid(),
  action: z.enum(["read", "process"]).optional(),
  duration: z.enum(["persistent", "run", "task"]),
  runId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  expiresAt: z.iso.datetime().optional(),
});
const resourceReadBody = z.object({}).strict();
const runtimeResourceReferenceBody = z.object({
  ownerUsername: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
}).strict();
const runtimeResourceProcessBody = runtimeResourceReferenceBody.extend({
  operation: z.literal("launch-risk-check"),
}).strict();
const runtimeResourceDisclosureBody = z.object({
  ownerUsername: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200).optional(),
}).strict();
const runtimeResourceResolveBody = z.object({
  ownerUsername: z.string().trim().min(1).max(80),
  query: z.string().trim().min(1).max(200),
}).strict();
const runtimeResourceForwardBody = runtimeResourceReferenceBody.extend({
  recipientUsername: z.string().trim().min(1).max(80),
}).strict();
const artifactPublicationBody = z.object({
  sourceRelativePath: z.string().trim().min(1).max(1024),
  destinationRelativePath: z.string().trim().min(1).max(1024),
});
const sharedFileQuery = z.object({ path: z.string().trim().min(1).max(1024) });
const projectFileQuery = z.object({ path: z.string().trim().min(1).max(1024) });
const contextImportBody = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({
    mode: z.literal("full"),
    sourceConversationId: z.string().uuid(),
  }).strict(),
  z.object({
    mode: z.literal("selected"),
    sourceConversationId: z.string().uuid(),
    eventIds: z.array(z.string().uuid()).min(1).max(100),
  }).strict(),
]);
const middlewareEvidenceRequirementsBody = z.array(z.object({
  action: z.enum(["resource:read", "resource:process", "resource:disclose", "resource:forward"]),
  decision: z.enum(["allow", "deny"]),
}).strict()).min(1).max(4).refine(
  (requirements) => new Set(requirements.map((requirement) => requirement.action)).size === requirements.length,
  "Each middleware action may appear only once",
);
const createCoordinationBody = z.object({
  kind: z.enum(["group_chat", "task"]),
  mode: z.enum(["manual", "automatic"]).default("manual"),
  title: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(10_000).optional(),
  participantAgentIds: z.array(z.string().uuid()).default([]),
  coordinatorEnabled: z.boolean().optional(),
  maxRounds: z.number().int().min(1).max(50).optional(),
  maxCallsPerRound: z.number().int().min(1).max(50).optional(),
  middlewareEvidenceRequirements: middlewareEvidenceRequirementsBody.optional(),
  contextImport: contextImportBody.optional(),
});
const coordinationMessageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const coordinationModeBody = z.object({
  mode: z.enum(["manual", "automatic"]),
  expectedVersion: z.number().int().positive(),
});
const coordinationAllowanceBody = z.object({
  maxCallsPerRound: z.number().int().min(1).max(50),
  expectedVersion: z.number().int().positive(),
});
const coordinationCoordinatorBody = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().positive(),
});
const coordinationAdvanceBody = z.object({
  expectedVersion: z.number().int().positive(),
});
const coordinationManualAdvanceBody = z.object({
  decision: z.enum(["approve", "reject"]),
  expectedVersion: z.number().int().positive(),
});
const coordinationInterruptBody = z.object({
  expectedVersion: z.number().int().positive(),
});
const coordinationInterruptionResolutionBody = z.object({
  action: z.enum(["continue", "new_round"]),
  expectedVersion: z.number().int().positive(),
});
const coordinationRetryBody = z.object({
  stepId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});
const coordinationRoundExtensionBody = z.object({
  decision: z.enum(["approve", "reject"]),
  additionalRounds: z.number().int().min(1).max(20).optional(),
  expectedVersion: z.number().int().positive(),
});

function cookieValue(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    SESSION_COOKIE + "=" + token,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=" + maxAgeSeconds,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
    },
    bodyLimit: 1_048_576,
  });
  const requestUsers = new WeakMap<FastifyRequest, PublicUser>();
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  const secureCookies = config.nodeEnv === "production" && !loopbackHosts.has(config.host);

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
    credentials: true,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth" ||
      request.url.startsWith("/api/runtime/")
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) return reply.code(401).send({ error: "Platform access token required" });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (
      request.url === "/api/health" ||
      request.url === "/api/auth" ||
      request.url === "/api/session" ||
      request.url.startsWith("/api/runtime/")
    ) {
      return;
    }
    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const user = service.currentUser(token);
    if (!user) return reply.code(401).send({ error: "User session required" });
    requestUsers.set(request, user);
  });

  const requireUser = (request: FastifyRequest): PublicUser => {
    const user = requestUsers.get(request);
    if (!user) throw new HttpError(401, "User session required");
    return user;
  };

  app.get("/api/health", async () => ({ ok: true, service: "volc-agent-launchpad" }));

  app.get("/api/auth", async () => ({
    required: config.authToken.length > 0,
    userSessionRequired: true,
  }));

  app.get("/api/session", async (request) => {
    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    return { user: service.currentUser(token) };
  });

  app.post("/api/session", async (request, reply) => {
    const body = loginBody.parse(request.body);
    const result = await service.login(body.username, body.password);
    reply.header(
      "Set-Cookie",
      sessionCookie(
        result.token,
        Math.max(1, Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000)),
        secureCookies,
      ),
    );
    return { user: result.user, expiresAt: result.expiresAt };
  });

  app.delete("/api/session", async (request, reply) => {
    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    await service.logout(token);
    reply.header("Set-Cookie", sessionCookie("", 0, secureCookies));
    return { ok: true };
  });

  app.get("/api/system", async () => service.systemInfo());
  app.get("/api/users", async () => ({ users: service.listUsers() }));

  app.get("/api/groups", async (request) => ({ groups: service.listGroups(requireUser(request).id) }));

  app.post("/api/groups", async (request, reply) => {
    const body = createGroupBody.parse(request.body);
    const group = await service.createGroup(
      requireUser(request).id,
      body.name,
      body.description ?? "",
    );
    return reply.code(201).send({ group });
  });

  app.get("/api/groups/:id/members", async (request) => {
    const { id } = idParams.parse(request.params);
    return { members: service.listMembers(requireUser(request).id, id) };
  });

  app.post("/api/groups/:id/members", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = addMemberBody.parse(request.body);
    const membership = await service.addMember(
      requireUser(request).id,
      id,
      body.userId,
      body.role,
    );
    return reply.code(201).send({ membership });
  });

  app.delete("/api/groups/:id/members/:userId", async (request) => {
    const { id, userId } = groupUserParams.parse(request.params);
    await service.removeMember(requireUser(request).id, id, userId);
    return { ok: true };
  });

  app.get("/api/groups/:id/coordination-sessions", async (request) => {
    const { id } = idParams.parse(request.params);
    return {
      sessions: service.listCoordinationSessions(requireUser(request).id, id),
    };
  });

  app.post("/api/groups/:id/coordination-sessions", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = createCoordinationBody.parse(request.body);
    const snapshot = await service.createCoordinationSession(requireUser(request).id, {
      ...body,
      groupId: id,
    });
    return reply.code(201).send(snapshot);
  });

  app.get("/api/coordination-sessions/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return service.getCoordinationSession(requireUser(request).id, id);
  });

  app.get("/api/coordination-sessions/:id/project/files", async (request) => {
    const { id } = idParams.parse(request.params);
    return {
      files: await service.listCoordinationProjectFiles(requireUser(request).id, id),
    };
  });

  app.get("/api/coordination-sessions/:id/project/file", async (request) => {
    const { id } = idParams.parse(request.params);
    const query = projectFileQuery.parse(request.query);
    return {
      file: await service.previewCoordinationProjectFile(
        requireUser(request).id,
        id,
        query.path,
      ),
    };
  });

  app.get("/api/coordination-sessions/:id/project/archive", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const archive = await service.downloadCoordinationProject(requireUser(request).id, id);
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="task-${id}.zip"`)
      .send(archive);
  });

  app.post("/api/coordination-sessions/:id/messages", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = coordinationMessageBody.parse(request.body);
    const snapshot = await service.appendCoordinationMessage(
      requireUser(request).id,
      id,
      body.content,
    );
    return reply.code(201).send(snapshot);
  });

  app.patch("/api/coordination-sessions/:id/mode", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = coordinationModeBody.parse(request.body);
    return service.setCoordinationMode(
      requireUser(request).id,
      id,
      body.mode,
      body.expectedVersion,
    );
  });

  app.patch("/api/coordination-sessions/:id/call-allowance", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = coordinationAllowanceBody.parse(request.body);
    return service.setCoordinationCallAllowance(
      requireUser(request).id,
      id,
      body.maxCallsPerRound,
      body.expectedVersion,
    );
  });

  app.patch("/api/coordination-sessions/:id/coordinator", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = coordinationCoordinatorBody.parse(request.body);
    return service.setCoordinationCoordinator(
      requireUser(request).id,
      id,
      body.enabled,
      body.expectedVersion,
    );
  });

  app.post("/api/coordination-sessions/:id/advance", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = coordinationAdvanceBody.parse(request.body);
    const result = await service.advanceCoordinationSession(
      requireUser(request).id,
      id,
      body.expectedVersion,
    );
    return reply.code(202).send(result);
  });

  app.post("/api/coordination-sessions/:id/manual-advance", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = coordinationManualAdvanceBody.parse(request.body);
    const result = await service.resolveCoordinationManualAdvance(
      requireUser(request).id,
      id,
      body.decision,
      body.expectedVersion,
    );
    return reply.code(202).send(result);
  });

  app.post("/api/coordination-sessions/:id/retry", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = coordinationRetryBody.parse(request.body);
    return service.retryCoordinationStep(
      requireUser(request).id,
      id,
      body.stepId,
      body.expectedVersion,
    );
  });

  app.post("/api/coordination-sessions/:id/interrupt", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = coordinationInterruptBody.parse(request.body);
    return service.interruptCoordinationSession(
      requireUser(request).id,
      id,
      body.expectedVersion,
    );
  });

  app.post("/api/coordination-sessions/:id/interruption", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = coordinationInterruptionResolutionBody.parse(request.body);
    const result = await service.resolveCoordinationInterruption(
      requireUser(request).id,
      id,
      body.action,
      body.expectedVersion,
    );
    return reply.code(202).send(result);
  });

  app.post("/api/coordination-sessions/:id/stop", async (request) => {
    const { id } = idParams.parse(request.params);
    return service.stopCoordinationSession(requireUser(request).id, id);
  });

  app.post("/api/coordination-sessions/:id/round-extension", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = coordinationRoundExtensionBody.parse(request.body);
    return service.resolveCoordinationRoundExtension(
      requireUser(request).id,
      id,
      body.decision,
      body.additionalRounds,
      body.expectedVersion,
    );
  });

  app.get("/api/agents", async (request) => ({ agents: service.listAgents(requireUser(request).id) }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body, requireUser(request).id);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return { agent: service.getAgentForUser(requireUser(request).id, id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body, requireUser(request).id) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return service.deleteAgent(id, requireUser(request).id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = idParams.parse(request.params);
    return { agent: await service.startAgent(id, requireUser(request).id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = idParams.parse(request.params);
    return { agent: await service.stopAgent(id, requireUser(request).id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = idParams.parse(request.params);
    return { messages: service.getMessages(id, requireUser(request).id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = idParams.parse(request.params);
    return { runs: service.getRuns(id, requireUser(request).id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(
      id,
      body.content,
      requireUser(request).id,
      body.resourceReferences ?? [],
    );
    return reply.code(202).send(result);
  });

  app.get("/api/direct-conversations", async (request) => ({
    conversations: service.listDirectConversations(requireUser(request).id),
  }));

  app.get("/api/users/:id/direct-messages", async (request) => {
    const { id } = idParams.parse(request.params);
    return {
      messages: service.getHumanDirectMessages(requireUser(request).id, id),
    };
  });

  app.post("/api/users/:id/direct-messages", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const message = await service.sendHumanDirectMessage(
      requireUser(request).id,
      id,
      body.content,
    );
    return reply.code(201).send({ message });
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return { run: service.getRun(id, requireUser(request).id) };
  });

  app.get("/api/resources", async (request) => ({
    resources: service.listResources(requireUser(request).id),
  }));

  app.post("/api/resources", async (request, reply) => {
    const body = createResourceBody.parse(request.body);
    const resource = await service.createResource(requireUser(request).id, body);
    return reply.code(201).send({ resource });
  });

  app.get("/api/grants", async (request) => ({
    grants: service.listGrants(requireUser(request).id),
  }));

  app.post("/api/agents/:id/resources/:resourceId/read", async (request) => {
    const { id, resourceId } = agentResourceParams.parse(request.params);
    resourceReadBody.parse(request.body ?? {});
    return service.readResourceAsAgent(requireUser(request).id, id, resourceId);
  });

  app.post("/api/resources/:id/grants", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = createGrantBody.parse(request.body);
    const grant = await service.createGrant(requireUser(request).id, {
      ...body,
      resourceId: id,
    });
    return reply.code(201).send({ grant });
  });

  app.delete("/api/grants/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return { grant: await service.revokeGrant(requireUser(request).id, id) };
  });

  app.get("/api/authorization-decisions", async (request) => ({
    decisions: service.listDecisions(requireUser(request).id),
  }));

  app.get("/api/access-requests", async (request) => ({
    accessRequests: service.listAccessRequests(requireUser(request).id),
  }));

  app.post("/api/access-requests/:id/approve", async (request) => {
    const { id } = idParams.parse(request.params);
    return {
      accessRequest: await service.resolveAccessRequest(requireUser(request).id, id, "approve"),
    };
  });

  app.post("/api/access-requests/:id/reject", async (request) => {
    const { id } = idParams.parse(request.params);
    return {
      accessRequest: await service.resolveAccessRequest(requireUser(request).id, id, "reject"),
    };
  });

  app.get("/api/artifact-publications", async (request) => ({
    publications: service.listArtifactPublications(requireUser(request).id),
  }));

  app.post("/api/artifact-publications/:id/approve", async (request) => {
    const { id } = idParams.parse(request.params);
    return service.reviewArtifactPublication(requireUser(request).id, id, "approve");
  });

  app.post("/api/artifact-publications/:id/reject", async (request) => {
    const { id } = idParams.parse(request.params);
    return service.reviewArtifactPublication(requireUser(request).id, id, "reject");
  });

  const runtimeToken = (request: FastifyRequest): string => {
    const header = request.headers.authorization ?? "";
    return header.startsWith("Bearer ") ? header.slice(7) : "";
  };

  app.get("/api/runtime/resources", async (request) =>
    service.getResourceCatalogForRuntime(runtimeToken(request))
  );

  app.get("/api/runtime/resources/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    return service.readResourceForRuntime(runtimeToken(request), id);
  });

  app.post("/api/runtime/resources/read", async (request) => {
    const reference = runtimeResourceReferenceBody.parse(request.body);
    return service.readResourceForRuntimeByReference(runtimeToken(request), reference);
  });

  app.post("/api/runtime/resources/process", async (request) => {
    const reference = runtimeResourceProcessBody.parse(request.body);
    return service.processResourceForRuntimeByReference(runtimeToken(request), reference);
  });

  app.post("/api/runtime/resources/disclose", async (request, reply) => {
    const reference = runtimeResourceDisclosureBody.parse(request.body);
    const result = await (reference.title
      ? service.discloseResourceForRuntimeByReference(runtimeToken(request), {
          ownerUsername: reference.ownerUsername,
          title: reference.title,
        })
      : service.requestOwnerDisclosureForRuntime(runtimeToken(request), reference));
    return "pending" in result && result.pending
      ? reply.code(202).send(result)
      : result;
  });

  app.post("/api/runtime/resources/resolve", async (request) =>
    service.resolveOwnResourceForRuntime(
      runtimeToken(request),
      runtimeResourceResolveBody.parse(request.body),
    )
  );

  app.post("/api/runtime/resources/forward", async (request) =>
    service.forwardResourceForRuntimeByReference(
      runtimeToken(request),
      runtimeResourceForwardBody.parse(request.body),
    )
  );

  app.post("/api/runtime/resources/forward-request", async (request, reply) => {
    const result = await service.requestForwardApprovalForRuntime(
      runtimeToken(request),
      runtimeResourceForwardBody.parse(request.body),
    );
    return reply.code(202).send(result);
  });

  app.get("/api/runtime/workspace/shared", async (request) => ({
    files: await service.listSharedFilesForRuntime(runtimeToken(request)),
  }));

  app.get("/api/runtime/workspace/shared/file", async (request) => {
    const query = sharedFileQuery.parse(request.query);
    return service.readSharedFileForRuntime(runtimeToken(request), query.path);
  });

  app.post("/api/runtime/artifact-publications", async (request, reply) => {
    const body = artifactPublicationBody.parse(request.body);
    const publication = await service.proposeArtifactPublicationForRuntime(
      runtimeToken(request),
      body,
    );
    return reply.code(201).send({ publication });
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) request.log.error(appError);
    const reasonCode = appError.message.startsWith("Access Denied: ")
      ? appError.message.slice("Access Denied: ".length)
      : null;
    return reply.code(statusCode).send({
      error: appError.message,
      ...(reasonCode ? { reasonCode } : {}),
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
