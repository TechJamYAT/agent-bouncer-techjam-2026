import { describe, expect, it } from "vitest";
import { RuntimeCredentialService } from "./runtime-credential-service.js";

const context = {
  agentId: "agent-1",
  humanId: "human-1",
  runId: "run-1",
  taskId: null,
  conversationId: "conversation-1",
  projectId: null,
};

describe("RuntimeCredentialService", () => {
  it("issues opaque credentials and resolves their bound context", () => {
    const credentials = new RuntimeCredentialService();
    const token = credentials.issue(context, 60_000);

    expect(token).not.toContain(context.agentId);
    expect(credentials.require(token)).toMatchObject(context);
  });

  it("rejects revoked, expired and missing credentials", () => {
    const credentials = new RuntimeCredentialService();
    const revoked = credentials.issue(context, 60_000);
    credentials.revoke(revoked);
    expect(() => credentials.require(revoked)).toThrow("invalid or expired");

    const expired = credentials.issue(context, -1);
    expect(() => credentials.require(expired)).toThrow("invalid or expired");
    expect(() => credentials.require("")).toThrow("credential required");
  });
});
