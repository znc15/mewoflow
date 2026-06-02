import {
  approvePlan,
  clearPendingJudgment,
  clearPendingTask,
  confirmPendingTask,
  createPendingTask,
  getActiveTask,
  hasPlanApproval,
  loadSession,
  normalizePath,
  recordCommand,
  recordReadFile,
  recordSearchTool,
  recordSkillUse,
  requiredImplementationReads,
  setPendingJudgment,
  setPendingTask,
  type TaskType,
  type Task,
  type PendingTask,
  type PendingJudgment,
} from "./task.js";

export type HookInput = {
  prompt?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

export type PromptClassification = "simple" | TaskType;

export type PromptJudgment = {
  classification: PromptClassification;
  requiresWorkflow: boolean;
  reason: string;
};

export const MEWOFLOW_NOTICE_FIELD = "mewoflowNotice";

export function classifyPrompt(prompt: string): PromptClassification {
  return judgePrompt(prompt).classification;
}

export function judgePrompt(prompt: string): PromptJudgment {
  if (isMinorEditPrompt(prompt)) {
    return {
      classification: "simple",
      requiresWorkflow: false,
      reason: "minor edit request; no full research/grill/plan workflow is required unless implementation writes escalate.",
    };
  }
  if (isMetaPrompt(prompt)) {
    return {
      classification: "simple",
      requiresWorkflow: false,
      reason: "MewoFlow meta/status command or slash prompt; do not create a workflow task.",
    };
  }
  if (isEpicPrompt(prompt)) {
    return {
      classification: "epic",
      requiresWorkflow: true,
      reason: "broad system/platform/architecture request; use a parent epic before child implementation tasks.",
    };
  }
  if (isWorkflowTaskPrompt(prompt)) {
    return {
      classification: "standard",
      requiresWorkflow: true,
      reason: "development or implementation request; create only a pending task proposal until the user confirms.",
    };
  }
  return {
    classification: "simple",
    requiresWorkflow: false,
    reason: "no workflow intent detected from the prompt; PreToolUse still blocks new implementation writes without an active task.",
  };
}

export async function handleUserPromptSubmit(root: string, input: HookInput): Promise<Record<string, unknown>> {
  const prompt = input.prompt ?? "";
  const sessionId = input.session_id ?? "default";
  const session = await loadSession(root, sessionId);

  if (isGitCommitPrompt(prompt)) {
    return promptContext(
      [
        "MewoFlow git commit request detected.",
        "Do not create a workflow task for this prompt.",
        "Mandatory next tool action: run `npx mewoflow commit --message \"<concise summary>\"`.",
        "The command will refuse likely secret files, stage current git changes, and create a local commit only; do not push unless the user explicitly asks.",
      ].join("\n"),
    );
  }

  if (session.pendingTask && !session.activeTaskId) {
    return handlePendingPrompt(root, sessionId, prompt, session.pendingTask);
  }

  if (session.pendingJudgment && !session.activeTaskId) {
    return handlePendingJudgmentPrompt(root, sessionId, prompt, session.pendingJudgment);
  }

  const activeTask = await getActiveTask(root, sessionId);

  if (activeTask && activeTask.gate !== "done") {
    if (activeTask.gate === "plan" && isPlanApprovalPrompt(prompt)) {
      await approvePlan(root, activeTask.id, sessionId, prompt);
      return promptContext(
        [
          `MewoFlow plan approved: ${activeTask.id}`,
          `Current gate: ${activeTask.gate}`,
          visibleTaskNotice(`MewoFlow plan approved: ${activeTask.id}`, activeTask.gate),
          "User explicitly approved the plan. The next `mewoflow check plan` may advance to implement.",
          "After the plan gate passes, read required MewoFlow context before implementation writes.",
        ].join("\n"),
      );
    }

    return promptContext(
      [
        `MewoFlow active task: ${activeTask.id}`,
        `Type: ${activeTask.type}`,
        `Current gate: ${activeTask.gate}`,
        visibleTaskNotice(`MewoFlow active task: ${activeTask.id}`, activeTask.gate),
        "Continue the current gate. Do not create a new task or skip ahead.",
        "Required gate order: research -> grill -> plan -> implement -> verify -> review -> verify -> archive.",
        nextActionForGate(activeTask),
      ].join("\n"),
    );
  }

  if (session.pendingTask) {
    return handlePendingPrompt(root, sessionId, prompt, session.pendingTask);
  }

  if (session.pendingJudgment) {
    return handlePendingJudgmentPrompt(root, sessionId, prompt, session.pendingJudgment);
  }

  const judgment = judgePrompt(prompt);
  const classification = judgment.classification;
  await setPendingJudgment(root, { ...judgment, prompt, created_at: new Date().toISOString() }, sessionId);

  if (classification === "simple") {
    return promptContext(
      [
        ...promptJudgmentLines(judgment),
        visibleJudgmentNotice(judgment),
        "MewoFlow: simple request detected. Full workflow is not required if the user agrees with this judgment.",
        "Ask the user whether this judgment is correct before doing work. If they disagree, ask them to clarify whether this should be standard or epic.",
      ].join("\n"),
    );
  }

  return promptContext(
    [
      ...promptJudgmentLines(judgment),
      visibleJudgmentNotice(judgment),
      "No pending task has been proposed yet. First ask the user whether this judgment is correct.",
      "If the user agrees with the judgment, then run `npx mewoflow propose-task --title \"<model title>\" --slug \"descriptive-kebab-slug\"` and ask whether to create the task.",
      "If the user says the judgment is wrong, ask them to correct it before proposing or creating any task.",
      "Do not start research, ask requirements, write task files, scaffold, install dependencies, or edit code before judgment review and task confirmation.",
    ].join("\n"),
  );
}

export async function handlePreToolUse(root: string, input: HookInput): Promise<Record<string, unknown>> {
  const sessionId = input.session_id ?? "default";
  const tool = input.tool_name ?? "";
  const target = normalizePath(String(input.tool_input?.file_path ?? input.tool_input?.path ?? ""), root);
  const command = String(input.tool_input?.command ?? "");
  const writeAttempt = isWriteAttempt(tool, command);

  if (isControlledGitCommitCommand(command)) {
    return allowPreToolUse();
  }

  if (isControlledMewoFlowCommand(command)) {
    const session = await loadSession(root, sessionId);
    if (session.pendingJudgment && !session.activeTaskId) return deny(pendingJudgmentWriteReason(session.pendingJudgment));
    return allowPreToolUse();
  }

  if (writeAttempt && isProtectedTarget(target)) {
    return deny("MewoFlow protected state files can only be changed by the mewoflow CLI.");
  }

  if (!writeAttempt) return allowPreToolUse();

  const session = await loadSession(root, sessionId);
  if (session.pendingJudgment && !session.activeTaskId) return deny(pendingJudgmentWriteReason(session.pendingJudgment));
  if (session.pendingTask && !session.activeTaskId) return deny(pendingTaskWriteReason(session.pendingTask.id));
  const task = await getActiveTask(root, sessionId);
  if (!task || task.gate === "done") {
    if (session.pendingTask) return deny(pendingTaskWriteReason(session.pendingTask.id));
    return requiresWorkflowWithoutActiveTask(tool, command) ? deny(noActiveTaskWriteReason()) : allowPreToolUse();
  }

  if (isActiveTaskEvidenceTarget(target, task) || isActiveTaskEvidenceCommand(command, task)) {
    return allowPreToolUse();
  }

  if (isProtectedWriteCommand(command)) {
    return deny("MewoFlow protected state files can only be changed by the mewoflow CLI.");
  }

  if (task.gate !== "implement") {
    return deny(writeBlockedReason(task));
  }

  let approved = hasPlanApproval(session, task.id);
  if (!approved) {
    const hookSessionId = input.session_id ?? "default";
    if (hookSessionId !== "default") {
      const defaultSession = await loadSession(root, "default");
      approved = hasPlanApproval(defaultSession, task.id);
    }
  }
  if (!approved) {
    return deny(`MewoFlow task ${task.id} is at implement gate, but no explicit user plan approval is recorded. Show the plan and wait for user approval before scaffolding or editing. If plan was approved via \`mewoflow approve-plan\` without --session, the approval is in the default session.`);
  }

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
  const warnings: string[] = [];

  if (isReadTool(tool) && target) await recordHookEvidence(warnings, "read file", () => recordReadFile(root, sessionId, target));
  if (isSearchTool(tool)) await recordHookEvidence(warnings, "search tool", () => recordSearchTool(root, sessionId, tool));
  if (isSkillTool(tool)) await recordHookEvidence(warnings, "skill use", () => recordSkillUse(root, sessionId, skillName(input) ?? tool));
  if (tool === "Bash" && command) await recordHookEvidence(warnings, "bash command", () => recordCommand(root, sessionId, command));

  return eventOutput("PostToolUse", warnings.length > 0 ? `MewoFlow warning: ${warnings.join("; ")}` : undefined);
}

export async function handleStop(root: string, input: HookInput): Promise<Record<string, unknown>> {
  const sessionId = input.session_id ?? "default";
  const session = await loadSession(root, sessionId);
  const task = await getActiveTask(root, sessionId);
  if (session.pendingJudgment && !session.pendingTask && (!task || task.gate === "done")) {
    const notice = hookNotice("Stop");
    return {
      [MEWOFLOW_NOTICE_FIELD]: notice,
      additionalContext: `${notice}\nMewoFlow is waiting for the user to confirm whether the prompt judgment is correct. It is OK to stop; do not create a task or implement yet.`,
    };
  }
  if (session.pendingTask && (!task || task.gate === "done")) {
    const notice = hookNotice("Stop");
    return {
      [MEWOFLOW_NOTICE_FIELD]: notice,
      additionalContext: notice,
    };
  }

  if (!task || task.gate === "done") return {};
  const notice = hookNotice("Stop");
  if (task.gate === "grill" || task.gate === "plan") {
    return {
      [MEWOFLOW_NOTICE_FIELD]: notice,
      additionalContext: `${notice}\nMewoFlow task ${task.id} is waiting at ${task.gate}. It is OK to stop when waiting for user answers or explicit plan approval; do not claim completion.`,
    };
  }
  return {
    [MEWOFLOW_NOTICE_FIELD]: notice,
    additionalContext: notice,
    decision: "block",
    reason: `${notice} MewoFlow task ${task.id} is not complete. Current gate: ${task.gate}. Continue the required workflow instead of claiming completion.`,
  };
}

async function handlePendingPrompt(root: string, sessionId: string, prompt: string, pendingTask: PendingTask): Promise<Record<string, unknown>> {
  if (isTaskRejectionPrompt(prompt)) {
    await clearPendingTask(root, sessionId);
    return promptContext(`MewoFlow pending task cancelled: ${pendingTask.id}. No workflow task was created.`);
  }

  if (isTaskConfirmationPrompt(prompt)) {
    const task = await confirmPendingTask(root, sessionId);
    if (task) {
      return promptContext(
        [
          `MewoFlow task created after user confirmation: ${task.id}`,
          `Type: ${task.type}`,
          `Current gate: ${task.gate}`,
          visibleTaskNotice(`MewoFlow task created after user confirmation: ${task.id}`, task.gate),
          "Normal flow must complete: research -> grill -> plan -> implement -> verify -> review -> verify -> archive.",
          "Next action: complete research with Tool Evidence from WebSearch/WebFetch/MCP/skill or user-provided-source evidence, then run `mewoflow check research`.",
          "Do not skip direct project-local grill-me usage, plan shortcut scan, plan approval, implementation context reads, verify, or archive.",
        ].join("\n"),
      );
    }

    return promptContext(
      [
        `MewoFlow pending task ${pendingTask.id} was confirmed by the user, but no model-proposed title/slug has been recorded yet.`,
        `Type: ${pendingTask.type}`,
        `Draft title: ${pendingTask.title}`,
        "Do not manually create task files.",
        `Mandatory next tool actions: run \`npx mewoflow propose-task --title \"<model title>\" --slug \"descriptive-kebab-slug\" --session ${sessionId}\`, then run \`npx mewoflow confirm-task --session ${sessionId}\`.`,
      ].join("\n"),
    );
  }

  return promptContext(
    [
      `MewoFlow pending task awaiting user confirmation: ${pendingTask.id}`,
      `Type: ${pendingTask.type}`,
      `Draft title: ${pendingTask.title}`,
      pendingTask.proposedTitle ? `Proposed title: ${pendingTask.proposedTitle}` : "Proposed title: not recorded yet",
      pendingTask.proposedSlug ? `Proposed slug: ${pendingTask.proposedSlug}` : "Proposed slug: not recorded yet",
      visiblePendingTaskNotice(pendingTask, sessionId),
      "Do not create task files, research, grill, plan, scaffold, install dependencies, or edit code until the user explicitly confirms task creation.",
      "If proposed title/slug are missing, run `npx mewoflow propose-task --title \"<model title>\" --slug \"descriptive-kebab-slug\"` before asking for or consuming confirmation.",
      "If confirmation was collected through a structured question, run `npx mewoflow confirm-task` only after `propose-task`. Never create `.mewoflow/tasks` by hand.",
    ].join("\n"),
  );
}

async function handlePendingJudgmentPrompt(root: string, sessionId: string, prompt: string, pendingJudgment: PendingJudgment): Promise<Record<string, unknown>> {
  const judgment: PromptJudgment = {
    classification: pendingJudgment.classification,
    requiresWorkflow: pendingJudgment.requiresWorkflow,
    reason: pendingJudgment.reason,
  };

  if (isJudgmentApprovalPrompt(prompt)) {
    if (pendingJudgment.classification === "simple") {
      await clearPendingJudgment(root, sessionId);
      return promptContext(
        [
          ...promptJudgmentLines(judgment),
          "MewoFlow judgment accepted by the user: no workflow task will be created for this prompt.",
          `Original prompt: ${pendingJudgment.prompt}`,
          "Proceed only with the accepted simple request. If the work escalates into implementation file creation, scaffolding, dependency changes, or broader development, start a new MewoFlow judgment/task flow first.",
        ].join("\n"),
      );
    }

    const pendingTask = await createPendingTask(root, {
      title: pendingJudgment.prompt,
      type: pendingJudgment.classification,
      prompt: pendingJudgment.prompt,
    });
    await setPendingTask(root, pendingTask, sessionId);
    return promptContext(
      [
        ...promptJudgmentLines(judgment),
        "MewoFlow judgment accepted by the user.",
        `MewoFlow pending task proposed after judgment confirmation: ${pendingTask.id}`,
        `Type: ${pendingTask.type}`,
        `Draft title: ${pendingTask.title}`,
        visiblePendingTaskNotice(pendingTask, sessionId, judgment),
        `Mandatory next tool action: run \`npx mewoflow propose-task --title "<model title>" --slug "descriptive-kebab-slug" --session ${sessionId}\`, then ask the user whether to create the task.`,
        "Do not create task files, research, grill, plan, scaffold, install dependencies, or edit code before pending task confirmation.",
      ].join("\n"),
    );
  }

  if (isJudgmentRejectionPrompt(prompt)) {
    await clearPendingJudgment(root, sessionId);
    return promptContext(
      [
        ...promptJudgmentLines(judgment),
        "MewoFlow prompt judgment rejected by the user. No pending task was proposed or created.",
        "Ask the user to correct the classification before doing work: simple / standard / epic, and ask for the reason or clarified request if needed.",
        "After the user provides the corrected request or classification, run a fresh MewoFlow judgment step. Do not write files, scaffold, install dependencies, or edit code yet.",
      ].join("\n"),
    );
  }

  return promptContext(
    [
      "MewoFlow pending prompt judgment awaiting user review.",
      ...promptJudgmentLines(judgment),
      visibleJudgmentNotice(judgment),
      "Ask the user exactly whether this judgment has a problem before doing anything else: `这个 MewoFlow 判断有问题吗？如果没问题我再继续；如果有问题请告诉我应改成 simple / standard / epic。`",
      "Do not propose a task, create task files, research, grill, plan, scaffold, install dependencies, or edit code until the user answers the judgment review.",
    ].join("\n"),
  );
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

function eventOutput(event: "PreToolUse" | "PostToolUse", detail?: string): Record<string, unknown> {
  const notice = hookNotice(event);
  const additionalContext = detail ? `${notice}\n${detail}` : notice;
  return {
    [MEWOFLOW_NOTICE_FIELD]: notice,
    additionalContext,
    hookSpecificOutput: { hookEventName: event },
  };
}

async function recordHookEvidence(warnings: string[], label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`could not record ${label}: ${message}`);
  }
}

