import {
  createTask,
  getActiveTask,
  getActiveTaskId,
  loadSession,
  normalizePath,
  recordCommand,
  recordReadFile,
  recordSearchTool,
  requiredImplementationReads,
  setActiveTask,
  type TaskType,
  type Task,
} from "./task.js";

export type HookInput = {
  prompt?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

export type PromptClassification = "simple" | TaskType;

export function classifyPrompt(prompt: string): PromptClassification {
  if (/系统|平台|架构|工具集|大型重构|workflow|agent/i.test(prompt)) return "epic";
  if (/bug|修复|新增|添加|API|依赖|测试|登录/i.test(prompt)) return "standard";
  if (/颜色|文案|typo|样式|小改动|margin|padding|div/i.test(prompt)) return "simple";
  return "standard";
}

export async function handleUserPromptSubmit(root: string, input: HookInput): Promise<Record<string, unknown>> {
  const prompt = input.prompt ?? "";
  const sessionId = input.session_id ?? "default";
  const activeTask = await getActiveTask(root, sessionId);

  if (activeTask && activeTask.gate !== "done") {
    return promptContext(
      [
        `MewoFlow active task: ${activeTask.id}`,
        `Type: ${activeTask.type}`,
        `Current gate: ${activeTask.gate}`,
        "Continue the current gate. Do not create a new task or skip ahead.",
      ].join("\n"),
    );
  }

  const classification = classifyPrompt(prompt);

  if (classification === "simple") {
    return promptContext("MewoFlow: simple request detected. Full workflow is not required.");
  }

  const title = prompt.split(/[。.!?\r\n]/)[0]?.trim() || "MewoFlow Task";
  const task = await createTask(root, { title, type: classification });
  await setActiveTask(root, task.id, sessionId);

  return promptContext(
    [
      `MewoFlow task created: ${task.id}`,
      `Type: ${task.type}`,
      `Current gate: ${task.gate}`,
      "Normal flow must complete: research -> grill -> plan -> implement -> verify -> archive.",
      "Next action: use Claude Code WebSearch/WebFetch/MCP search or user-provided sources, then write .mewoflow/tasks/<task>/research.md and run `mewoflow check research`.",
      "Do not grill, plan, edit code, verify, archive, or claim completion before the current gate passes.",
    ].join("\n"),
  );
}

export async function handlePreToolUse(root: string, input: HookInput): Promise<Record<string, unknown>> {
  const tool = input.tool_name ?? "";
  const target = normalizePath(String(input.tool_input?.file_path ?? input.tool_input?.path ?? ""), root);
  const command = String(input.tool_input?.command ?? "");

  if (isProtectedTarget(target) || isProtectedCommand(command)) {
    return deny("MewoFlow protected state files can only be changed by the mewoflow CLI.");
  }

  if (!isWriteAttempt(tool, command)) return allowPreToolUse();

  const task = await getActiveTask(root, input.session_id ?? "default");
  if (!task) return allowPreToolUse();

  if (isActiveTaskEvidenceTarget(target, task) || isActiveTaskEvidenceCommand(command, task)) {
    return allowPreToolUse();
  }

  if (task.gate !== "implement") {
    return deny(`Current MewoFlow gate is ${task.gate}. Editing is blocked until the implement gate.`);
  }

  const session = await loadSession(root, input.session_id ?? "default");
  const missingReads = requiredImplementationReads(task).filter((file) => !session.readFiles.includes(normalizePath(file)));
  if (missingReads.length > 0) {
    return deny(`Read required MewoFlow context before editing: ${missingReads.join(", ")}`);
  }

  return allowPreToolUse();
}

export async function handlePostToolUse(root: string, input: HookInput): Promise<Record<string, unknown>> {
  const sessionId = input.session_id ?? "default";
  const tool = input.tool_name ?? "";
  const target = String(input.tool_input?.file_path ?? input.tool_input?.path ?? "");
  const command = String(input.tool_input?.command ?? "");

  if (isReadTool(tool) && target) await recordReadFile(root, sessionId, target);
  if (isSearchTool(tool)) await recordSearchTool(root, sessionId, tool);
  if (tool === "Bash" && command) await recordCommand(root, sessionId, command);

  return { hookSpecificOutput: { hookEventName: "PostToolUse" } };
}

export async function handleStop(root: string, input: HookInput): Promise<Record<string, unknown>> {
  const taskId = await getActiveTaskId(root, input.session_id ?? "default");
  if (!taskId) return {};
  const task = await getActiveTask(root, input.session_id ?? "default");
  if (!task || task.gate === "done") return {};
  return {
    decision: "block",
    reason: `MewoFlow task ${task.id} is not complete. Current gate: ${task.gate}. Continue the required workflow instead of claiming completion.`,
  };
}

function promptContext(additionalContext: string): Record<string, unknown> {
  return {
    additionalContext,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

function deny(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function allowPreToolUse(): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "PreToolUse" } };
}

function isReadTool(tool: string): boolean {
  return /^(Read|ReadFile|NotebookRead)$/i.test(tool);
}

function isSearchTool(tool: string): boolean {
  return /WebSearch|WebFetch|MCP|mcp__|context7|exa|tavily|firecrawl/i.test(tool);
}

function isWriteAttempt(tool: string, command: string): boolean {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/i.test(tool)) return true;
  if (tool !== "Bash") return false;
  return /\b(rm|mv|cp|del|erase|ren|mkdir|new-item|ni|set-content|add-content|out-file)\b|>|npm\s+install|pnpm\s+add|yarn\s+add/i.test(
    command,
  );
}

function isProtectedTarget(target: string): boolean {
  return /^\.mewoflow\/tasks\/.*\/task\.json$/.test(target) || target.startsWith(".mewoflow/runtime/");
}

function isProtectedCommand(command: string): boolean {
  return /\.mewoflow[\\/]tasks[\\/].*[\\/]task\.json|\.mewoflow[\\/]runtime/i.test(command);
}

function isActiveTaskEvidenceTarget(target: string, task: Task): boolean {
  const base = `.mewoflow/tasks/${task.id}/`;
  return evidenceMarkdownFiles().some((file) => target === `${base}${file}`);
}

function isActiveTaskEvidenceCommand(command: string, task: Task): boolean {
  const normalized = command.replace(/\\/g, "/");
  const base = `.mewoflow/tasks/${task.id}/`;
  return evidenceMarkdownFiles().some((file) => normalized.includes(`${base}${file}`));
}

function evidenceMarkdownFiles(): string[] {
  return ["research.md", "grill.md", "plan.md", "verify.md", "archive.md"];
}
