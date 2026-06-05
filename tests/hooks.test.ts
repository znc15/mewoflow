import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import {
  MEWOFLOW_NOTICE_FIELD,
  handlePostToolUse,
  handlePreToolUse,
  handleStop,
  handleTaskCompleted,
  handleTaskCreated,
  handleTeammateIdle,
  handleUserPromptSubmit,
} from "../src/hooks.js";
import { readText, writeFileEnsured } from "../src/fs.js";
import { loadSession, loadTask, recordReadFile, sessionFile, taskFile } from "../src/task.js";

async function createConfirmedTask(root: string, sessionId = "s1") {
  const judgment = await handleUserPromptSubmit(root, { prompt: "修复登录 bug", session_id: sessionId });
  expect(String(judgment.additionalContext)).toContain("pending judgment");
  let pending = await loadSession(root, sessionId);
  expect(pending.pendingJudgment).toBeTruthy();
  expect(pending.pendingTask).toBeUndefined();
  expect(pending.activeTaskId).toBeUndefined();

  const accepted = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: sessionId });
  expect(String(accepted.additionalContext)).toContain("accept-judgment");
  pending = await loadSession(root, sessionId);
  expect(pending.pendingJudgment).toBeTruthy();
  expect(pending.pendingTask).toBeUndefined();
  expect(pending.activeTaskId).toBeUndefined();

  await expect(main(["accept-judgment", "--classification", "standard", "--session", sessionId], root)).resolves.toBe(0);
  pending = await loadSession(root, sessionId);
  expect(pending.pendingTask).toBeTruthy();
  expect(pending.pendingJudgment).toBeUndefined();
  expect(pending.activeTaskId).toBeUndefined();

  await expect(main(["propose-task", "--title", "修复登录 bug", "--slug", "login-bug", "--session", sessionId], root)).resolves.toBe(0);

  const confirmation = await handleUserPromptSubmit(root, { prompt: "确认创建任务", session_id: sessionId });
  expect(String(confirmation.additionalContext)).toContain("confirm-task");
  await expect(main(["confirm-task", "--session", sessionId], root)).resolves.toBe(0);
  await expect(main(["spec-skip", "--session", sessionId], root)).resolves.toBe(0);
  const active = await loadSession(root, sessionId);
  expect(active.activeTaskId).toBeTruthy();
  expect(active.pendingTask).toBeUndefined();
  return loadTask(root, active.activeTaskId!);
}