function visibleTaskNotice(taskLine: string, gate: string): string {
  return [
    "Mandatory visible response: In your next assistant message, tell the user this MewoFlow hook fired.",
    `Start with: \"${hookNotice("UserPromptSubmit")} ${taskLine}. Current gate: ${gate}.\"`,
    "Do not hide the cat notice or task id in internal reasoning only.",
  ].join(" ");
}

function visiblePendingTaskNotice(pendingTask: PendingTask, sessionId: string, judgment?: PromptJudgment): string {
  const proposed = pendingTask.proposedTitle && pendingTask.proposedSlug
    ? `已记录模型建议 title: ${pendingTask.proposedTitle}, slug: ${pendingTask.proposedSlug}.`
    : `模型必须先运行 npx mewoflow propose-task --title "<model title>" --slug "descriptive-kebab-slug" --session ${sessionId}.`;
  const judgmentText = judgment
    ? `判断结果: ${judgment.classification}; 原因: ${judgment.reason}; `
    : "";
  return [
    "Mandatory visible response: In your next assistant message, tell the user this MewoFlow hook fired, show the prompt judgment, and state that no task has been created yet.",
    `Start with: "${hookNotice("UserPromptSubmit")} 猫咪先判断需求喵！${judgmentText}猫咪发现一个新开发需求喵！发现 draft task: ${pendingTask.id}. ${proposed} 请确认是否创建任务。"`,
    "Do not ask requirements, research, grill, plan, or implement until the user confirms task creation. If confirmation is collected through a structured question rather than a new user prompt, run `npx mewoflow confirm-task`; do not manually create .mewoflow task files.",
  ].join(" ");
}

