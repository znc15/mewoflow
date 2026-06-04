import path from "node:path";
import { pathExists, readTextIfExists, writeFileEnsured } from "./fs.js";

type ClaudeHook = Record<string, unknown> & {
  type?: string;
  command?: string;
};

type ClaudeHookGroup = Record<string, unknown> & {
  matcher?: string;
  hooks?: ClaudeHook[];
};

type ClaudeSettings = Record<string, unknown> & {
  hooks?: Record<string, ClaudeHookGroup[]>;
};

export type UpdateOptions = {
  dryRun?: boolean;
  force?: boolean;
};

export type UpdateAction = {
  action: "create" | "overwrite" | "refresh" | "merge" | "skip";
  file: string;
  reason: string;
};

export type UpdateResult = {
  dryRun: boolean;
  force: boolean;
  actions: UpdateAction[];
};

type ApplyManagedFilesOptions = Required<UpdateOptions>;

export async function initProject(root = process.cwd()): Promise<void> {
  await applyManagedFiles(root, { dryRun: false, force: false });
}

export async function updateProject(root = process.cwd(), options: UpdateOptions = {}): Promise<UpdateResult> {
  return applyManagedFiles(root, { dryRun: options.dryRun ?? false, force: options.force ?? false });
}

async function applyManagedFiles(root: string, options: ApplyManagedFilesOptions): Promise<UpdateResult> {
  const actions: UpdateAction[] = [];

  for (const [relativeFile, content] of templateFiles()) {
    await writeTemplateFile(root, relativeFile, content, options, actions);
  }

  for (const relativeFile of emptyFiles()) {
    await ensureEmptyFile(root, relativeFile, options, actions);
  }

  await refreshManagedFile(root, path.join(".mewoflow", "runtime", "mewoflow-hook.cjs"), hookShimTemplate(), options, actions);
  await mergeClaudeSettings(root, options, actions);

  return { dryRun: options.dryRun, force: options.force, actions };
}

function templateFiles(): Array<[string, string]> {
  return [
    ["AGENTS.md", agentsTemplate()],
    ["CLAUDE.md", claudeTemplate()],
    [path.join(".mewoflow", "rules.md"), rulesTemplate()],
    [path.join(".mewoflow", "workflow.md"), workflowTemplate()],
    [path.join(".mewoflow", "journal.md"), journalTemplate()],
    [path.join(".mewoflow", "specs", "coding.md"), codingSpecTemplate()],
    [path.join(".mewoflow", "specs", "testing.md"), testingSpecTemplate()],
    [path.join(".mewoflow", "specs", "agent.md"), agentSpecTemplate()],
    [path.join(".claude", "skills", "mewoflow", "SKILL.md"), entrySkillTemplate()],
    [path.join(".claude", "skills", "mewoflow-doctor", "SKILL.md"), doctorSkillTemplate()],
    [path.join(".claude", "skills", "grill-me", "SKILL.md"), grillMeSkillTemplate()],
  ];
}

function emptyFiles(): string[] {
  return [
    path.join(".mewoflow", "tasks", ".gitkeep"),
    path.join(".mewoflow", "archive", ".gitkeep"),
    path.join(".mewoflow", "runtime", "sessions", ".gitkeep"),
  ];
}

async function writeTemplateFile(root: string, relativeFile: string, content: string, options: ApplyManagedFilesOptions, actions: UpdateAction[]): Promise<void> {
  const file = path.join(root, relativeFile);
  const exists = await pathExists(file);
  if (exists && !options.force) {
    actions.push({ action: "skip", file: relativeFile, reason: "existing local file preserved; use --force to overwrite" });
    return;
  }

  actions.push({ action: exists ? "overwrite" : "create", file: relativeFile, reason: exists ? "--force requested" : "missing managed file" });
  if (!options.dryRun) await writeFileEnsured(file, content);
}

async function ensureEmptyFile(root: string, relativeFile: string, options: ApplyManagedFilesOptions, actions: UpdateAction[]): Promise<void> {
  const file = path.join(root, relativeFile);
  if (await pathExists(file)) {
    actions.push({ action: "skip", file: relativeFile, reason: "already exists" });
    return;
  }

  actions.push({ action: "create", file: relativeFile, reason: "missing marker file" });
  if (!options.dryRun) await writeFileEnsured(file, "");
}