describe("hooks", () => {
  it("records new prompt as undetermined and requires classification on accept", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "把 div 改成红色", session_id: "s1" });

    expect(output[MEWOFLOW_NOTICE_FIELD]).toBe("猫咪正在监控你的需求喵！");
    expect(String(output.additionalContext)).toContain("pending judgment");
    expect(String(output.additionalContext)).toContain("undetermined");
    expect(String(output.additionalContext)).toContain("determine whether this request is");

    let session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingJudgment!.classification).toBe("undetermined");
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();

    const accepted = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: "s1" });
    expect(String(accepted.additionalContext)).toContain("accept-judgment");
    session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();

    await expect(main(["accept-judgment", "--classification", "simple", "--session", "s1"], root)).resolves.toBe(0);
    session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeUndefined();
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();
    await expect(fs.readdir(path.join(root, ".mewoflow", "tasks"))).rejects.toThrow();
  });

  it("requires --classification when accepting an undetermined judgment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    await handleUserPromptSubmit(root, { prompt: "随便看看", session_id: "s1" });

    const session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingJudgment!.classification).toBe("undetermined");

    await expect(main(["accept-judgment", "--session", "s1"], root)).resolves.toBe(1);
    const unchanged = await loadSession(root, "s1");
    expect(unchanged.pendingJudgment).toBeTruthy();

    await expect(main(["accept-judgment", "--classification", "simple", "--session", "s1"], root)).resolves.toBe(0);
    const afterAccept = await loadSession(root, "s1");
    expect(afterAccept.pendingJudgment).toBeUndefined();
    expect(afterAccept.pendingTask).toBeUndefined();
    expect(afterAccept.activeTaskId).toBeUndefined();
  });

  it("records undetermined classification for conversational prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "你好", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("undetermined");

    const session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingJudgment!.classification).toBe("undetermined");
    expect(session.activeTaskId).toBeUndefined();

    const stop = await handleStop(root, { session_id: "s1" });
    expect(stop[MEWOFLOW_NOTICE_FIELD]).toBe("猫咪发现任务还没完成喵！");
    expect(String(stop.additionalContext)).toContain("waiting for the user to confirm whether the prompt judgment is correct");
    expect(stop.reason).toBeUndefined();
    expect(stop.decision).toBeUndefined();
  });

  it("records undetermined classification for slash prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "/mewoflow-doctor", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("undetermined");

    const session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingJudgment!.classification).toBe("undetermined");
    expect(session.activeTaskId).toBeUndefined();

    const stop = await handleStop(root, { session_id: "s1" });
    expect(stop[MEWOFLOW_NOTICE_FIELD]).toBe("猫咪发现任务还没完成喵！");
    expect(String(stop.additionalContext)).toContain("waiting for the user to confirm whether the prompt judgment is correct");
    expect(stop.reason).toBeUndefined();
    expect(stop.decision).toBeUndefined();
  });

  it("records undetermined judgment for build-from-scratch product prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "我想创建一个音乐网页", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("猫咪正在监控你的需求喵！");
    expect(String(output.additionalContext)).toContain("pending judgment");
    expect(String(output.additionalContext)).toContain("undetermined");
    expect(String(output.additionalContext)).toContain("determine whether this request is");
    expect(String(output.additionalContext)).toContain("accept-judgment --classification");

    let session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingJudgment!.classification).toBe("undetermined");
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();

    const accepted = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: "s1" });
    expect(String(accepted.additionalContext)).toContain("accept-judgment");

    session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();

    await expect(main(["accept-judgment", "--classification", "standard", "--session", "s1"], root)).resolves.toBe(0);
    session = await loadSession(root, "s1");
    expect(session.pendingTask).toBeTruthy();
    expect(session.pendingJudgment).toBeUndefined();
    expect(session.pendingTask!.id).toMatch(/^draft-/);
    expect(session.activeTaskId).toBeUndefined();
    await expect(fs.stat(path.join(root, ".mewoflow", "tasks", session.pendingTask!.id))).rejects.toThrow();
  });

  it("records undetermined judgment for write-a-webpage prompts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const output = await handleUserPromptSubmit(root, { prompt: "帮我写一个音乐播放器网页", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("pending judgment");
    expect(String(output.additionalContext)).toContain("undetermined");
    expect(String(output.additionalContext)).toContain("determine whether this request is");

    let session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();

    const accepted = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: "s1" });
    expect(String(accepted.additionalContext)).toContain("accept-judgment");

    session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();

    await expect(main(["accept-judgment", "--classification", "standard", "--session", "s1"], root)).resolves.toBe(0);
    session = await loadSession(root, "s1");
    expect(session.pendingTask).toBeTruthy();
    expect(session.pendingJudgment).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();
  });

  it("does not infer bare judgment approval or task confirmation replies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    await handleUserPromptSubmit(root, { prompt: "我想创建一个网页播放器，使用网易云的音乐", session_id: "s1" });

    const accepted = await handleUserPromptSubmit(root, { prompt: "正确", session_id: "s1" });
    expect(String(accepted.additionalContext)).toContain("accept-judgment");

    let session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();

    await expect(main(["accept-judgment", "--classification", "standard", "--session", "s1"], root)).resolves.toBe(0);
    await expect(main(["propose-task", "--title", "网易云网页音乐播放器", "--slug", "netease-web-music-player", "--session", "s1"], root)).resolves.toBe(0);

    const confirmed = await handleUserPromptSubmit(root, { prompt: "确认", session_id: "s1" });
    expect(String(confirmed.additionalContext)).toContain("confirm-task");

    session = await loadSession(root, "s1");
    expect(session.pendingTask).toBeTruthy();
    expect(session.activeTaskId).toBeUndefined();

    await expect(main(["confirm-task", "--session", "s1"], root)).resolves.toBe(0);
    await expect(main(["spec-skip", "--session", "s1"], root)).resolves.toBe(0);
    session = await loadSession(root, "s1");
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeTruthy();
  });

  it("creates an active workflow only after user confirmation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const proposed = await handleUserPromptSubmit(root, { prompt: "修复登录 bug", session_id: "s1" });
    expect(String(proposed.additionalContext)).toContain("pending judgment");

    let session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();

    const accepted = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: "s1" });
    expect(String(accepted.additionalContext)).toContain("accept-judgment");

    session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();

    await expect(main(["accept-judgment", "--classification", "standard", "--session", "s1"], root)).resolves.toBe(0);
    await expect(main(["propose-task", "--title", "修复登录 bug", "--slug", "login-bug", "--session", "s1"], root)).resolves.toBe(0);

    const confirmed = await handleUserPromptSubmit(root, { prompt: "确认创建任务", session_id: "s1" });
    expect(String(confirmed.additionalContext)).toContain("confirm-task");

    session = await loadSession(root, "s1");
    expect(session.pendingTask).toBeTruthy();
    expect(session.activeTaskId).toBeUndefined();

    await expect(main(["confirm-task", "--session", "s1"], root)).resolves.toBe(0);
    await expect(main(["spec-skip", "--session", "s1"], root)).resolves.toBe(0);
    const activeContext = await handleUserPromptSubmit(root, { prompt: "继续", session_id: "s1" });
    expect(String(activeContext.additionalContext)).toContain("Current gate: research");
    expect(String(activeContext.additionalContext)).toContain("Mandatory visible response");
    expect(String(activeContext.additionalContext)).toContain("grill-me");

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
    expect(String(waiting.additionalContext)).toContain("pending prompt judgment awaiting command-driven user review");

    const accepted = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: "s1" });
    expect(String(accepted.additionalContext)).toContain("accept-judgment");

    const blockedProposeDuringJudgment = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow propose-task --title \"开发音乐网站\" --slug music-site --session s1" },
    });
    expect(JSON.stringify(blockedProposeDuringJudgment)).toContain("deny");
    expect(JSON.stringify(blockedProposeDuringJudgment)).toContain("Pending MewoFlow prompt judgment");

    const allowedAcceptJudgmentCommand = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow accept-judgment --classification standard --session s1" },
    });
    expect(JSON.stringify(allowedAcceptJudgmentCommand)).not.toContain("deny");

    await expect(main(["accept-judgment", "--classification", "standard", "--session", "s1"], root)).resolves.toBe(0);

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
    await expect(main(["propose-task", "--title", "开发音乐网站", "--slug", "music-site", "--session", "s1"], root)).resolves.toBe(0);

    const allowedConfirmationCommand = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow confirm-task --session s1" },
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
    expect(String(cancelled.additionalContext)).toContain("cancel-task");
    let session = await loadSession(root, "s1");
    expect(session.pendingTask).toBeTruthy();
    expect(session.activeTaskId).toBeUndefined();

    const allowedCancelCommand = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow cancel-task --session s1" },
    });
    expect(JSON.stringify(allowedCancelCommand)).not.toContain("deny");
    await expect(main(["cancel-task", "--session", "s1"], root)).resolves.toBe(0);

    session = await loadSession(root, "s1");
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();
  });

  it("routes git commit prompts to the controlled commit command without creating workflow state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));

    const output = await handleUserPromptSubmit(root, { prompt: "提交", session_id: "s1" });

    expect(String(output.additionalContext)).toContain("MewoFlow git commit request detected");
    expect(String(output.additionalContext)).toContain("npx mewoflow commit");
    const session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeUndefined();
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();

    const allowedCommit = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow commit --message \"chore: test\" --dry-run" },
    });
    expect(JSON.stringify(allowedCommit)).not.toContain("deny");
  });

  it("allows controlled update maintenance commands during pending judgment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    await handleUserPromptSubmit(root, { prompt: "修复登录 bug", session_id: "s1" });

    const allowedUpdate = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow update --dry-run" },
    });
    expect(JSON.stringify(allowedUpdate)).not.toContain("deny");

    const blockedChainedUpdate = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow update && pnpm install" },
    });
    expect(JSON.stringify(blockedChainedUpdate)).toContain("deny");
  });

  it("allows controlled rework and deferred-risk commands without allowing chained work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const task = await createConfirmedTask(root);

    task.gate = "review";
    await writeFileEnsured(taskFile(root, task.id, "task.json"), JSON.stringify(task, null, 2));

    const allowedRework = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow rework --reason \"review found high severity issue\" --session s1" },
    });
    expect(JSON.stringify(allowedRework)).not.toContain("deny");

    const blockedChainedRework = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow rework --reason \"review found issue\" --session s1 && pnpm install" },
    });
    expect(JSON.stringify(blockedChainedRework)).toContain("deny");

    task.gate = "archive";
    await writeFileEnsured(taskFile(root, task.id, "task.json"), JSON.stringify(task, null, 2));

    const allowedDeferredRisk = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow approve-deferred-risk --reason \"user accepted known risk\" --session s1" },
    });
    expect(JSON.stringify(allowedDeferredRisk)).not.toContain("deny");
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

    const blockedEdit = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Edit",
      tool_input: { file_path: "src/a.ts" },
    });
    const blockedEditText = JSON.stringify(blockedEdit);
    expect(blockedEditText).toContain("deny");
    expect(blockedEditText).toContain("No active MewoFlow task");
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
    const approved = await handleUserPromptSubmit(root, { prompt: "这个计划可以按你的判断推进", session_id: "s1" });
    expect(String(approved.additionalContext)).toContain("approve-plan");
    expect(String(approved.additionalContext)).not.toContain("MewoFlow plan approved");
    await expect(main(["approve-plan", "--prompt", "这个计划可以按你的判断推进", "--session", "s1"], root)).resolves.toBe(0);

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

    const blockedChainedCommand = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: `Set-Content .mewoflow/tasks/${task.id}/grill.md 'ok' && pnpm install` },
    });
    const blockedChainedText = JSON.stringify(blockedChainedCommand);
    expect(blockedChainedText).toContain("deny");
    expect(blockedChainedText).toContain("single safe write");

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

    const blockedCi = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npm ci 2>&1" },
    });
    expect(JSON.stringify(blockedCi)).toContain("deny");

    const blockedTouch = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "touch src/generated.ts" },
    });
    expect(JSON.stringify(blockedTouch)).toContain("deny");

    const blocked = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "echo ok > report.txt" },
    });
    expect(JSON.stringify(blocked)).toContain("deny");
  });

  it("accepts default-session implementation reads for a non-default hook session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const task = await createConfirmedTask(root);

    task.gate = "plan";
    await writeFileEnsured(taskFile(root, task.id, "task.json"), JSON.stringify(task, null, 2));
    await expect(main(["approve-plan", "--prompt", "approved from default session"], root)).resolves.toBe(0);

    task.gate = "implement";
    await writeFileEnsured(taskFile(root, task.id, "task.json"), JSON.stringify(task, null, 2));

    for (const file of [
      ".mewoflow/rules.md",
      `.mewoflow/tasks/${task.id}/research.md`,
      `.mewoflow/tasks/${task.id}/grill.md`,
      `.mewoflow/tasks/${task.id}/plan.md`,
    ]) {
      await recordReadFile(root, "default", file);
    }

    const allowed = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Edit",
      tool_input: { file_path: "src/a.ts" },
    });
    expect(JSON.stringify(allowed)).not.toContain("deny");
  });

  it("guides agent team hooks by active gate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const task = await createConfirmedTask(root, "team-s1");

    task.gate = "implement";
    await writeFileEnsured(taskFile(root, task.id, "task.json"), JSON.stringify(task, null, 2));

    const idle = await handleTeammateIdle(root, { session_id: "team-s1" });
    expect(String(idle.additionalContext)).toContain("implement");
    expect(String(idle.additionalContext)).toContain("do not run mewoflow check");

    const created = await handleTaskCreated(root, { session_id: "team-s1" });
    expect(String(created.additionalContext)).toContain("non-overlapping");
    expect(String(created.additionalContext)).toContain("implement");

    const completed = await handleTaskCompleted(root, { session_id: "team-s1" });
    expect(String(completed.additionalContext)).toContain("Lead merges");
    expect(String(completed.additionalContext)).toContain("do not run mewoflow check");
  });

  it("recovers from corrupted session JSON without crashing stop", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-hooks-"));
    const file = sessionFile(root, "s1");
    await writeFileEnsured(file, '{"activeTaskId":"broken"} trailing');

    const session = await loadSession(root, "s1");
    expect(session).toEqual({
      planApprovals: {},
      archiveApprovals: {},
      specDecisions: {},
      readFiles: [],
      searchTools: [],
      skillUses: [],
      commands: [],
    });

    await expect(handleStop(root, { session_id: "s1" })).resolves.toEqual({});
    await expect(readText(file)).resolves.toContain('"readFiles": []');
    const sessionFiles = await fs.readdir(path.dirname(file));
    expect(sessionFiles.some((entry) => entry.startsWith("s1.json.corrupt-"))).toBe(true);
  });
});