function promptJudgmentLines(judgment: PromptJudgment): string[] {
  return [
    "MewoFlow prompt judgment:",
    `Classification: ${judgment.classification}`,
    `Requires workflow: ${judgment.requiresWorkflow ? "yes" : "no"}`,
    `Reason: ${judgment.reason}`,
  ];
}

function visibleJudgmentNotice(judgment: PromptJudgment): string {
  return [
    "Mandatory visible response: In your next assistant message, tell the user this MewoFlow hook fired and show the prompt judgment before doing anything else.",
    `Start with: "${hookNotice("UserPromptSubmit")} 猫咪先判断需求喵！判断结果: ${judgment.classification}; 是否需要完整流程: ${judgment.requiresWorkflow ? "需要" : "不需要"}; 原因: ${judgment.reason}"`,
    "Do not hide the judgment in internal reasoning only.",
  ].join(" ");
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
    "No active MewoFlow task. Implementation writes, file creation, shell writes, scaffolding, or dependency changes are blocked until a workflow task is active.",
    "Do not rely on prompt keyword matching as the safety boundary. If this write comes from a real development request, first show the MewoFlow prompt judgment and ask whether the judgment has a problem. Only after the user accepts that judgment may you run `npx mewoflow propose-task --title \"...\" --slug \"descriptive-kebab-slug\"`, ask the user to confirm task creation, then run `npx mewoflow confirm-task`.",
    "After confirmation, follow research -> grill -> plan -> user-approval before implementation writes, then verify -> review -> verify -> archive before claiming completion.",
  ].join(" ");
}

