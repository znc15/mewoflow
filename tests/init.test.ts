import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initProject, updateProject } from "../src/init.js";

describe("initProject", () => {
  it("creates minimal MewoFlow and Claude Code files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-init-"));

    await initProject(root);

    await expect(fs.stat(path.join(root, "AGENTS.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, "CLAUDE.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "rules.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "workflow.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "journal.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "specs", "coding.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "specs", "testing.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "specs", "agent.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "tasks", ".gitkeep"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "archive", ".gitkeep"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "runtime", "mewoflow-hook.cjs"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "runtime", "sessions", ".gitkeep"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".claude", "settings.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".claude", "skills", "mewoflow", "SKILL.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".claude", "skills", "mewoflow-doctor", "SKILL.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".claude", "skills", "grill-me", "SKILL.md"))).resolves.toBeTruthy();

    await expect(fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).resolves.toContain("@AGENTS.md");
    await expect(fs.readFile(path.join(root, ".claude", "skills", "mewoflow", "SKILL.md"), "utf8")).resolves.toContain("npx mewoflow doctor");
    await expect(fs.readFile(path.join(root, ".claude", "skills", "grill-me", "SKILL.md"), "utf8")).resolves.toContain("Interview me relentlessly");
    const hookText = await fs.readFile(path.join(root, ".mewoflow", "runtime", "mewoflow-hook.cjs"), "utf8");
    expect(hookText).not.toContain('spawnSync("npx"');
    expect(hookText).toContain("timeout: 10000");
    expect(hookText).toContain("shell: false");
  });

  it("preserves user-edited rules and workflow files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-init-"));
    const rulesFile = path.join(root, ".mewoflow", "rules.md");
    const workflowFile = path.join(root, ".mewoflow", "workflow.md");

    await initProject(root);
    await fs.writeFile(rulesFile, "custom rules\n", "utf8");
    await fs.writeFile(workflowFile, "custom workflow\n", "utf8");

    await initProject(root);

    await expect(fs.readFile(rulesFile, "utf8")).resolves.toBe("custom rules\n");
    await expect(fs.readFile(workflowFile, "utf8")).resolves.toBe("custom workflow\n");
  });

  it("preserves generated local loop files on repeated init", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-init-"));
    const journalFile = path.join(root, ".mewoflow", "journal.md");
    const codingSpecFile = path.join(root, ".mewoflow", "specs", "coding.md");
    const entrySkillFile = path.join(root, ".claude", "skills", "mewoflow", "SKILL.md");
    const doctorSkillFile = path.join(root, ".claude", "skills", "mewoflow-doctor", "SKILL.md");
    const grillMeSkillFile = path.join(root, ".claude", "skills", "grill-me", "SKILL.md");
    const agentsFile = path.join(root, "AGENTS.md");
    const claudeFile = path.join(root, "CLAUDE.md");

    await initProject(root);
    await fs.writeFile(journalFile, "custom journal\n", "utf8");
    await fs.writeFile(codingSpecFile, "custom coding spec\n", "utf8");
    await fs.writeFile(entrySkillFile, "custom entry skill\n", "utf8");
    await fs.writeFile(doctorSkillFile, "custom doctor skill\n", "utf8");
    await fs.writeFile(grillMeSkillFile, "custom grill-me skill\n", "utf8");
    await fs.writeFile(agentsFile, "custom agents\n", "utf8");
    await fs.writeFile(claudeFile, "custom claude\n", "utf8");

    await initProject(root);

    await expect(fs.readFile(journalFile, "utf8")).resolves.toBe("custom journal\n");
    await expect(fs.readFile(codingSpecFile, "utf8")).resolves.toBe("custom coding spec\n");
    await expect(fs.readFile(entrySkillFile, "utf8")).resolves.toBe("custom entry skill\n");
    await expect(fs.readFile(doctorSkillFile, "utf8")).resolves.toBe("custom doctor skill\n");
    await expect(fs.readFile(grillMeSkillFile, "utf8")).resolves.toBe("custom grill-me skill\n");
    await expect(fs.readFile(agentsFile, "utf8")).resolves.toBe("custom agents\n");
    await expect(fs.readFile(claudeFile, "utf8")).resolves.toBe("custom claude\n");
  });

  it("merges Claude Code hooks without duplicating them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-init-"));
    const hookPath = path.join(root, ".mewoflow", "runtime", "mewoflow-hook.cjs").replace(/\\/g, "/");
    const settingsFile = path.join(root, ".claude", "settings.json");
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    await fs.writeFile(
      settingsFile,
      JSON.stringify(
        {
          permissions: { allow: ["Read"] },
          hooks: {
            Stop: [{ matcher: "*", hooks: [{ type: "command", command: "echo old" }] }],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await initProject(root);
    await initProject(root);

    const settings = JSON.parse(await fs.readFile(settingsFile, "utf8")) as {
      permissions?: { allow: string[] };
      hooks: Record<string, { hooks: { command?: string }[] }[]>;
    };
    const commands = Object.values(settings.hooks)
      .flat()
      .flatMap((group) => group.hooks.map((hook) => hook.command));

    expect(settings.permissions?.allow).toEqual(["Read"]);
    expect(commands).toContain("echo old");
    expect(commands).toContain(`node "${hookPath}" user-prompt-submit`);
    expect(commands).toContain(`node "${hookPath}" pre-tool-use`);
    expect(commands).toContain(`node "${hookPath}" post-tool-use`);
    expect(commands).toContain(`node "${hookPath}" stop`);
    expect(commands.filter((command) => command?.includes("mewoflow-hook.cjs"))).toHaveLength(4);
  });

  it("replaces stale relative MewoFlow hook commands with root-absolute commands", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-init-"));
    const hookPath = path.join(root, ".mewoflow", "runtime", "mewoflow-hook.cjs").replace(/\\/g, "/");
    const settingsFile = path.join(root, ".claude", "settings.json");
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    await fs.writeFile(
      settingsFile,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: 'node ".mewoflow/runtime/mewoflow-hook.cjs" pre-tool-use' }] }],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await initProject(root);

    const settings = JSON.parse(await fs.readFile(settingsFile, "utf8")) as {
      hooks: Record<string, { hooks: { command?: string }[] }[]>;
    };
    const commands = Object.values(settings.hooks)
      .flat()
      .flatMap((group) => group.hooks.map((hook) => hook.command));

    expect(commands).not.toContain('node ".mewoflow/runtime/mewoflow-hook.cjs" pre-tool-use');
    expect(commands).toContain(`node "${hookPath}" pre-tool-use`);
    expect(commands.filter((command) => command?.includes("mewoflow-hook.cjs"))).toHaveLength(4);
  });

  it("previews updates without writing during dry-run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-update-"));
    const hookFile = path.join(root, ".mewoflow", "runtime", "mewoflow-hook.cjs");
    await fs.mkdir(path.dirname(hookFile), { recursive: true });
    await fs.writeFile(hookFile, "stale hook\n", "utf8");

    const result = await updateProject(root, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.actions).toContainEqual(expect.objectContaining({ action: "refresh", file: path.join(".mewoflow", "runtime", "mewoflow-hook.cjs") }));
    await expect(fs.readFile(hookFile, "utf8")).resolves.toBe("stale hook\n");
    await expect(fs.stat(path.join(root, "AGENTS.md"))).rejects.toThrow();
  });

  it("updates managed wiring while preserving local template edits by default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-update-"));
    const hookPath = path.join(root, ".mewoflow", "runtime", "mewoflow-hook.cjs").replace(/\\/g, "/");
    const hookFile = path.join(root, ".mewoflow", "runtime", "mewoflow-hook.cjs");
    const agentsFile = path.join(root, "AGENTS.md");
    const settingsFile = path.join(root, ".claude", "settings.json");

    await initProject(root);
    await fs.writeFile(agentsFile, "custom agents\n", "utf8");
    await fs.writeFile(hookFile, "stale hook\n", "utf8");
    await fs.writeFile(
      settingsFile,
      JSON.stringify(
        {
          permissions: { allow: ["Read"] },
          hooks: {
            PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: 'node ".mewoflow/runtime/mewoflow-hook.cjs" pre-tool-use' }] }],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await updateProject(root);

    expect(result.actions).toContainEqual(expect.objectContaining({ action: "skip", file: "AGENTS.md" }));
    await expect(fs.readFile(agentsFile, "utf8")).resolves.toBe("custom agents\n");
    await expect(fs.readFile(hookFile, "utf8")).resolves.toContain("projectRoot");

    const settings = JSON.parse(await fs.readFile(settingsFile, "utf8")) as {
      permissions?: { allow: string[] };
      hooks: Record<string, { hooks: { command?: string }[] }[]>;
    };
    const commands = Object.values(settings.hooks)
      .flat()
      .flatMap((group) => group.hooks.map((hook) => hook.command));

    expect(settings.permissions?.allow).toEqual(["Read"]);
    expect(commands).not.toContain('node ".mewoflow/runtime/mewoflow-hook.cjs" pre-tool-use');
    expect(commands).toContain(`node "${hookPath}" pre-tool-use`);
    expect(commands.filter((command) => command?.includes("mewoflow-hook.cjs"))).toHaveLength(4);
  });

  it("force update overwrites generated template files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-update-"));
    const agentsFile = path.join(root, "AGENTS.md");

    await initProject(root);
    await fs.writeFile(agentsFile, "custom agents\n", "utf8");
    const result = await updateProject(root, { force: true });

    expect(result.force).toBe(true);
    expect(result.actions).toContainEqual(expect.objectContaining({ action: "overwrite", file: "AGENTS.md" }));
    await expect(fs.readFile(agentsFile, "utf8")).resolves.toContain("This project uses MewoFlow");
  });
});
