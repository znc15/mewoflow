import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEWOFLOW_NOTICE_FIELD,
  handlePostToolUse,
  handlePreToolUse,
  handleStop,
  handleUserPromptSubmit,
} from "../src/hooks.js";
import { readText, writeFileEnsured } from "../src/fs.js";
import { loadSession, loadTask, recordReadFile, sessionFile, taskFile } from "../src/task.js";

describe("hooks", () => {
  it("does not create a workflow for simple prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "把 div 改成红色", session_id: "s1" });

    expect(output[MEWOFLOW_NOTICE_FIELD]).toBe("猫咪正在监控你的需求喵！");
    expect(String(output.additionalContext)).toContain("simple");
    await expect(fs.readdir(path.join(root, ".mewoflow", "tasks"))).rejects.toThrow();
  });

  it("does not create a workflow for conversational prompts after init", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "你好", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("simple");

    const session = await loadSession(root, "s1");
    expect(session.activeTaskId).toBeUndefined();

    const stop = await handleStop(root, { session_id: "s1" });
    expect(stop).toEqual({});
  });

  it("does not create a workflow for mewoflow doctor slash prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "/mewoflow-doctor", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("simple");

    const session = await loadSession(root, "s1");
    expect(session.activeTaskId).toBeUndefined();

    const stop = await handleStop(root, { session_id: "s1" });
    expect(stop).toEqual({});
  });

  it("creates a workflow for build-from-scratch product prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "我想创建一个音乐网页", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("猫咪正在监控你的需求喵！");
    expect(String(output.additionalContext)).toContain("MewoFlow task created");
    expect(String(output.additionalContext)).toContain("mewoflow check grill");
    expect(String(output.additionalContext)).toContain("package scaffolding");

    const active = await loadSession(root, "s1");
    expect(active.activeTaskId).toBeTruthy();

    const task = await loadTask(root, active.activeTaskId!);
    expect(task.type).toBe("standard");
    expect(task.gate).toBe("research");
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

  it("adds cat notices to post-tool and stop outputs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));

    const post = await handlePostToolUse(root, { session_id: "s1", tool_name: "WebSearch", tool_input: {} });
    expect(post[MEWOFLOW_NOTICE_FIELD]).toBe("猫咪已记录工具结果喵！");

    await handleUserPromptSubmit(root, { prompt: "修复登录 bug", session_id: "s1" });
    const stop = await handleStop(root, { session_id: "s1" });
    expect(stop[MEWOFLOW_NOTICE_FIELD]).toBe("猫咪发现任务还没完成喵！");
    expect(String(stop.reason)).toContain("猫咪发现任务还没完成喵！");
  });

  it("blocks package scaffolding when no active task exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));

    const blockedCreate = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "pnpm create next-app@latest . --typescript --tailwind 2>&1 | tail -20" },
    });
    const blockedText = JSON.stringify(blockedCreate);
    expect(blockedText).toContain("deny");
    expect(blockedText).toContain("No active MewoFlow task");
    expect(blockedText).toContain("research -> grill -> plan");
    expect(blockedText).toContain("猫咪正在检查工具调用喵！");

    const simpleEdit = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Edit",
      tool_input: { file_path: "src/a.ts" },
    });
    expect(JSON.stringify(simpleEdit)).not.toContain("deny");
  });

  it("blocks writes before implement and until required files are read", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    await handleUserPromptSubmit(root, { prompt: "修复登录 bug", session_id: "s1" });
    const active = await loadSession(root, "s1");
    const task = await loadTask(root, active.activeTaskId!);

    const blockedEarly = await handlePreToolUse(root, { session_id: "s1", tool_name: "Edit", tool_input: { file_path: "src/a.ts" } });
    expect(JSON.stringify(blockedEarly)).toContain("deny");
    expect(JSON.stringify(blockedEarly)).toContain("research -> grill -> plan");
    expect(JSON.stringify(blockedEarly)).toContain("猫咪正在检查工具调用喵！");

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

  it("allows read-only bash redirection but blocks scaffolding and file writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    await handleUserPromptSubmit(root, { prompt: "修复登录 bug", session_id: "s1" });

    const allowed = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "mewoflow doctor --require-search 2>&1" },
    });
    expect(JSON.stringify(allowed)).not.toContain("deny");

    const blockedCreate = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "pnpm create vite@latest . --template react 2>&1" },
    });
    expect(JSON.stringify(blockedCreate)).toContain("deny");

    const blockedInstall = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "pnpm install 2>&1" },
    });
    expect(JSON.stringify(blockedInstall)).toContain("deny");

    const blocked = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "echo ok > report.txt" },
    });
    expect(JSON.stringify(blocked)).toContain("deny");
  });

  it("recovers from corrupted session JSON without crashing stop", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const file = sessionFile(root, "s1");
    await writeFileEnsured(file, '{"activeTaskId":"broken"} trailing');

    const session = await loadSession(root, "s1");
    expect(session).toEqual({ readFiles: [], searchTools: [], commands: [] });

    await expect(handleStop(root, { session_id: "s1" })).resolves.toEqual({});
    await expect(readText(file)).resolves.toContain('"readFiles": []');
  });
});