function pendingJudgmentWriteReason(judgment: PendingJudgment): string {
  return [
    `Pending MewoFlow prompt judgment is waiting for user review. Classification: ${judgment.classification}; requires workflow: ${judgment.requiresWorkflow ? "yes" : "no"}; reason: ${judgment.reason}`,
    "Ask the user whether this judgment has a problem before proposing a task or doing work.",
    "Do not write files, scaffold, install dependencies, create a task, or start research/grill/plan until the user confirms the judgment is correct.",
  ].join(" ");
}

function pendingTaskWriteReason(taskId: string): string {
  return [
    `Pending MewoFlow task ${taskId} is waiting for explicit user confirmation.`,
    "Do not write files, scaffold, install dependencies, or start research/grill/plan before the user confirms task creation.",
    "Ask the user: `是否创建这个 MewoFlow task？` If the user already confirmed through a structured question, run `npx mewoflow check pending-task-confirmation` to let the MewoFlow CLI create the task.",
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
    return `Next action: complete ${base}/research.md with Tool Evidence from WebSearch/WebFetch/MCP/skill or user-provided-source evidence, then run \`mewoflow check research\`; after that, directly use the project-local grill-me skill before plan or implementation.`;
  }
  if (task.gate === "grill") {
    return `Next action: directly use the project-local \`grill-me\` skill from .claude/skills/grill-me/SKILL.md. Interview one question at a time, cover product details and testing/acceptance, record Recommended Answer, User Answer, Decision, Decision Coverage, and why model judgment says no meaningful questions remain in ${base}/grill.md; then run \`mewoflow check grill\`.`;
  }
  if (task.gate === "plan") {
    return `Next action: before finalizing ${base}/plan.md, run a fresh WebSearch/WebFetch/MCP/skill shortcut scan, record Shortcut / Existing Solution Scan, MVP Slice, phases, risks, and parent/child breakdown when applicable; then show the plan and wait for explicit approval before \`mewoflow check plan\`. If approval is structured, run \`mewoflow approve-plan --prompt \"...\"\`.`;
  }
  if (task.gate === "implement") {
    return `Next action: read .mewoflow/rules.md plus ${base}/research.md, grill.md, and plan.md before editing.`;
  }
  if (task.gate === "verify") {
    return task.reviewed
      ? `Next action: record post-review verification evidence in ${base}/verify.md, then run \`mewoflow check verify\` to advance to archive.`
      : `Next action: record initial verification evidence in ${base}/verify.md, then run \`mewoflow check verify\` to advance to code review.`;
  }
  if (task.gate === "review") {
    return `Next action: review concrete changed files, use a relevant skill/subagent when suitable, record findings in ${base}/review.md, then run \`mewoflow check review\`; after review, verify again before archive.`;
  }
  if (task.gate === "archive") {
    return `Next action: summarize decisions, verification, review, and follow-ups in ${base}/archive.md, then run \`mewoflow check archive\`; the task directory will move to .mewoflow/archive/${task.id}/.`;
  }
  return "Next action: start a new MewoFlow task before more implementation work.";
}

