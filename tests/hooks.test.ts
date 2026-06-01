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
import { loadSession, loadTask, proposePendingTask, recordReadFile, sessionFile, taskFile } from "../src/task.js";

async function createConfirmedTask(root: string, sessionId = "s1") {
  const judgment = await handleUserPromptSubmit(root, { prompt: "修复登录 bug", session_id: sessionId });
  expect(String(judgment.additionalContext)).toContain("MewoFlow prompt judgment");
  let pending = await loadSession(root, sessionId);
  expect(pending.pendingJudgment).toBeTruthy();
  expect(pending.pendingTask).toBeUndefined();
  expect(pending.activeTaskId).toBeUndefined();

  const accepted = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: sessionId });
  expect(String(accepted.additionalContext)).toContain("pending task proposed after judgment confirmation");
  pending = await loadSession(root, sessionId);
  expect(pending.pendingTask).toBeTruthy();
  expect(pending.pendingJudgment).toBeUndefined();
  expect(pending.activeTaskId).toBeUndefined();

  await proposePendingTask(root, { title: "修复登录 bug", slug: "login-bug", sessionId });

  await handleUserPromptSubmit(root, { prompt: "确认创建任务", session_id: sessionId });
  const active = await loadSession(root, sessionId);
  expect(active.activeTaskId).toBeTruthy();
  expect(active.pendingTask).toBeUndefined();
  return loadTask(root, active.activeTaskId!);
}