async function refreshManagedFile(root: string, relativeFile: string, content: string, options: ApplyManagedFilesOptions, actions: UpdateAction[]): Promise<void> {
  actions.push({ action: "refresh", file: relativeFile, reason: "managed runtime file" });
  if (!options.dryRun) await writeFileEnsured(path.join(root, relativeFile), content);
}

async function mergeClaudeSettings(root: string, options: ApplyManagedFilesOptions, actions: UpdateAction[]): Promise<void> {
  const relativeFile = path.join(".claude", "settings.json");
  actions.push({ action: "merge", file: relativeFile, reason: "replace MewoFlow-owned hooks while preserving custom settings" });
  if (!options.dryRun) await writeMergedClaudeSettings(path.join(root, relativeFile), root);
}

async function writeMergedClaudeSettings(file: string, root: string): Promise<void> {
  const settings = await readClaudeSettings(file);
  const rawHooks = isRecord(settings.hooks) ? settings.hooks : {};
  const hooks: Record<string, ClaudeHookGroup[]> = {};

  for (const [event, groups] of Object.entries(rawHooks)) {
    hooks[event] = Array.isArray(groups) ? (groups as ClaudeHookGroup[]) : [];
  }

  for (const [event, desiredGroups] of Object.entries(mewoflowHooks(root))) {
    const current = removeMewoFlowHookCommands(hooks[event] ?? []);
    hooks[event] = desiredGroups.reduce((groups, desiredGroup) => mergeHookGroup(groups, desiredGroup), current);
  }

  await writeFileEnsured(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
}

async function readClaudeSettings(file: string): Promise<ClaudeSettings> {
  const text = await readTextIfExists(file);
  if (!text) return {};

  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? (parsed as ClaudeSettings) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot merge invalid Claude Code settings at ${file}: ${message}`);
  }
}

function mergeHookGroup(existingGroups: ClaudeHookGroup[], desiredGroup: ClaudeHookGroup): ClaudeHookGroup[] {
  const desiredHooks = Array.isArray(desiredGroup.hooks) ? desiredGroup.hooks : [];
  if (desiredHooks.every((hook) => hookExists(existingGroups, hook))) return existingGroups;

  const matcher = typeof desiredGroup.matcher === "string" ? desiredGroup.matcher : "*";
  const groups = [...existingGroups];
  const targetIndex = groups.findIndex((group) => group.matcher === matcher);

  if (targetIndex === -1) return [...groups, desiredGroup];

  const target = groups[targetIndex] ?? { matcher };
  const hooks = Array.isArray(target.hooks) ? [...target.hooks] : [];
  for (const hook of desiredHooks) {
    if (!hookExists(groups, hook)) hooks.push(hook);
  }
  groups[targetIndex] = { ...target, matcher, hooks };
  return groups;
}

function hookExists(groups: ClaudeHookGroup[], desiredHook: ClaudeHook): boolean {
  return groups.some((group) => {
    const hooks = Array.isArray(group.hooks) ? group.hooks : [];
    return hooks.some((hook) => hook.type === desiredHook.type && hook.command === desiredHook.command);
  });
}

function removeMewoFlowHookCommands(groups: ClaudeHookGroup[]): ClaudeHookGroup[] {
  return groups
    .map((group) => {
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      return { ...group, hooks: hooks.filter((hook) => !isMewoFlowHookCommand(hook.command)) };
    })
    .filter((group) => group.hooks.length > 0);
}

function isMewoFlowHookCommand(command: unknown): boolean {
  return typeof command === "string" && /(?:mewoflow-hook\.cjs|\bmewoflow\s+hook\b)/i.test(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentsTemplate(): string {
  return [
    "# Agent Instructions",
    "",
    "This project uses MewoFlow to keep AI development work evidence-driven.",
    "",
    "For standard and complex development tasks, first show the MewoFlow judgment and ask the user whether that judgment has a problem. Do not infer acceptance, rejection, task confirmation, cancellation, or plan approval in hooks from hardcoded natural-language phrases; interpret the user's response and run the explicit MewoFlow CLI state-transition command, then follow the full workflow:",
    "",
    "```txt",
    "judgment-review -> pending-task-confirmation -> research -> grill -> plan -> user-approval -> implement -> verify -> review -> verify -> archive",
    "```",
    "",
    "## How to use MewoFlow",
    "",
    "1. Start or resume by checking state: run `mewoflow status`. If wiring may be stale, run `mewoflow doctor`; use `mewoflow update` to refresh hook runtime/settings while preserving local templates.",
    "2. For a new development request, do not create files immediately. First show the prompt judgment, ask whether it is correct, then run `mewoflow accept-judgment --session <id>` or `mewoflow reject-judgment --reason \"...\" --session <id>`.",
    "3. After accepting a workflow task, run `mewoflow propose-task --title \"...\" --slug \"descriptive-kebab-slug\" --session <id>`, ask the user to confirm, then run `mewoflow confirm-task --session <id>` or `mewoflow cancel-task --session <id>`.",
    "4. For each gate, write the required evidence file in `.mewoflow/tasks/<task-id>/`, then advance with `mewoflow check <gate> --session <id>`. Do not skip from research/grill/plan into implementation.",
    "5. Before implementation, show the plan, record explicit approval with `mewoflow approve-plan --prompt \"...\" --session <id>`, then run `mewoflow check plan --session <id>` and read `.mewoflow/rules.md`, `research.md`, `grill.md`, and `plan.md`.",
    "6. After implementation, complete `verify -> review -> verify -> archive`. If review requires code changes, run `mewoflow rework --reason \"...\" --session <id>` instead of editing during review.",
    "7. If blocked or confused, run `mewoflow status`, inspect the current gate's next required evidence, and let hooks block incomplete work rather than bypassing MewoFlow state.",
    "",
    "Rules:",
    "",
    "- On every new user prompt, first make the MewoFlow judgment visible: decide whether it is a simple request, standard task, or epic task; state the reason; then ask the user whether this judgment has a problem before proposing a task or doing work.",
    "- When AskQuestion is available, prefer it for judgment review, pending task confirmation/cancellation, and plan approval. Treat the selected option as user input evidence only; state still changes only through explicit MewoFlow CLI commands.",
    "- This is command-driven: after interpreting the user's natural-language judgment reply, run `mewoflow accept-judgment --session <id>` or `mewoflow reject-judgment --reason \"...\" --session <id>`. Do not rely on hardcoded acceptance/rejection phrases.",
    "- Do not propose, create task files, or start research until the judgment is resolved by one of those explicit commands.",
    "- For a pending task, first run `mewoflow propose-task --title \"...\" --slug \"descriptive-kebab-slug\" --session <id>`, then ask the user whether to create the task, preferably via AskQuestion. If Claude interprets the user as confirming, run `mewoflow confirm-task --session <id>`; if cancelling, run `mewoflow cancel-task --session <id>`.",
    "- Research must write `## Tool Evidence` and use Claude Code WebSearch, WebFetch, MCP search, a relevant skill, or explicit user-provided sources before planning or implementing.",
    "- During the `grill` gate, use the project-local `grill-me` skill directly; do not merely imitate it.",
    "- Ask and record clarifying questions before locking the plan. Follow the current `grill-me` skill guidance and write concrete question-log evidence, project-specific decision coverage, locked decisions, acceptance criteria, and a stop rationale; coverage labels are examples, not validator field names.",
    "- Record why continuing to ask is now low-value before leaving `grill`; do not require a fixed stop-actor phrase.",
    "- Before finalizing `plan.md`, run a fresh WebSearch/WebFetch/MCP/skill shortcut scan and record `## Shortcut / Existing Solution Scan` plus MVP slice, phases, deferred work, risks, and verification.",
    "- For from-scratch epic projects, keep the first task as the parent epic, list child tasks under `## Parent / Child Task Breakdown`, then split them with `mewoflow split-task --from-plan` after plan approval.",
    "- Show the plan to the user before implementation, preferably asking approval via AskQuestion. If Claude interprets the latest user response as approving the plan, run `mewoflow approve-plan --prompt \"<user approval>\" --session <id>` before `mewoflow check plan`; do not rely on hardcoded approval phrases or option labels.",
    "- Do not edit implementation files before the active task reaches the `implement` gate with plan approval recorded.",
    "- After implementation, run initial `verify`, then write a concrete code `review.md`, use a relevant skill/subagent when suitable, and record Result as `passed`, `needs-work`, or `deferred-with-approval`.",
    "- If review finds high/blocker issues requiring code changes, do not edit during `review`; run `mewoflow rework --reason \"...\"` to return to `implement`. If high risk is explicitly accepted/deferred by the user, record it with `mewoflow approve-deferred-risk --reason \"...\"` before archive.",
    "- Do not claim completion without command evidence, critical-path evidence in `verify.md`, file-by-file review evidence in `review.md`, and no unresolved high/blocker findings unless deferred-risk approval is recorded.",
    "- When the user asks to commit git changes, do not create a workflow task; run `mewoflow commit --message \"<summary>\"`. The command stages current changes, refuses likely secret files, creates a local commit, and never pushes.",
    "- Use `mewoflow status` to inspect the active task.",
    "- Use `mewoflow check <gate>` to advance a gate only after the evidence file is complete.",
    "- Use `mewoflow doctor` to check local wiring.",
    "",
    "Task evidence lives in `.mewoflow/tasks/<task-id>/` until archive; completed task folders move to `.mewoflow/archive/<task-id>/`.",
    "Project rules and compact specs live in `.mewoflow/rules.md`, `.mewoflow/workflow.md`, and `.mewoflow/specs/`.",
    "",
    "MewoFlow hooks are the hard enforcement layer. This file is soft guidance for AI agents.",
  ].join("\n") + "\n";
}