function isReadTool(tool: string): boolean {
  return /^(Read|ReadFile|NotebookRead)$/i.test(tool);
}

function isSearchTool(tool: string): boolean {
  return /WebSearch|WebFetch|MCP|mcp__|context7|exa|tavily|firecrawl/i.test(tool);
}

function isSkillTool(tool: string): boolean {
  return /^Skill$/i.test(tool);
}

function skillName(input: HookInput): string | null {
  const value = input.tool_input?.skill ?? input.tool_input?.name ?? input.tool_input?.skill_name;
  return typeof value === "string" ? value : null;
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

function requiresWorkflowWithoutActiveTask(tool: string, command: string): boolean {
  if (/^(Write|MultiEdit|NotebookEdit)$/i.test(tool)) return true;
  if (tool !== "Bash") return false;
  return isWriteAttempt(tool, command);
}

function isEpicPrompt(prompt: string): boolean {
  return /系统|平台|架构|工具集|大型重构|workflow|agent/i.test(prompt);
}

function isMinorEditPrompt(prompt: string): boolean {
  return /颜色|文案|typo|样式|小改动|margin|padding|div/i.test(prompt);
}

function isWorkflowTaskPrompt(prompt: string): boolean {
  return isBuildFromScratchPrompt(prompt) || /修复|新增|添加|加入|实现|开发|构建|重构|接入|集成|排查|定位|优化|升级|更新|迁移|发布|安装|依赖|测试|bug|API|接口|登录|页面|组件|脚本|数据库|hook|功能/i.test(prompt);
}

function isGitCommitPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (/^(提交|提交git|git提交|git\s+commit|commit)$/i.test(trimmed)) return true;
  const looksLikeCommit = /(?:git|代码|改动|当前变更|版本).{0,12}(?:提交|commit)|(?:提交|commit).{0,12}(?:git|代码|改动|当前变更|版本)/i.test(trimmed);
  const includesNewWork = /修复|新增|添加|加入|实现|开发|构建|重构|接入|集成|排查|定位|优化|升级|更新|迁移|安装|依赖|测试|写|创建|制作|搭建/i.test(trimmed);
  return trimmed.length <= 80 && looksLikeCommit && !includesNewWork;
}