describe("hooks", () => {
  it("does not create a workflow for simple prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "把 div 改成红色", session_id: "s1" });

    expect(output[MEWOFLOW_NOTICE_FIELD]).toBe("猫咪正在监控你的需求喵！");
    expect(String(output.additionalContext)).toContain("MewoFlow prompt judgment");
    expect(String(output.additionalContext)).toContain("simple");
    expect(String(output.additionalContext)).toContain("Ask the user whether this judgment is correct");

    let session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();

    const accepted = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: "s1" });
    expect(String(accepted.additionalContext)).toContain("judgment accepted");
    session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeUndefined();
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();
    await expect(fs.readdir(path.join(root, ".mewoflow", "tasks"))).rejects.toThrow();
  });

  it("does not create a workflow for conversational prompts after init", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "你好", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("simple");

    const session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.activeTaskId).toBeUndefined();

    const stop = await handleStop(root, { session_id: "s1" });
    expect(stop[MEWOFLOW_NOTICE_FIELD]).toBe("猫咪发现任务还没完成喵！");
    expect(String(stop.additionalContext)).toContain("waiting for the user to confirm whether the prompt judgment is correct");
    expect(stop.reason).toBeUndefined();
    expect(stop.decision).toBeUndefined();
  });

  it("does not create a workflow for mewoflow doctor slash prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "/mewoflow-doctor", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("simple");

    const session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.activeTaskId).toBeUndefined();

    const stop = await handleStop(root, { session_id: "s1" });
    expect(stop[MEWOFLOW_NOTICE_FIELD]).toBe("猫咪发现任务还没完成喵！");
    expect(String(stop.additionalContext)).toContain("waiting for the user to confirm whether the prompt judgment is correct");
    expect(stop.reason).toBeUndefined();
    expect(stop.decision).toBeUndefined();
  });

  it("proposes a pending workflow for build-from-scratch product prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "我想创建一个音乐网页", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("猫咪正在监控你的需求喵！");
    expect(String(output.additionalContext)).toContain("MewoFlow prompt judgment");
    expect(String(output.additionalContext)).toContain("Classification: standard");
    expect(String(output.additionalContext)).toContain("Requires workflow: yes");
    expect(String(output.additionalContext)).toContain("猫咪先判断需求喵");
    expect(String(output.additionalContext)).toContain("No pending task has been proposed yet");
    expect(String(output.additionalContext)).toContain("First ask the user whether this judgment is correct");
    expect(String(output.additionalContext)).toContain("Mandatory visible response");
    expect(String(output.additionalContext)).not.toContain("MewoFlow pending task proposed after judgment confirmation");

    let session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();

    const accepted = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: "s1" });
    expect(String(accepted.additionalContext)).toContain("MewoFlow pending task proposed after judgment confirmation");
    expect(String(accepted.additionalContext)).toContain("propose-task");
    expect(String(accepted.additionalContext)).toContain("请确认是否创建任务");

    session = await loadSession(root, "s1");
    expect(session.pendingTask).toBeTruthy();
    expect(session.pendingJudgment).toBeUndefined();
    expect(session.pendingTask!.id).toMatch(/^draft-/);
    expect(session.activeTaskId).toBeUndefined();
    await expect(fs.stat(path.join(root, ".mewoflow", "tasks", session.pendingTask!.id))).rejects.toThrow();
  });

  it("proposes a pending workflow for write-a-webpage prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "帮我写一个音乐播放器网页", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("MewoFlow prompt judgment");
    expect(String(output.additionalContext)).toContain("Classification: standard");
    expect(String(output.additionalContext)).toContain("No pending task has been proposed yet");
    expect(String(output.additionalContext)).toContain("whether this judgment is correct");

    let session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();

    const accepted = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: "s1" });
    expect(String(accepted.additionalContext)).toContain("MewoFlow pending task proposed after judgment confirmation");
    expect(String(accepted.additionalContext)).toContain("propose-task");
    expect(String(accepted.additionalContext)).toContain("请确认是否创建任务");

    session = await loadSession(root, "s1");
    expect(session.pendingTask).toBeTruthy();
    expect(session.pendingJudgment).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();
  });

  it("creates an active workflow only after user confirmation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const proposed = await handleUserPromptSubmit(root, { prompt: "修复登录 bug", session_id: "s1" });
    expect(String(proposed.additionalContext)).toContain("MewoFlow prompt judgment");

    let session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();

    const accepted = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: "s1" });
    expect(String(accepted.additionalContext)).toContain("pending task proposed after judgment confirmation");

    session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeUndefined();
    expect(session.pendingTask).toBeTruthy();

    await proposePendingTask(root, { title: "修复登录 bug", slug: "login-bug", sessionId: "s1" });

    const confirmed = await handleUserPromptSubmit(root, { prompt: "确认创建任务", session_id: "s1" });
    expect(String(confirmed.additionalContext)).toContain("MewoFlow task created after user confirmation");
    expect(String(confirmed.additionalContext)).toContain("Current gate: research");
    expect(String(confirmed.additionalContext)).toContain("Mandatory visible response");
    expect(String(confirmed.additionalContext)).toContain("grill-me");

    const active = await loadSession(root, "s1");
    expect(active.activeTaskId).toBeTruthy();
    expect(active.pendingTask).toBeUndefined();
    const task = await loadTask(root, active.activeTaskId!);
    expect(task.type).toBe("standard");
    expect(task.gate).toBe("research");
  });

  it("keeps pending tasks blocked until the user confirms or cancels", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    await handleUserPromptSubmit(root, { prompt: "开发音乐网站", session_id: "s1" });

    const blockedDuringJudgment = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "pnpm create vite@latest . --template react" },
    });
    expect(JSON.stringify(blockedDuringJudgment)).toContain("deny");
    expect(JSON.stringify(blockedDuringJudgment)).toContain("Pending MewoFlow prompt judgment");

    const waiting = await handleUserPromptSubmit(root, { prompt: "先说一下你会怎么做", session_id: "s1" });
    expect(String(waiting.additionalContext)).toContain("pending prompt judgment awaiting user review");

    const accepted = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: "s1" });
    expect(String(accepted.additionalContext)).toContain("pending task proposed after judgment confirmation");

    const blocked = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "pnpm create vite@latest . --template react" },
    });
    expect(JSON.stringify(blocked)).toContain("deny");
    expect(JSON.stringify(blocked)).toContain("waiting for explicit user confirmation");

    const allowedProposeCommand = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow propose-task --title \"开发音乐网站\" --slug music-site --session s1" },
    });
    expect(JSON.stringify(allowedProposeCommand)).not.toContain("deny");

    const allowedConfirmationCommand = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow check pending-task-confirmation" },
    });
    expect(JSON.stringify(allowedConfirmationCommand)).not.toContain("deny");

    const blockedChainedConfirmation = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow confirm-task && pnpm install" },
    });
    expect(JSON.stringify(blockedChainedConfirmation)).toContain("deny");

    const blockedManualTaskWrite = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "mkdir -p .mewoflow/tasks/manual-task" },
    });
    expect(JSON.stringify(blockedManualTaskWrite)).toContain("deny");

    const repeated = await handleUserPromptSubmit(root, { prompt: "先说一下你会怎么做", session_id: "s1" });
    expect(String(repeated.additionalContext)).toContain("pending task awaiting user confirmation");

    const cancelled = await handleUserPromptSubmit(root, { prompt: "取消，不创建", session_id: "s1" });
    expect(String(cancelled.additionalContext)).toContain("pending task cancelled");
    const session = await loadSession(root, "s1");
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();
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
    expect(String(stop.additionalContext)).toContain("猫咪发现任务还没完成喵！");
    expect(stop.reason).toBeUndefined();
    expect(stop.decision).toBeUndefined();
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

  it("blocks direct file creation without an active task", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));

    const blockedWrite = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Write",
      tool_input: { file_path: "index.html" },
    });
    const blockedText = JSON.stringify(blockedWrite);
    expect(blockedText).toContain("deny");
    expect(blockedText).toContain("No active MewoFlow task");
    expect(blockedText).toContain("Implementation writes");

    const blockedShellWrite = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "echo '<html></html>' > index.html" },
    });
    expect(JSON.stringify(blockedShellWrite)).toContain("deny");
  });

  it("blocks writes before implement and until required files are read", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const task = await createConfirmedTask(root);

    const blockedEarly = await handlePreToolUse(root, { session_id: "s1", tool_name: "Edit", tool_input: { file_path: "src/a.ts" } });
    expect(JSON.stringify(blockedEarly)).toContain("deny");
    expect(JSON.stringify(blockedEarly)).toContain("research -> grill -> plan");
    expect(JSON.stringify(blockedEarly)).toContain("猫咪正在检查工具调用喵！");

    task.gate = "implement";
    await writeFileEnsured(taskFile(root, task.id, "task.json"), JSON.stringify(task, null, 2));

    const blockedWithoutApproval = await handlePreToolUse(root, { session_id: "s1", tool_name: "Edit", tool_input: { file_path: "src/a.ts" } });
    expect(JSON.stringify(blockedWithoutApproval)).toContain("no explicit user plan approval");

    task.gate = "plan";
    await writeFileEnsured(taskFile(root, task.id, "task.json"), JSON.stringify(task, null, 2));
    const approved = await handleUserPromptSubmit(root, { prompt: "同意计划，开始实现", session_id: "s1" });
    expect(String(approved.additionalContext)).toContain("MewoFlow plan approved");

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
    const task = await createConfirmedTask(root);

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
    await createConfirmedTask(root);

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
    expect(session).toEqual({ planApprovals: {}, readFiles: [], searchTools: [], skillUses: [], commands: [] });

    await expect(handleStop(root, { session_id: "s1" })).resolves.toEqual({});
    await expect(readText(file)).resolves.toContain('"readFiles": []');
  });
});
