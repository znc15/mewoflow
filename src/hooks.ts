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

export const MEWOFLOW_NOTICE_FIELD = "mewoflowNotice";

export function classifyPrompt(prompt: string): PromptClassification {
  if (isMinorEditPrompt(prompt)) return "simple";
  if (isMetaPrompt(prompt)) return "simple";
  if (isEpicPrompt(prompt)) return "epic";
  if (isWorkflowTaskPrompt(prompt)) {
    return "standard";
  }
  return "simple";
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
        "Required gate order: research -> grill -> plan -> implement -> verify -> archive.",
        nextActionForGate(activeTask),
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
      "After research passes, complete grill.md and run `mewoflow check grill`; only then write plan.md and run `mewoflow check plan`.",
      "Do not run package scaffolding, install dependencies, edit code, verify, archive, or claim completion before the required gate passes.",
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
  if (!task || task.gate === "done") {
    return hasPackageManagerWriteCommand(command) ? deny(noActiveTaskWriteReason()) : allowPreToolUse();
  }

  if (isActiveTaskEvidenceTarget(target, task) || isActiveTaskEvidenceCommand(command, task)) {
    return allowPreToolUse();
  }

  if (task.gate !== "implement") {
    return deny(writeBlockedReason(task));
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

  return eventOutput("PostToolUse");
}

export async function handleStop(root: string, input: HookInput): Promise<Record<string, unknown>> {
  const taskId = await getActiveTaskId(root, input.session_id ?? "default");
  if (!taskId) return {};
  const task = await getActiveTask(root, input.session_id ?? "default");
  if (!task || task.gate === "done") return {};
  const notice = hookNotice("Stop");
  return {
    [MEWOFLOW_NOTICE_FIELD]: notice,
    additionalContext: notice,
    decision: "block",
    reason: `${notice} MewoFlow task ${task.id} is not complete. Current gate: ${task.gate}. Continue the required workflow instead of claiming completion.`,
  };
}

function promptContext(additionalContext: string): Record<string, unknown> {
  const notice = hookNotice("UserPromptSubmit");
  const context = `${notice}\n${additionalContext}`;
  return {
    [MEWOFLOW_NOTICE_FIELD]: notice,
    additionalContext: context,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  };
}

function deny(reason: string): Record<string, unknown> {
  const notice = hookNotice("PreToolUse");
  const context = `${notice}\n${reason}`;
  return {
    [MEWOFLOW_NOTICE_FIELD]: notice,
    additionalContext: context,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${notice} ${reason}`,
    },
  };
}

function allowPreToolUse(): Record<string, unknown> {
  return eventOutput("PreToolUse");
}

function eventOutput(event: "PreToolUse" | "PostToolUse"): Record<string, unknown> {
  const notice = hookNotice(event);
  return {
    [MEWOFLOW_NOTICE_FIELD]: notice,
    additionalContext: notice,
    hookSpecificOutput: { hookEventName: event },
  };
}

function hookNotice(event: "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop"): string {
  return event === "UserPromptSubmit"
    ? "猫咪正在监控你的需求喵！"
    : event === "PreToolUse"
      ? "猫咪正在检查工具调用喵！"
      : event === "PostToolUse"
        ? "猫咪已记录工具结果喵！"
        : "猫咪发现任务还没完成喵！";
}

function noActiveTaskWriteReason(): string {
  return [
    "No active MewoFlow task. Package scaffolding or dependency changes are blocked until a workflow task is active.",
    "Start or resume MewoFlow with `/mewoflow`, then follow research -> grill -> plan before running scaffolding or install commands.",
  ].join(" ");
}

function writeBlockedReason(task: Task): string {
  if (task.gate === "research" || task.gate === "grill" || task.gate === "plan") {
    return [
      `Current MewoFlow gate is ${task.gate}. Finish research -> grill -> plan before editing or running package scaffolding.`,
      nextActionForGate(task),
      "Do not create projects, install dependencies, or edit implementation files until the implement gate.",
    ].join(" ");
  }

  return [
    `Current MewoFlow gate is ${task.gate}. Editing is allowed only during the implement gate.`,
    nextActionForGate(task),
  ].join(" ");
}

function nextActionForGate(task: Task): string {
  const base = `.mewoflow/tasks/${task.id}`;
  if (task.gate === "research") {
    return `Next action: complete ${base}/research.md with search or user-provided-source evidence, then run \`mewoflow check research\`; after that, complete grill before plan or implementation.`;
  }
  if (task.gate === "grill") {
    return `Next action: ask and record critical clarifying questions in ${base}/grill.md, including Recommended Answer, User Answer, Decision, and Acceptance Criteria; then run \`mewoflow check grill\`.`;
  }
  if (task.gate === "plan") {
    return `Next action: write ${base}/plan.md with goal, scope, steps, and verification; then run \`mewoflow check plan\`.`;
  }
  if (task.gate === "implement") {
    return `Next action: read .mewoflow/rules.md plus ${base}/research.md, grill.md, and plan.md before editing.`;
  }
  if (task.gate === "verify") {
    return `Next action: record verification evidence in ${base}/verify.md and run \`mewoflow check verify\`.`;
  }
  if (task.gate === "archive") {
    return `Next action: summarize decisions and verification in ${base}/archive.md and run \`mewoflow check archive\`.`;
  }
  return "Next action: start a new MewoFlow task before more implementation work.";
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
  return (
    /\b(rm|mv|cp|del|erase|ren|mkdir|new-item|ni|set-content|add-content|out-file)\b/i.test(command) ||
    hasPackageManagerWriteCommand(command) ||
    hasShellWriteRedirection(command)
  );
}

function isEpicPrompt(prompt: string): boolean {
  return /系统|平台|架构|工具集|大型重构|workflow|agent/i.test(prompt);
}

function isMinorEditPrompt(prompt: string): boolean {
  return /颜色|文案|typo|样式|小改动|margin|padding|div/i.test(prompt);
}

function isWorkflowTaskPrompt(prompt: string): boolean {
  return isBuildFromScratchPrompt(prompt) || /修复|新增|添加|实现|开发|构建|重构|接入|集成|排查|定位|优化|升级|迁移|发布|提交|安装|依赖|测试|bug|API|接口|登录|页面|组件|脚本|数据库|hook|功能/i.test(prompt);
}

function isBuildFromScratchPrompt(prompt: string): boolean {
  return /创建|做|搭建|生成|开发|从零开始|新建/i.test(prompt) && /网页|网站|应用|项目|播放器|前端|后台|管理系统|博客|官网|小程序|工具|客户端|服务端|管理台|页面/i.test(prompt);
}

function hasPackageManagerWriteCommand(command: string): boolean {
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|create|init)\b/i.test(command) ||
    /\b(?:pnpm|yarn)\s+dlx\b/i.test(command) ||
    /\bnpm\s+exec\b/i.test(command) ||
    /\bnpx\s+create[-\w./@]*\b/i.test(command)
  );
}

function isMetaPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return /^\/mewoflow(?:-[a-z0-9-]+)?\b/i.test(trimmed) || /^mewoflow\s+(doctor|status|help|version|init|check|hook)\b/i.test(trimmed);
}

function hasShellWriteRedirection(command: string): boolean {
  return /(^|\s)(?:\d{0,2})?>>?(?!&)/.test(command);
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