function isBuildFromScratchPrompt(prompt: string): boolean {
  return /创建|做|写|编写|制作|搭建|生成|开发|从零开始|新建/i.test(prompt) && /网页|网站|应用|项目|播放器|前端|后台|管理系统|博客|官网|小程序|工具|客户端|服务端|管理台|页面/i.test(prompt);
}

function hasPackageManagerWriteCommand(command: string): boolean {
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|create|init)\b/i.test(command) ||
    /\b(?:pnpm|yarn)\s+dlx\b/i.test(command) ||
    /\bnpm\s+exec\b/i.test(command) ||
    /\bnpx\s+create[-\w./@]*\b/i.test(command)
  );
}

function isControlledMewoFlowCommand(command: string): boolean {
  const trimmed = command.trim();
  const cdPrefix = String.raw`(?:cd\s+(?:"[^"]+"|'[^']+'|[^&;]+)\s*(?:&&|;)\s*)?`;
  const mewoflow = String.raw`(?:npx\s+)?mewoflow`;
  const quoted = String.raw`(?:(?:"[^"]+")|(?:'[^']+')|(?:[^\s&;|<>]+))`;
  const sessionArg = String.raw`(?:\s+--session\s+${quoted})?`;
  const redirect = String.raw`(?:\s+2>&1)?`;
  const propose = String.raw`propose-task\s+--title\s+${quoted}\s+--slug\s+${quoted}${sessionArg}`;
  const confirm = String.raw`(?:confirm-task|check\s+pending-task-confirmation)${sessionArg}`;
  const approve = String.raw`approve-plan${sessionArg}(?:\s+--prompt\s+${quoted})?`;
  const split = String.raw`split-task\s+--from-plan${sessionArg}`;
  return new RegExp(`^${cdPrefix}${mewoflow}\\s+(?:${propose}|${confirm}|${approve}|${split})${redirect}$`, "i").test(trimmed);
}

