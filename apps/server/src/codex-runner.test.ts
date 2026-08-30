import { describe, expect, it } from "vitest";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("allows only the authenticated control-plane host for Runtime tools", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "read the protected source",
        threadId: null,
        runtimeEnvironment: {
          LAUNCHPAD_CONTROL_PLANE_URL: "http://127.0.0.1:3000",
        },
      },
      "workspace-write",
    );
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    expect(args).toContain("network_proxy");
    expect(args).toContain('features.network_proxy.domains={"127.0.0.1"="allow"}');
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("records only redacted vault command metadata", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
      toolEvents: [],
    };
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: 'node .launchpad/tools/vault.mjs assess --owner bob --title "Bob private title"',
          aggregated_output: "sensitive output must not be retained",
          exit_code: 3,
        },
      }),
      parsed,
    );
    expect(parsed.toolEvents).toEqual([
      expect.objectContaining({
        tool: "vault",
        operation: "assess",
        status: "failed",
        exitCode: 3,
      }),
    ]);
    expect(JSON.stringify(parsed.toolEvents)).not.toContain("Bob private title");
    expect(JSON.stringify(parsed.toolEvents)).not.toContain("sensitive output");
  });
});