function claudeTemplate(): string {
  return [
    "@AGENTS.md",
    "",
    "## Claude Code",
    "",
    "This project is wired to Claude Code hooks through MewoFlow.",
    "",
    "## MewoFlow runbook for Claude Code",
    "",
    "1. Use `/mewoflow` to initialize, repair, or resume MewoFlow. Use `/mewoflow-doctor` when the user asks whether MewoFlow is healthy.",
    "2. On new development work, report the simple / standard / epic judgment before doing anything else. Prefer AskQuestion for judgment review, but still run `mewoflow accept-judgment` or `mewoflow reject-judgment` after interpreting the response.",
    "3. Confirm task creation only through commands: `mewoflow propose-task --title \"...\" --slug \"...\" --session <id>`, then `mewoflow confirm-task --session <id>` or `mewoflow cancel-task --session <id>`.",
    "4. Work one gate at a time: fill the evidence file, run `mewoflow check <gate> --session <id>`, and follow the next gate reported by the CLI/hook notice.",
    "5. Before editing implementation files, show the plan, record approval with `mewoflow approve-plan --prompt \"...\" --session <id>`, run `mewoflow check plan --session <id>`, and read `.mewoflow/rules.md` plus the active task research/grill/plan files.",
    "6. Do not fix review findings while still in the `review` gate. If code changes are needed, set review evidence appropriately and run `mewoflow rework --reason \"...\" --session <id>` to return to `implement`.",
    "7. If hooks fail or paths look stale, run `mewoflow doctor`; if generated wiring is old, run `mewoflow update`. Remember default update preserves existing AGENTS/CLAUDE/rules/skills templates; use `--force` only when the user wants generated templates overwritten.",
    "",
    "- Use `/mewoflow` to initialize or resume the local MewoFlow workflow entry point.",
    "- Use `/mewoflow-doctor` when asked to verify whether MewoFlow is working.",
    "- Before creating or skipping a task, visibly report the MewoFlow prompt judgment: simple / standard / epic and the reason, then ask whether the judgment has a problem.",
    "- Prefer AskQuestion for judgment review, task confirmation/cancellation, and plan approval when it is available; after reading the selected option, still run the explicit MewoFlow CLI command.",
    "- Do not infer judgment acceptance/rejection from hardcoded reply phrases. Interpret the user's response, then run `mewoflow accept-judgment --session <id>` or `mewoflow reject-judgment --reason \"...\" --session <id>`.",
    "- Pending task ids are not final. Use `mewoflow propose-task --title \"...\" --slug \"descriptive-kebab-slug\" --session <id>` before asking whether to create the task, preferably via AskQuestion. Then run `mewoflow confirm-task --session <id>` or `mewoflow cancel-task --session <id>` based on Claude's interpretation of the user's response.",
    "- Research must use Claude Code WebSearch, WebFetch, MCP search, relevant skill lookup, or explicit user-provided sources before `mewoflow check research`, and must write `## Tool Evidence`.",
    "- Grill must directly use the project-local `grill-me` skill from `.claude/skills/grill-me/SKILL.md` before `mewoflow check grill`.",
    "- New development requests first become a pending judgment review. After `mewoflow accept-judgment`, create only a pending task proposal; ask the user to confirm before research or task file creation.",
    "- Plan must include a fresh shortcut/existing-solution scan and be shown to the user before implementation. Prefer AskQuestion for approval. When Claude interprets the user as approving it, run `mewoflow approve-plan --prompt \"...\" --session <id>` before `mewoflow check plan`.",
    "- From-scratch epic projects should use one parent epic for research/grill/plan, then split child tasks with `mewoflow split-task --from-plan` and complete children one by one.",
    "- Read `.mewoflow/rules.md` and the active task evidence before implementation writes.",
    "- After implementation, complete `verify -> review -> verify -> archive`; `review.md` must cite concrete changed files, severity, decisions, and use a relevant skill/subagent when suitable.",
    "- If review finds high/blocker issues that need code changes, set `Result: needs-work` and run `mewoflow rework --reason \"...\"`; unresolved high/blocker findings cannot be archived unless `mewoflow approve-deferred-risk --reason \"...\"` records explicit user risk acceptance.",
    "- If the user asks to commit git changes, run `npx mewoflow commit --message \"<summary>\"`; do not create a workflow task and do not push.",
    "- Let hooks block incomplete work instead of bypassing the workflow.",
  ].join("\n") + "\n";
}