function isControlledGitCommitCommand(command: string): boolean {
  const trimmed = command.trim();
  const cdPrefix = String.raw`(?:cd\s+(?:"[^"]+"|'[^']+'|[^&;]+)\s*(?:&&|;)\s*)?`;
  const mewoflow = String.raw`(?:npx\s+)?mewoflow`;
  const quoted = String.raw`(?:(?:"[^"]+")|(?:'[^']+')|(?:[^\s&;|<>]+))`;
  const redirect = String.raw`(?:\s+2>&1)?`;
  const arg = String.raw`(?:--dry-run|--message\s+${quoted}|--message=${quoted}|-m\s+${quoted}|-m=${quoted})`;
  return new RegExp(`^${cdPrefix}${mewoflow}\\s+commit(?:\\s+${arg})*${redirect}$`, "i").test(trimmed);
}

function isMetaPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return /^\/mewoflow(?:-[a-z0-9-]+)?\b/i.test(trimmed) || /^mewoflow\s+(doctor|status|help|version|init|check|hook)\b/i.test(trimmed);
}

function isTaskConfirmationPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (/^(确认|同意|可以|是|是的|创建|yes|ok)$/i.test(trimmed)) return true;
  return /确认创建|同意创建|创建任务|开始\s*MewoFlow\s*任务|开始任务|批准创建|yes|ok/i.test(prompt);
}

function isTaskRejectionPrompt(prompt: string): boolean {
  return /取消|不要创建|不创建|先别|no/i.test(prompt);
}

function isJudgmentApprovalPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (/^(正确|對|对|对的|對的|是|是的|没错|沒錯|没问题|沒有问题|无问题|無問題|可以|可以继续|继续|同意|同意这个判断|yes|ok)$/i.test(trimmed)) return true;
  return /判断.{0,8}(正确|没问题|沒有问题|无问题|無問題|对|對)|没问题|沒有问题|无问题|無問題|判断可以|判断通过|判断没错|对的|可以继续|继续|同意这个判断|yes|ok/i.test(prompt);
}

function isJudgmentRejectionPrompt(prompt: string): boolean {
  return /判断.{0,8}(有问题|不对|不對|错|錯|错误|錯誤)|有问题|不对|不對|错了|錯了|不是|不应该|不應該|改成|应该是|應該是/i.test(prompt);
}

function isPlanApprovalPrompt(prompt: string): boolean {
  return /批准|同意计划|确认计划|确认执行|开始实现|可以实现|进入实现|执行计划|按计划|approved|approve/i.test(prompt);
}

function hasShellWriteRedirection(command: string): boolean {
  return /(^|\s)(?:\d{0,2})?>>?(?!&)/.test(command);
}

function isProtectedTarget(target: string): boolean {
  return /^\.mewoflow\/tasks\/.*\/task\.json$/.test(target) || target.startsWith(".mewoflow/runtime/");
}

function isProtectedWriteCommand(command: string): boolean {
  if (!/\.mewoflow[\\/](?:tasks|runtime)/i.test(command)) return false;
  return (
    /\b(rm|mv|cp|del|erase|ren|mkdir|new-item|ni|set-content|add-content|out-file)\b/i.test(command) ||
    /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|rmSync|renameSync|copyFileSync)\b/i.test(command) ||
    hasShellWriteRedirection(command)
  );
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
  return ["research.md", "grill.md", "plan.md", "verify.md", "review.md", "archive.md"];
}
