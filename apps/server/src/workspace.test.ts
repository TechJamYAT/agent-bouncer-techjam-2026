import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, Workspace } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("WorkspaceManager", () => {
  it("creates one owner workspace and project runtime without Agent ownership", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-workspace-test-"));
    temporaryDirectories.push(root);
    const manager = new WorkspaceManager(root);
    const timestamp = new Date().toISOString();
    const workspace: Workspace = {
      id: "workspace-1",
      ownerType: "group",
      ownerUserId: null,
      groupId: "group-1",
      relativePath: manager.groupRelativePath("group-1"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const project: Project = {
      id: "project-1",
      workspaceId: workspace.id,
      sourceAgentId: null,
      name: "Shared launch task",
      description: "",
      relativePath: "projects/project-1",
      createdByUserId: "user-1",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await manager.initialize();
    await manager.ensureWorkspace(workspace);
    const projectPath = await manager.ensureProject(workspace, project);

    expect(await readdir(manager.workspacePath(workspace))).toEqual(
      expect.arrayContaining([".launchpad", ".gitignore", "projects", "shared"]),
    );
    const toolPath = path.join(projectPath, ".launchpad", "tools", "vault.mjs");
    expect((await stat(toolPath)).mode & 0o777).toBe(0o500);
    expect(await readFile(toolPath, "utf8")).toContain("--owner");
    expect(await readFile(toolPath, "utf8")).toContain("url += '/read'");
    expect(await readFile(path.join(projectPath, "AGENTS.md"), "utf8"))
      .toContain("not to an Agent");
    expect(await readFile(path.join(manager.workspacePath(workspace), ".launchpad", "WORKSPACE.md"), "utf8"))
      .toContain("no Agent owns this workspace");
    await expect(
      manager.inspectProjectFile(workspace, project, "../../shared/private.txt"),
    ).rejects.toThrow("workspace boundary");

    await writeFile(path.join(projectPath, "AGENTS.md"), "# User-owned shared rules\n");
    await manager.ensureProject(workspace, project);
    expect(await readFile(path.join(projectPath, "AGENTS.md"), "utf8"))
      .toBe("# User-owned shared rules\n");
    expect((await stat(toolPath)).mode & 0o777).toBe(0o500);
    expect((await stat(path.join(path.dirname(toolPath), "workspace.mjs"))).mode & 0o777).toBe(0o500);
    expect(await readdir(path.dirname(toolPath))).toEqual(["vault.mjs", "workspace.mjs"]);

    await manager.writeRuntimeContext(projectPath, { run: { id: "run-1" } });
    const contextPath = path.join(projectPath, ".launchpad", "context.json");
    expect(JSON.parse(await readFile(contextPath, "utf8"))).toEqual({ run: { id: "run-1" } });
    expect((await stat(contextPath)).mode & 0o777).toBe(0o444);
    await manager.writeRuntimeContext(projectPath, { run: { id: "run-2" } });
    expect(JSON.parse(await readFile(contextPath, "utf8"))).toEqual({ run: { id: "run-2" } });
    expect((await readdir(path.dirname(contextPath))).some((name) => name.startsWith(".context.")))
      .toBe(false);

    await manager.writeRuntimeGroupManifest(projectPath, {
      authority: "complete_current_server_roster",
      counts: { humanMembers: 3, agents: 2 },
    });
    const groupPath = path.join(projectPath, ".launchpad", "group.json");
    expect(JSON.parse(await readFile(groupPath, "utf8"))).toMatchObject({
      counts: { humanMembers: 3, agents: 2 },
    });
    expect((await stat(groupPath)).mode & 0o777).toBe(0o444);

    await mkdir(path.join(projectPath, "src"), { recursive: true });
    await mkdir(path.join(projectPath, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(projectPath, "src", "main.ts"), "export const answer = 42;\n");
    await writeFile(path.join(projectPath, "image.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(projectPath, "node_modules", "ignored", "index.js"), "ignored");

    const files = await manager.listProjectFiles(workspace, project);
    expect(files.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining(["AGENTS.md", "image.bin", "src/main.ts"]),
    );
    expect(files.some((file) => file.relativePath.startsWith(".launchpad/"))).toBe(false);
    expect(files.some((file) => file.relativePath.startsWith("node_modules/"))).toBe(false);

    await expect(manager.previewProjectFile(workspace, project, "src/main.ts"))
      .resolves.toMatchObject({ kind: "text", content: "export const answer = 42;\n" });
    await expect(manager.previewProjectFile(workspace, project, "image.bin"))
      .resolves.toMatchObject({ kind: "binary", content: null });

    const archive = await manager.createProjectZip(workspace, project);
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.includes(Buffer.from("src/main.ts"))).toBe(true);
    expect(archive.includes(Buffer.from(".launchpad/context.json"))).toBe(false);
    expect(archive.includes(Buffer.from("node_modules/ignored/index.js"))).toBe(false);
  });

  it("rejects a workspace path that escapes the configured storage root", () => {
    const manager = new WorkspaceManager("/tmp/launchpad-safe-root");
    const timestamp = new Date().toISOString();
    const workspace: Workspace = {
      id: "workspace-escape",
      ownerType: "personal",
      ownerUserId: "user-1",
      groupId: null,
      relativePath: "../../outside",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(() => manager.workspacePath(workspace)).toThrow("Invalid workspace path");
  });
});
