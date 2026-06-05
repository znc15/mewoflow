import {
  discoverSkillNames,
  getActiveTask,
  hasArchiveApproval,
  hasPlanApproval,
  hasResolvedSpecPrompt,
  isSpecFileTarget,
  loadSession,
  loadSessionWithDefault,
  normalizePath,
  recordCommand,
  recordReadFile,
  recordSearchTool,
  recordSkillUse,
  requiredImplementationReads,
  setPendingJudgment,
  type TaskType,
  type Task,
  type PendingTask,
  type PendingJudgment,
  type SessionState,
} from "./task.js";

export type HookInput = {
  prompt?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

export type PromptClassification = "simple" | "undetermined" | TaskType;

export type PromptJudgment = {
  classification: PromptClassification;
  requiresWorkflow: boolean;
  reason: string;
};

export const MEWOFLOW_NOTICE_FIELD = "mewoflowNotice";

/** @deprecated Use judgePrompt() instead; kept for backward compatibility. */
export function classifyPrompt(prompt: string): PromptClassification {
  return judgePrompt(prompt).classification;
}

export function judgePrompt(prompt: string): PromptJudgment {
  return {
    classification: "undetermined",
    requiresWorkflow: false,
    reason: prompt,
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
    return handlePendingPrompt(sessionId, session.pendingTask);
  }

  if (session.pendingJudgment && !session.activeTaskId) {
    return handlePendingJudgmentPrompt(sessionId, session.pendingJudgment);
  }

  const activeTask = await getActiveTask(root, sessionId);

  if (session.pendingSpecPrompt && activeTask && activeTask.id === session.pendingSpecPrompt.taskId && activeTask.gate === "research") {
    return handlePendingSpecPrompt(sessionId, session.pendingSpecPrompt, activeTask);
  }

  if (activeTask && activeTask.gate !== "done") {
    const skillNames = await discoverSkillNames(root);
    return promptContext(
      [
        `MewoFlow active task: ${activeTask.id}`,
        `Type: ${activeTask.type}`,
        `Current gate: ${activeTask.gate}`,
        visibleTaskNotice(`MewoFlow active task: ${activeTask.id}`, activeTask.gate),
        coachingPromptForGate(activeTask),
        skillDiscoveryGuidance(activeTask, session, skillNames),
        "Continue the current gate. Do not create a new task or skip ahead.",
        "Required gate order: research -> grill -> plan -> implement -> verify -> review -> verify -> archive.",
        nextActionForGate(activeTask),
        activeTask.gate === "plan"
          ? `If the latest user response approves the plan, do not let this hook infer it from natural language; run \`npx mewoflow approve-plan --prompt "<user approval>" --session ${sessionId}\` before \`mewoflow check plan\`.`
          : activeTask.gate === "archive"
            ? `Before archiving, show the archive summary and ask whether anything still needs changes. When the user confirms no further changes, run \`npx mewoflow approve-archive --prompt "<user confirmation>" --session ${sessionId}\` before \`mewoflow check archive\`.`
            : "",
      ].join("\n"),
    );
  }

  if (session.pendingTask) {
    return handlePendingPrompt(sessionId, session.pendingTask);
  }

  if (session.pendingJudgment) {
    return handlePendingJudgmentPrompt(sessionId, session.pendingJudgment);
  }

  const judgment = judgePrompt(prompt);
  await setPendingJudgment(root, { ...judgment, prompt, created_at: new Date().toISOString() }, sessionId);

  return promptContext(
    [
      "MewoFlow: New prompt recorded as pending judgment (undetermined).",
      "Before doing any work, determine whether this request is:",
      "- simple: no full workflow needed (minor edit, question, meta command)",
      "- standard: development task requiring research -> grill -> plan -> implement -> verify -> review -> archive",
      "- epic: broad system/architecture request requiring parent epic splitting",
      "Ask the user to confirm your classification.",
      `If correct, run \`npx mewoflow accept-judgment --classification <simple|standard|epic> --session ${sessionId}\`.`,
      `If wrong, run \`npx mewoflow reject-judgment --reason "<correction>" --session ${sessionId}\`.`,
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

  if (isControlledMaintenanceCommand(command)) {
    return allowPreToolUse();
  }

  if (isControlledJudgmentCommand(command)) {
    return allowPreToolUse();
  }

  if (isControlledMewoFlowCommand(command)) {
    const session = await loadSessionWithDefault(root, sessionId);
    if (session.pendingJudgment && !session.activeTaskId) return deny(pendingJudgmentWriteReason(session.pendingJudgment));
    return allowPreToolUse();
  }

  if (writeAttempt && isProtectedTarget(target)) {
    return deny("MewoFlow protected state files can only be changed by the mewoflow CLI.");
  }

  if (!writeAttempt) return allowPreToolUse();

  const session = await loadSessionWithDefault(root, sessionId);
  if (session.pendingJudgment && !session.activeTaskId) return deny(pendingJudgmentWriteReason(session.pendingJudgment));
  if (session.pendingTask && !session.activeTaskId) return deny(pendingTaskWriteReason(session.pendingTask.id));
  const task = await getActiveTask(root, sessionId);
  if (!task || task.gate === "done") {
    if (session.pendingTask) return deny(pendingTaskWriteReason(session.pendingTask.id));
    return requiresWorkflowWithoutActiveTask(tool, command) ? deny(noActiveTaskWriteReason()) : allowPreToolUse();
  }

  if (isActiveTaskEvidenceTarget(target, task)) {
    return allowPreToolUse();
  }

  if (isSpecFileTarget(target) && canWriteSpecFiles(session, task)) {
    return allowPreToolUse();
  }

  if (commandReferencesActiveTaskEvidence(command, task)) {
    return isSafeActiveTaskEvidenceCommand(command, task)
      ? allowPreToolUse()
      : deny("MewoFlow evidence markdown Bash writes must be a single safe write to the current task evidence file; chained commands, package installs, deletes, moves, and extra shell operations are blocked.");
  }

  if (isProtectedWriteCommand(command)) {
    return deny("MewoFlow protected state files can only be changed by the mewoflow CLI.");
  }

  if (task.gate !== "implement") {
    return deny(writeBlockedReason(task));
  }

  if (!hasPlanApproval(session, task.id)) {
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

  const task = await getActiveTask(root, sessionId);
  const session = await loadSessionWithDefault(root, sessionId);
  const skillCoaching = task ? postToolSkillCoaching(task, session) : null;
  if (skillCoaching) warnings.push(skillCoaching);

  return eventOutput("PostToolUse", warnings.length > 0 ? `MewoFlow guidance: ${warnings.join("; ")}` : undefined);
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
  if (task.gate === "grill" || task.gate === "plan" || task.gate === "archive") {
    return {
      [MEWOFLOW_NOTICE_FIELD]: notice,
      additionalContext: `${notice}\nMewoFlow task ${task.id} is waiting at ${task.gate}. It is OK to stop when waiting for user answers, explicit plan/archive approval, or archive summary confirmation; do not claim completion.`,
    };
  }
  return {
    [MEWOFLOW_NOTICE_FIELD]: notice,
    additionalContext: notice,
    decision: "block",
    reason: `${notice} MewoFlow task ${task.id} is not complete. Current gate: ${task.gate}. Continue the required workflow instead of claiming completion.`,
  };
}

export async function handleTeammateIdle(root: string, input: HookInput): Promise<Record<string, unknown>> {
  const sessionId = input.session_id ?? "default";
  const task = await getActiveTask(root, sessionId);

  if (!task || task.gate === "done") {
    return eventOutput(
      "TeammateIdle",
      "Teammate idle. No active MewoFlow task is recorded for this session; coordinate with the team lead before starting new work.",
    );
  }

  return eventOutput(
    "TeammateIdle",
    [
      `Teammate idle while task ${task.id} is at gate ${task.gate}.`,
      "If you finished a unit of work, tell the team lead what changed and which files to review.",
      "Avoid file conflicts: do not edit the same files as other teammates.",
      task.gate === "implement" ? "If implementation is done, record verification evidence in verify.md next." : "Follow the current gate and evidence requirements.",
    ].join(" "),
  );
}

export async function handleTaskCreated(_root: string, _input: HookInput): Promise<Record<string, unknown>> {
  return eventOutput(
    "TaskCreated",
    "Claude Code agent team task created. Keep tasks scoped to non-overlapping files and ensure the team lead tracks dependencies and merges outputs safely.",
  );
}

export async function handleTaskCompleted(_root: string, _input: HookInput): Promise<Record<string, unknown>> {
  return eventOutput(
    "TaskCompleted",
    "Claude Code agent team task marked completed. Ensure results are reviewed and verification evidence is updated before advancing MewoFlow gates.",
  );
}

async function handlePendingPrompt(sessionId: string, pendingTask: PendingTask): Promise<Record<string, unknown>> {
  return pendingTaskPromptContext(sessionId, pendingTask);
}

function pendingTaskPromptContext(sessionId: string, pendingTask: PendingTask): Record<string, unknown> {
  return promptContext(
    [
      `MewoFlow pending task awaiting user confirmation: ${pendingTask.id}`,
      `Type: ${pendingTask.type}`,
      `Draft title: ${pendingTask.title}`,
      pendingTask.proposedTitle ? `Proposed title: ${pendingTask.proposedTitle}` : "Proposed title: not recorded yet",
      pendingTask.proposedSlug ? `Proposed slug: ${pendingTask.proposedSlug}` : "Proposed slug: not recorded yet",
      visiblePendingTaskNotice(pendingTask, sessionId),
      "Do not create task files, research, grill, plan, scaffold, install dependencies, or edit code until the user explicitly confirms task creation.",
      "This hook does not infer task confirmation or cancellation from natural-language replies.",
      pendingTask.proposedTitle && pendingTask.proposedSlug
        ? `If the latest user response confirms task creation, run \`npx mewoflow confirm-task --session ${sessionId}\`. If the latest user response cancels it, run \`npx mewoflow cancel-task --session ${sessionId}\`. Never create \`.mewoflow/tasks\` by hand.`
        : `First run \`npx mewoflow propose-task --title "<model title>" --slug "descriptive-kebab-slug" --session ${sessionId}\`, then ask the user whether to create the task. If the user cancels, run \`npx mewoflow cancel-task --session ${sessionId}\`.`,
    ].join("\n"),
  );
}

async function handlePendingSpecPrompt(sessionId: string, pendingSpecPrompt: { taskId: string }, task: Task): Promise<Record<string, unknown>> {
  return promptContext(
    [
      `MewoFlow spec setup prompt for task ${pendingSpecPrompt.taskId}.`,
      "Before research, ask the user whether to create or update project specs in `.mewoflow/specs/` (coding.md, testing.md, agent.md).",
      "Explain briefly what each spec file is for, note that existing project specs can stay as-is, and ask whether they want to flesh them out for this task.",
      "This hook does not infer the answer from natural-language replies.",
      `If the user declines spec setup, run \`npx mewoflow spec-skip --session ${sessionId}\`.`,
      `If the user wants spec setup, run \`npx mewoflow spec-create --session ${sessionId}\`, interview them about conventions/testing/agent expectations, update the spec files, then continue research.`,
      `Do not run \`mewoflow check research\` until spec-skip or spec-create has been recorded.`,
      visibleSpecPromptNotice(pendingSpecPrompt.taskId, sessionId),
      nextActionForGate(task),
    ].join("\n"),
  );
}

function visibleSpecPromptNotice(taskId: string, sessionId: string): string {
  return [
    "Mandatory visible response: In your next assistant message, tell the user this MewoFlow hook fired and ask whether to create/update project specs before research.",
    `Start with: "${hookNotice("UserPromptSubmit")} 任务 ${taskId} 已创建。是否要先完善 .mewoflow/specs/ 里的 coding/testing/agent 规范？"`,
    `After interpreting the user response, run \`npx mewoflow spec-skip --session ${sessionId}\` or \`npx mewoflow spec-create --session ${sessionId}\`.`,
  ].join(" ");
}

function coachingPromptForGate(task: Task): string {
  const prompts: Partial<Record<Task["gate"], string>> = {
    research: "Coaching: What facts are still uncertain? Ask the user to confirm assumptions before locking research conclusions.",
    grill: "Coaching: What decision branches are still open? Ask one concrete question at a time instead of guessing missing requirements.",
    plan: "Coaching: What could make this plan fail in production? Ask the user about trade-offs, scope cuts, and verification gaps before finalizing.",
    implement: "Coaching: What integration risks or missing context might break the first implementation slice? Ask before large refactors.",
    verify: "Coaching: What critical paths or regressions might still be untested? Ask whether the verification evidence matches user expectations.",
    review: "Coaching: What files, risks, or assumptions deserve a second look? Ask whether unresolved findings need rework or explicit deferred-risk approval.",
    archive: "Coaching: What follow-ups, known issues, or deferred decisions should the user confirm before archiving? Ask explicitly before closing the task.",
  };
  return prompts[task.gate] ?? "Coaching: What is still unclear about this task? Ask the user before claiming completion.";
}

function skillDiscoveryGuidance(task: Task, session: SessionState, skillNames: string[]): string {
  const gatesNeedingSkills: Task["gate"][] = ["research", "plan", "implement", "review"];
  if (!gatesNeedingSkills.includes(task.gate)) return "";

  const discovered = skillNames.length > 0
    ? `Project-local skills discovered: ${skillNames.join(", ")}.`
    : "No project-local skills found under .claude/skills/ yet.";
  const usedThisGate = session.skillUses.some((entry) => entry.gate === task.gate && (!entry.taskId || entry.taskId === task.id));

  return [
    "Skill discovery:",
    discovered,
    "Also check user/global skill directories when relevant; do not hardcode a fixed skill list for this project.",
    usedThisGate
      ? "A skill use is already recorded for this gate; keep citing it in the current evidence file."
      : `Before advancing this gate, browse available skills, read any that match the task domain (${task.gate}), and apply them when they add real value. Record which skills were considered or used in the gate evidence.`,
    task.gate === "implement"
      ? "For frontend/backend/UI work, prefer domain skills (design, framework, language best practices) over improvising without guidance."
      : "",
  ].filter(Boolean).join(" ");
}

function postToolSkillCoaching(task: Task, session: SessionState): string | null {
  const gatesNeedingSkills: Task["gate"][] = ["plan", "implement", "review"];
  if (!gatesNeedingSkills.includes(task.gate)) return null;
  const usedThisGate = session.skillUses.some((entry) => entry.gate === task.gate && (!entry.taskId || entry.taskId === task.id));
  if (usedThisGate) return null;
  return `No skill usage recorded yet at ${task.gate} gate; browse available skills and apply a relevant one when it improves design, implementation, or review quality.`;
}

function canWriteSpecFiles(session: SessionState, task: Task): boolean {
  return session.specDecisions[task.id] === "create" && (task.gate === "research" || task.gate === "grill" || task.gate === "plan");
}

async function handlePendingJudgmentPrompt(sessionId: string, pendingJudgment: PendingJudgment): Promise<Record<string, unknown>> {
  const judgment: PromptJudgment = {
    classification: pendingJudgment.classification,
    requiresWorkflow: pendingJudgment.requiresWorkflow,
    reason: pendingJudgment.reason,
  };

  return promptContext(
    [
      "MewoFlow pending prompt judgment awaiting command-driven user review.",
      ...promptJudgmentLines(judgment),
      visibleJudgmentNotice(judgment),
      "Ask the user exactly whether this judgment has a problem before doing anything else: `这个 MewoFlow 判断有问题吗？如果没问题我再继续；如果有问题请告诉我应改成 simple / standard / epic。`",
      "This hook does not infer judgment acceptance or rejection from natural-language replies.",
      pendingJudgment.classification === "undetermined"
        ? `If the latest user response accepts this judgment, run \`npx mewoflow accept-judgment --classification <simple|standard|epic> --session ${sessionId}\`.`
        : pendingJudgment.classification === "simple"
          ? `If the latest user response accepts this simple judgment, run \`npx mewoflow accept-judgment --classification simple --session ${sessionId}\` to clear the pending judgment without creating a task.`
          : `If the latest user response accepts this workflow judgment, run \`npx mewoflow accept-judgment --classification ${pendingJudgment.classification} --session ${sessionId}\`; then run \`npx mewoflow propose-task --title "<model title>" --slug "descriptive-kebab-slug" --session ${sessionId}\` before asking for task creation confirmation.`,
      `If the latest user response rejects or corrects this judgment, run \`npx mewoflow reject-judgment --reason "<user correction>" --session ${sessionId}\` before asking for the corrected classification or request.`,
      "Do not propose a task, create task files, research, grill, plan, scaffold, install dependencies, or edit code until the judgment is resolved by one of those explicit commands.",
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

function eventOutput(event: "PreToolUse" | "PostToolUse" | "TeammateIdle" | "TaskCreated" | "TaskCompleted", detail?: string): Record<string, unknown> {
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
    `Do not ask requirements, research, grill, plan, or implement until the user confirms task creation and Claude runs an explicit command. If the user confirms, run \`npx mewoflow confirm-task --session ${sessionId}\`; if the user cancels, run \`npx mewoflow cancel-task --session ${sessionId}\`. Do not manually create .mewoflow task files.`,
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

function hookNotice(event: "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "TeammateIdle" | "TaskCreated" | "TaskCompleted"): string {
  return event === "UserPromptSubmit"
    ? "猫咪正在监控你的需求喵！"
    : event === "PreToolUse"
      ? "猫咪正在检查工具调用喵！"
      : event === "PostToolUse"
        ? "猫咪已记录工具结果喵！"
        : event === "Stop"
          ? "猫咪发现任务还没完成喵！"
          : "猫咪正在协作团队喵！";
}

function noActiveTaskWriteReason(): string {
  return [
    "No active MewoFlow task. Implementation writes, file creation, shell writes, scaffolding, or dependency changes are blocked until a workflow task is active.",
    "Do not rely on prompt keyword matching as the safety boundary. If this write comes from a real development request, first show the MewoFlow prompt judgment and ask whether the judgment has a problem. If the user accepts the judgment, run `npx mewoflow accept-judgment`, then `npx mewoflow propose-task --title \"...\" --slug \"descriptive-kebab-slug\"`, ask the user to confirm task creation, and only then run `npx mewoflow confirm-task`.",
    "After confirmation, follow research -> grill -> plan -> user-approval before implementation writes, then verify -> review -> verify -> archive before claiming completion.",
  ].join(" ");
}

function pendingJudgmentWriteReason(judgment: PendingJudgment): string {
  const acceptCommand = judgment.classification === "undetermined"
    ? "`npx mewoflow accept-judgment --classification <simple|standard|epic>`"
    : "`npx mewoflow accept-judgment`";
  return [
    `Pending MewoFlow prompt judgment is waiting for user review. Classification: ${judgment.classification}; requires workflow: ${judgment.requiresWorkflow ? "yes" : "no"}; reason: ${judgment.reason}`,
    "Ask the user whether this judgment has a problem before proposing a task or doing work.",
    `Do not write files, scaffold, install dependencies, create a task, or start research/grill/plan until Claude resolves the judgment with ${acceptCommand} or \`npx mewoflow reject-judgment --reason "..."\`.`,
  ].join(" ");
}

function pendingTaskWriteReason(taskId: string): string {
  return [
    `Pending MewoFlow task ${taskId} is waiting for explicit user confirmation.`,
    "Do not write files, scaffold, install dependencies, or start research/grill/plan before the user confirms task creation.",
    "Ask the user: `是否创建这个 MewoFlow task？` If the user confirms, run `npx mewoflow confirm-task`; if they cancel, run `npx mewoflow cancel-task`. Do not infer this in the hook from hardcoded reply phrases.",
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
    return `Next action: complete ${base}/research.md with search/tool/skill evidence (LLM decides structure and sections), then run \`mewoflow check research\`; after that, directly use the project-local grill-me skill before plan or implementation.`;
  }
  if (task.gate === "grill") {
    return `Next action: directly use the project-local \`grill-me\` skill from .claude/skills/grill-me/SKILL.md. Interview one question at a time and record concrete question log, decision coverage, locked decisions, acceptance criteria, and stop rationale in ${base}/grill.md; LLM decides section names. Then run \`mewoflow check grill\`.`;
  }
  if (task.gate === "plan") {
    return `Next action: discover and apply relevant skills for planning shortcuts; before finalizing ${base}/plan.md, run a fresh WebSearch/WebFetch/MCP/skill scan and record MVP slice, phases, risks, and parent/child breakdown when applicable (LLM decides structure); then show the plan and wait for explicit approval before \`mewoflow check plan\`. If approval is structured, run \`mewoflow approve-plan --prompt \"...\"\`.`;
  }
  if (task.gate === "implement") {
    return `Next action: discover and read relevant frontend/backend/framework skills before editing; read .mewoflow/rules.md, .mewoflow/specs/, plus ${base}/research.md, grill.md, and plan.md before editing. If this is a rework and plan approval is missing, run \`mewoflow approve-plan --prompt "rework approval" [--session <id>]\`.`;
  }
  if (task.gate === "verify") {
    return task.reviewed
      ? `Next action: record post-review verification evidence in ${base}/verify.md, then run \`mewoflow check verify\` to advance to archive.`
      : `Next action: record initial verification evidence in ${base}/verify.md, then run \`mewoflow check verify\` to advance to code review.`;
  }
  if (task.gate === "review") {
    return `Next action: discover and use a relevant review skill/subagent when suitable; review concrete changed files and record findings in ${base}/review.md (LLM decides structure). If high/blocker findings need code changes, run \`mewoflow rework --reason "review found ..."\` instead of editing during review. If findings are resolved or explicitly deferred with approval, run \`mewoflow check review\`; after review, verify again before archive.`;
  }
  if (task.gate === "archive") {
    return `Next action: write ${base}/archive.md with decisions, verification, review, deferred-risk approval, and follow-ups BEFORE running check archive. Show the summary to the user and wait for explicit confirmation; then run \`mewoflow approve-archive --prompt \"...\"\` and only then \`mewoflow check archive\`. Unresolved high/blocker findings require \`mewoflow approve-deferred-risk --reason "..."\` before archive; the task directory will move to .mewoflow/archive/${task.id}/ only after archive.md is written and approved.`;
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
  return hasFileSystemWriteCommand(command) || hasPackageManagerWriteCommand(command) || hasShellWriteRedirection(command);
}

function requiresWorkflowWithoutActiveTask(tool: string, command: string): boolean {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/i.test(tool)) return true;
  if (tool !== "Bash") return false;
  return isWriteAttempt(tool, command);
}

function isGitCommitPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (/^(提交|提交git|git提交|git\s+commit|commit)$/i.test(trimmed)) return true;
  const looksLikeCommit = /(?:git|代码|改动|当前变更|版本).{0,12}(?:提交|commit)|(?:提交|commit).{0,12}(?:git|代码|改动|当前变更|版本)/i.test(trimmed);
  const includesNewWork = /修复|新增|添加|加入|实现|开发|构建|重构|接入|集成|排查|定位|优化|升级|更新|迁移|安装|依赖|测试|写|创建|制作|搭建/i.test(trimmed);
  return trimmed.length <= 80 && looksLikeCommit && !includesNewWork;
}

function hasPackageManagerWriteCommand(command: string): boolean {
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|create|init|ci|update)\b/i.test(command) ||
    /\b(?:pnpm|yarn)\s+dlx\b/i.test(command) ||
    /\bnpm\s+exec\b/i.test(command) ||
    /\bnpx\s+create[-\w./@]*\b/i.test(command) ||
    /\bpip(?:3)?\s+install\b/i.test(command) ||
    /\bcargo\s+(?:add|install)\b/i.test(command) ||
    /\bgo\s+get\b/i.test(command)
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
  const cancel = String.raw`cancel-task${sessionArg}`;
  const approveArgs = String.raw`(?:(?:\s+--session\s+${quoted})|(?:\s+--prompt\s+${quoted}))*`;
  const approve = String.raw`approve-(?:plan|archive)${approveArgs}`;
  const split = String.raw`split-task\s+--from-plan${sessionArg}`;
  const sessionOption = String.raw`\s+--session\s+${quoted}`;
  const reasonArg = String.raw`\s+--reason\s+${quoted}`;
  const reviewStateArgs = String.raw`(?:${sessionOption})*${reasonArg}(?:${sessionOption})*`;
  const rework = String.raw`rework${reviewStateArgs}`;
  const deferredRisk = String.raw`approve-deferred-risk${reviewStateArgs}`;
  const specSkip = String.raw`spec-skip${sessionArg}`;
  const specCreate = String.raw`spec-create${sessionArg}`;
  const check = String.raw`check\s+(?:pending-task-confirmation|research|grill|plan|implement|verify|review|archive)${sessionArg}`;
  return new RegExp(`^${cdPrefix}${mewoflow}\\s+(?:${propose}|${confirm}|${cancel}|${approve}|${split}|${rework}|${deferredRisk}|${specSkip}|${specCreate}|${check})${redirect}$`, "i").test(trimmed);
}

function isControlledJudgmentCommand(command: string): boolean {
  const trimmed = command.trim();
  const cdPrefix = String.raw`(?:cd\s+(?:"[^"]+"|'[^']+'|[^&;]+)\s*(?:&&|;)\s*)?`;
  const mewoflow = String.raw`(?:npx\s+)?mewoflow`;
  const quoted = String.raw`(?:(?:"[^"]+")|(?:'[^']+')|(?:[^\s&;|<>]+))`;
  const sessionArg = String.raw`(?:\s+--session\s+${quoted})?`;
  const classificationArg = String.raw`(?:\s+--classification\s+${quoted})?`;
  const redirect = String.raw`(?:\s+2>&1)?`;
  const accept = String.raw`accept-judgment${classificationArg}${sessionArg}`;
  const rejectArgs = String.raw`(?:(?:\s+--reason\s+${quoted})|(?:\s+--session\s+${quoted}))+`;
  const reject = String.raw`reject-judgment${rejectArgs}`;
  return new RegExp(`^${cdPrefix}${mewoflow}\\s+(?:${accept}|${reject})${redirect}$`, "i").test(trimmed);
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

function isControlledMaintenanceCommand(command: string): boolean {
  const trimmed = command.trim();
  const cdPrefix = String.raw`(?:cd\s+(?:"[^"]+"|'[^']+'|[^&;]+)\s*(?:&&|;)\s*)?`;
  const mewoflow = String.raw`(?:npx\s+)?mewoflow`;
  const redirect = String.raw`(?:\s+2>&1)?`;
  const updateArg = String.raw`(?:--dry-run|--force|-f)`;
  return new RegExp(`^${cdPrefix}${mewoflow}\\s+update(?:\\s+${updateArg})*${redirect}$`, "i").test(trimmed);
}


function hasShellWriteRedirection(command: string): boolean {
  return /(^|\s)(?:\d{0,2})?>>?(?!&)/.test(command);
}

function hasFileSystemWriteCommand(command: string): boolean {
  return (
    /\b(rm|mv|cp|del|erase|ren|mkdir|touch|tee|new-item|ni|set-content|add-content|clear-content|out-file|remove-item|copy-item|move-item|rename-item)\b/i.test(command) ||
    /\bgit\s+apply\b/i.test(command) ||
    /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|rmSync|renameSync|copyFileSync)\b/i.test(command)
  );
}

function hasShellCommandChaining(command: string): boolean {
  return /&&|\|\||[;|]/.test(command);
}

function isProtectedTarget(target: string): boolean {
  return /^\.mewoflow\/tasks\/.*\/task\.json$/.test(target) || target.startsWith(".mewoflow/runtime/");
}

function isProtectedWriteCommand(command: string): boolean {
  if (!/\.mewoflow[\\/](?:tasks|runtime)/i.test(command)) return false;
  return hasFileSystemWriteCommand(command) || hasShellWriteRedirection(command);
}

function isActiveTaskEvidenceTarget(target: string, task: Task): boolean {
  const base = `.mewoflow/tasks/${task.id}/`;
  return evidenceMarkdownFiles().some((file) => target === `${base}${file}`);
}

function commandReferencesActiveTaskEvidence(command: string, task: Task): boolean {
  const normalized = command.replace(/\\/g, "/");
  const base = `.mewoflow/tasks/${task.id}/`;
  return evidenceMarkdownFiles().some((file) => normalized.includes(`${base}${file}`));
}

function isSafeActiveTaskEvidenceCommand(command: string, task: Task): boolean {
  const trimmed = command.trim();
  if (!commandReferencesActiveTaskEvidence(trimmed, task)) return false;
  if (hasShellCommandChaining(trimmed)) return false;
  if (hasPackageManagerWriteCommand(trimmed)) return false;
  if (/\b(rm|mv|cp|del|erase|ren|mkdir|touch|tee|remove-item|copy-item|move-item|rename-item|git\s+apply)\b/i.test(trimmed)) return false;
  return /^\s*(?:set-content|add-content|out-file|echo|printf)\b/i.test(trimmed);
}

function evidenceMarkdownFiles(): string[] {
  return ["research.md", "grill.md", "plan.md", "verify.md", "review.md", "archive.md"];
}