function rulesTemplate(): string {
  return [
    "# MewoFlow Rules",
    "",
    "- Follow the active task gate.",
    "- Standard and epic tasks must complete: judgment-review -> pending-task-confirmation -> research -> grill -> plan -> user-approval -> implement -> verify -> review -> verify -> archive.",
    "- Before creating or skipping a task, make the MewoFlow prompt judgment visible: simple / standard / epic and why, then ask whether the judgment has a problem.",
    "- Prefer AskQuestion for judgment review, task confirmation/cancellation, and plan approval when it is available. Treat the selected option as user input evidence only; state still changes only through explicit MewoFlow CLI commands.",
    "- Do not infer acceptance/rejection/confirmation/cancellation/plan approval from hardcoded natural-language phrases. Claude interprets the user response, then changes state with explicit commands.",
    "- Resolve prompt judgment with `mewoflow accept-judgment --session <id>` or `mewoflow reject-judgment --reason \"...\" --session <id>` before proposing or creating a task.",
    "- Pending task confirmation requires model-proposed title/slug via `mewoflow propose-task --title \"...\" --slug \"...\" --session <id>`, then `mewoflow confirm-task --session <id>` or `mewoflow cancel-task --session <id>`.",
    "- Use Claude Code WebSearch/WebFetch/MCP, relevant skill lookup, or user-provided sources during research; record them under `## Tool Evidence`.",
    "- Grill must use project-local grill-me and write concrete question-log evidence, project-specific decision coverage, locked decisions, acceptance criteria, and a stop rationale. Coverage labels are not fixed validator field names.",
    "- Before finalizing plan, run a fresh shortcut/existing-solution scan and record MVP slice, phases, deferred work, risks, and verification.",
    "- From-scratch epic projects should keep one parent task, list child tasks in plan, then split children with `mewoflow split-task --from-plan`.",
    "- Show plan to the user before implementation. When Claude interprets approval, record it with `mewoflow approve-plan --prompt \"...\" --session <id>` before `mewoflow check plan`.",
    "- Read this file plus task research/grill/plan before editing.",
    "- After implementation, run initial verify, write `review.md` with concrete file-by-file review and skill/subagent evidence when suitable, then verify again before archive.",
    "- `mewoflow check archive` moves completed task folders to `.mewoflow/archive/<task-id>/`.",
    "- If the user asks to commit git changes, run `mewoflow commit --message \"<summary>\"`; never push unless explicitly requested.",
    "- Do not claim completion without command, critical-path, and review evidence.",
  ].join("\n") + "\n";
}

