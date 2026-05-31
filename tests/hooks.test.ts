import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handlePostToolUse, handlePreToolUse, handleUserPromptSubmit } from "../src/hooks.js";
import { readText, writeFileEnsured } from "../src/fs.js";
import { loadSession, loadTask, recordReadFile, setActiveTask, taskFile } from "../src/task.js";

describe("hooks", () => {
  it("does not create a workflow for simple prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "把 div 改成红色", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("simple");
    await expect(fs.readdir(path.join(root, ".mewoflow", "tasks"))).rejects.toThrow();
  });

  it("creates standard and epic tasks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const standard = await handleUserPromptSubmit(root, { prompt: "修复登录 bug", session_id: "s1" });
    expect(String(standard.additionalContext)).toContain("Current gate: research");

    const active = await loadSession(root, "s1");
    expect(active.activeTaskId).toBeTruthy();
    const task = await loadTask(root, active.activeTaskId!);
    expect(task.type).toBe("standard");
    expect(task.gate).toBe("research");
  });

  it("records search and file reads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    await handlePostToolUse(root, { session_id: "s1", tool_name: "WebSearch", tool_input: {} });
    await handlePostToolUse(root, { session_id: "s1", tool_name: "Read", tool_input: { file_path: ".mewoflow/rules.md" } });

    const session = await loadSession(root, "s1");
    expect(session.searchTools[0]?.tool).toBe("WebSearch");
    expect(session.readFiles).toContain(".mewoflow/rules.md");
  });

  it("blocks writes before implement and until required files are read", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    await handleUserPromptSubmit(root, { prompt: "修复登录 bug", session_id: "s1" });
    const active = await loadSession(root, "s1");
    const task = await loadTask(root, active.activeTaskId!);

    const blockedEarly = await handlePreToolUse(root, { session_id: "s1", tool_name: "Edit", tool_input: { file_path: "src/a.ts" } });
    expect(JSON.stringify(blockedEarly)).toContain("deny");

    task.gate = "implement";
    await writeFileEnsured(taskFile(root, task.id, "task.json"), JSON.stringify(task, null, 2));

    const blockedUnread = await handlePreToolUse(root, { session_id: "s1", tool_name: "Edit", tool_input: { file_path: "src/a.ts" } });
    expect(JSON.stringify(blockedUnread)).toContain("Read required MewoFlow context");

    for (const file of [
      ".mewoflow/rules.md",
      `.mewoflow/tasks/${task.id}/research.md`,
      `.mewoflow/tasks/${task.id}/grill.md`,
      `.mewoflow/tasks/${task.id}/plan.md`,
    ]) {
      await recordReadFile(root, "s1", file);
    }

    const allowed = await handlePreToolUse(root, { session_id: "s1", tool_name: "Edit", tool_input: { file_path: "src/a.ts" } });
    expect(JSON.stringify(allowed)).not.toContain("deny");
  });

  it("allows active task evidence markdown writes before implement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    await handleUserPromptSubmit(root, { prompt: "修复登录 bug", session_id: "s1" });
    const active = await loadSession(root, "s1");
    const task = await loadTask(root, active.activeTaskId!);

    const allowedEdit = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Edit",
      tool_input: { file_path: `.mewoflow/tasks/${task.id}/research.md` },
    });
    expect(JSON.stringify(allowedEdit)).not.toContain("deny");

    const allowedCommand = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: `Set-Content .mewoflow/tasks/${task.id}/grill.md 'ok'` },
    });
    expect(JSON.stringify(allowedCommand)).not.toContain("deny");

    const blockedTaskJson = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Edit",
      tool_input: { file_path: `.mewoflow/tasks/${task.id}/task.json` },
    });
    expect(JSON.stringify(blockedTaskJson)).toContain("deny");
  });
});
