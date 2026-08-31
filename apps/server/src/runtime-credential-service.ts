import { createOpaqueToken, hashToken } from "./auth.js";
import { HttpError } from "./errors.js";

export interface RuntimeCredentialContext {
  agentId: string;
  humanId: string;
  runId: string;
  taskId: string | null;
  conversationId: string | null;
  projectId: string | null;
}

interface StoredRuntimeCredential extends RuntimeCredentialContext {
  expiresAt: number;
}

/** Owns opaque, in-memory, short-lived Runtime credentials. */
export class RuntimeCredentialService {
  private readonly credentials = new Map<string, StoredRuntimeCredential>();

  issue(context: RuntimeCredentialContext, ttlMs: number): string {
    const token = createOpaqueToken();
    this.credentials.set(hashToken(token), {
      ...context,
      expiresAt: Date.now() + ttlMs,
    });
    return token;
  }

  revoke(token: string): void {
    if (!token) return;
    this.credentials.delete(hashToken(token));
  }

  require(token: string): StoredRuntimeCredential {
    if (!token) throw new HttpError(401, "Runtime credential required");
    const tokenHash = hashToken(token);
    const credential = this.credentials.get(tokenHash);
    if (!credential || credential.expiresAt <= Date.now()) {
      if (credential) this.credentials.delete(tokenHash);
      throw new HttpError(401, "Runtime credential is invalid or expired");
    }
    return credential;
  }
}