function workflowTemplate(): string {
  return `# MewoFlow Workflow\n\nnone -> judgment-review -> pending-task-confirmation -> research -> grill -> plan -> user-approval -> implement -> verify -> review -> verify -> archive -> done\n`;
}

function journalTemplate(): string {
  return `# MewoFlow Journal\n\nTask archive summaries are appended here when \`mewoflow check archive\` passes.\n`;
}

function codingSpecTemplate(): string {
  return `# Coding Spec\n\nKeep this file short. Add project-specific coding conventions that AI agents must read before implementation.\n`;
}

function testingSpecTemplate(): string {
  return `# Testing Spec\n\nKeep this file short. Add project-specific testing commands, critical paths, and evidence requirements.\n`;
}

function agentSpecTemplate(): string {
  return `# Agent Spec\n\nKeep this file short. Add project-specific AI workflow expectations, review rules, and known pitfalls.\n`;
}

function hookShimTemplate(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..", "..");
const args = ["hook", ...process.argv.slice(2)];
const localBin = process.platform === "win32"
  ? path.join(projectRoot, "node_modules", ".bin", "mewoflow.cmd")
  : path.join(projectRoot, "node_modules", ".bin", "mewoflow");
const localDist = path.join(projectRoot, "node_modules", "mewoflow", "dist", "src", "cli.js");

const hasLocalDist = fs.existsSync(localDist);
const hasLocalBin = fs.existsSync(localBin);
const command = hasLocalDist ? process.execPath : hasLocalBin ? localBin : "mewoflow";
const commandArgs = hasLocalDist ? [localDist, ...args] : args;
// Windows npm global bins are .cmd shims; cmd.exe is needed to resolve them from PATH.
const useShell = process.platform === "win32" && command === "mewoflow";
const result = spawnSync(command, commandArgs, {
  cwd: projectRoot,
  stdio: "inherit",
  shell: useShell,
  timeout: 10000,
  env: { ...process.env, npm_config_yes: "true" },
});

if (result.error) {
  console.error("MewoFlow hook failed: " + result.error.message);
  process.exit(result.error.code === "ETIMEDOUT" ? 124 : 1);
}
process.exit(result.status ?? 1);
`;
}

function entrySkillTemplate(): string {
  return `---\ndescription: Bootstrap or resume MewoFlow in Claude Code. Use when the user invokes /mewoflow to initialize wiring, verify hooks, and get back to a ready workflow state.\ndisable-model-invocation: true\n---\n\n# MewoFlow\n\nRun this skill when the user invokes \`/mewoflow\` or asks to start or continue MewoFlow in the current project.\n\n## Required flow\n\n1. Check whether \`.mewoflow/rules.md\`, \`.claude/settings.json\`, \`.claude/skills/mewoflow-doctor/SKILL.md\`, and \`.claude/skills/grill-me/SKILL.md\` already exist.\n2. If MewoFlow files, grill-me skill, or hook wiring are missing, run:\n\n\`\`\`bash\nnpx mewoflow init\n\`\`\`\n\n3. Run:\n\n\`\`\`bash\nnpx mewoflow doctor\n\`\`\`\n\n4. If doctor reports a failure, explain the smallest next fix and stop.\n5. If there is an active task, visibly report the task id and current gate, then continue that workflow instead of starting unrelated implementation.\n6. If the active gate is \`grill\`, use the project-local \`grill-me\` skill directly before writing or checking \`grill.md\`.\n7. If there is no active task, tell the user MewoFlow is ready and ask for the concrete development request. Do not start implementing until the user gives a real task.\n`;
}

