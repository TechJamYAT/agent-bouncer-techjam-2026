import type { AppConfig } from "./config.js";
import { isArkConfigured, writeCodexConfig } from "./config.js";

export interface ModelRuntimeConfigurationInput {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export type ModelRuntimeConfigurationSource = "environment" | "browser" | null;

/**
 * Owns mutable, instance-scoped model credentials separately from Agent
 * orchestration. Browser-provided secrets intentionally remain in process memory
 * and are never written to the application database.
 */
export class ModelRuntimeConfiguration {
  private source: ModelRuntimeConfigurationSource;
  private configuredByUserId: string | null = null;
  private pendingUpdate: Promise<void> = Promise.resolve();

  constructor(private readonly config: AppConfig) {
    this.source = isArkConfigured(config) ? "environment" : null;
  }

  status(viewerUserId?: string): {
    configured: boolean;
    baseUrl: string;
    model: string | null;
    source: ModelRuntimeConfigurationSource;
    editable: boolean;
  } {
    return {
      configured: isArkConfigured(this.config),
      baseUrl: this.config.arkBaseUrl,
      model: this.config.arkModel || null,
      source: this.source,
      editable: Boolean(
        viewerUserId &&
        this.source !== "environment" &&
        (!this.configuredByUserId || this.configuredByUserId === viewerUserId)
      ),
    };
  }

  async configure(input: ModelRuntimeConfigurationInput, configuredByUserId: string): Promise<void> {
    const apiKey = input.apiKey.trim();
    const model = input.model.trim();
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    const update = this.pendingUpdate.then(async () => {
      const previous = {
        apiKey: this.config.arkApiKey,
        model: this.config.arkModel,
        baseUrl: this.config.arkBaseUrl,
        source: this.source,
        configuredByUserId: this.configuredByUserId,
      };
      this.config.arkApiKey = apiKey;
      this.config.arkModel = model;
      this.config.arkBaseUrl = baseUrl;
      try {
        await writeCodexConfig(this.config);
        this.source = "browser";
        this.configuredByUserId = configuredByUserId;
      } catch (error) {
        this.config.arkApiKey = previous.apiKey;
        this.config.arkModel = previous.model;
        this.config.arkBaseUrl = previous.baseUrl;
        this.source = previous.source;
        this.configuredByUserId = previous.configuredByUserId;
        throw error;
      }
    });
    this.pendingUpdate = update.catch(() => undefined);
    await update;
  }
}
