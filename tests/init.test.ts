import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initProject } from "../src/init.js";

describe("initProject", () => {
  it("creates minimal MewoFlow and Claude Code files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-init-"));

    await initProject(root);

    await expect(fs.stat(path.join(root, ".mewoflow", "rules.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "workflow.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "tasks", ".gitkeep"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "runtime", "mewoflow-hook.cjs"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".mewoflow", "runtime", "sessions", ".gitkeep"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(root, ".claude", "settings.json"))).resolves.toBeTruthy();
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

  it("merges Claude Code hooks without duplicating them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-init-"));
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
    expect(commands).toContain('node ".mewoflow/runtime/mewoflow-hook.cjs" user-prompt-submit');
    expect(commands).toContain('node ".mewoflow/runtime/mewoflow-hook.cjs" pre-tool-use');
    expect(commands).toContain('node ".mewoflow/runtime/mewoflow-hook.cjs" post-tool-use');
    expect(commands).toContain('node ".mewoflow/runtime/mewoflow-hook.cjs" stop');
    expect(commands.filter((command) => command?.includes("mewoflow-hook.cjs"))).toHaveLength(4);
  });
});
