import { describe, expect, it } from "vitest";
import { isArkConfigured, loadConfig } from "./config.js";

describe("runtime configuration", () => {
  it("maps NUS SOCaaS variables to the OpenAI-compatible runtime settings", () => {
    const config = loadConfig({
      NUS_API_KEY: "nus-test-key",
      NUS_MODEL: "qwen3.6:27b",
      NUS_URL: "https://soclaas-api.comp.nus.edu.sg/v1/",
    });

    expect(config.arkApiKey).toBe("nus-test-key");
    expect(config.arkModel).toBe("qwen3.6:27b");
    expect(config.arkBaseUrl).toBe("https://soclaas-api.comp.nus.edu.sg/v1");
    expect(isArkConfigured(config)).toBe(true);
  });

  it("keeps explicit ARK settings ahead of NUS aliases", () => {
    const config = loadConfig({
      ARK_API_KEY: "ark-test-key",
      ARK_MODEL: "ep-test",
      ARK_BASE_URL: "https://ark.example.com/v3",
      NUS_API_KEY: "nus-test-key",
      NUS_MODEL: "qwen3.6:27b",
      NUS_URL: "https://nus.example.com/v1",
    });

    expect(config.arkApiKey).toBe("ark-test-key");
    expect(config.arkModel).toBe("ep-test");
    expect(config.arkBaseUrl).toBe("https://ark.example.com/v3");
  });
});