function grillMeSkillTemplate(): string {
  return [
    "---",
    "name: grill-me",
    "description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions \"grill me\".",
    "---",
    "",
    "Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.",
    "",
    "Ask the questions one at a time.",
    "",
    "Cover the decision areas needed by this task and the current project. Use project-specific coverage labels; they are examples, not fixed validator field names.",
    "",
    "Stop only when additional questions are low-value; record the stop rationale and low-value follow-ups without relying on a fixed actor phrase.",
    "",
    "If a question can be answered by exploring the codebase, explore the codebase instead.",
  ].join("\n") + "\n";
}

function doctorSkillTemplate(): string {
  return `---\ndescription: Run MewoFlow doctor with a forced search-backed health check. Use when the user asks to check whether MewoFlow hooks, workflow files, and search evidence are working.\ndisable-model-invocation: true\n---\n\n# MewoFlow Doctor\n\nRun this skill when the user invokes \`/mewoflow-doctor\` or asks to check whether MewoFlow is working.\n\n## Required flow\n\n1. Use Claude Code WebSearch first. Search for current Claude Code hooks or custom skills documentation so the session records search evidence.\n2. Run:\n\n\`\`\`bash\nnpx mewoflow doctor --require-search\n\`\`\`\n\n3. Report PASS/WARN/FAIL items exactly.\n4. If the doctor fails, explain the smallest next fix. Do not claim MewoFlow is healthy unless the command exits successfully.\n`;
}

function mewoflowHooks(root: string): Record<string, ClaudeHookGroup[]> {
  const command = mewoflowHookCommand(root);
  return {
    UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: `${command} user-prompt-submit` }] }],
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${command} pre-tool-use` }] }],
    PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${command} post-tool-use` }] }],
    Stop: [{ matcher: "*", hooks: [{ type: "command", command: `${command} stop` }] }],
  };
}

function mewoflowHookCommand(root: string): string {
  return `node "${mewoflowHookPath(root)}"`;
}

function mewoflowHookPath(root: string): string {
  return path.join(root, ".mewoflow", "runtime", "mewoflow-hook.cjs").replace(/\\/g, "/");
}
