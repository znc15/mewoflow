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

export async function initProject(root = process.cwd()): Promise<void> {
  await writeFileIfMissing(path.join(root, "AGENTS.md"), agentsTemplate());
  await writeFileIfMissing(path.join(root, "CLAUDE.md"), claudeTemplate());
  await writeFileIfMissing(path.join(root, ".mewoflow", "rules.md"), rulesTemplate());
  await writeFileIfMissing(path.join(root, ".mewoflow", "workflow.md"), workflowTemplate());
  await writeFileIfMissing(path.join(root, ".mewoflow", "journal.md"), journalTemplate());
  await writeFileIfMissing(path.join(root, ".mewoflow", "specs", "coding.md"), codingSpecTemplate());
  await writeFileIfMissing(path.join(root, ".mewoflow", "specs", "testing.md"), testingSpecTemplate());
  await writeFileIfMissing(path.join(root, ".mewoflow", "specs", "agent.md"), agentSpecTemplate());
  await writeFileEnsured(path.join(root, ".mewoflow", "tasks", ".gitkeep"), "");
  await writeFileEnsured(path.join(root, ".mewoflow", "runtime", "sessions", ".gitkeep"), "");
  await writeFileEnsured(path.join(root, ".mewoflow", "runtime", "mewoflow-hook.cjs"), hookShimTemplate());
  await writeFileIfMissing(path.join(root, ".claude", "skills", "mewoflow", "SKILL.md"), entrySkillTemplate());
  await writeFileIfMissing(path.join(root, ".claude", "skills", "mewoflow-doctor", "SKILL.md"), doctorSkillTemplate());
  await writeFileIfMissing(path.join(root, ".claude", "skills", "grill-me", "SKILL.md"), grillMeSkillTemplate());
  await writeMergedClaudeSettings(path.join(root, ".claude", "settings.json"));
}

async function writeFileIfMissing(file: string, content: string): Promise<void> {
  if (await pathExists(file)) return;
  await writeFileEnsured(file, content);
}

async function writeMergedClaudeSettings(file: string): Promise<void> {
  const settings = await readClaudeSettings(file);
  const rawHooks = isRecord(settings.hooks) ? settings.hooks : {};
  const hooks: Record<string, ClaudeHookGroup[]> = {};

  for (const [event, groups] of Object.entries(rawHooks)) {
    hooks[event] = Array.isArray(groups) ? (groups as ClaudeHookGroup[]) : [];
  }

  for (const [event, desiredGroups] of Object.entries(mewoflowHooks())) {
    const current = hooks[event] ?? [];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentsTemplate(): string {
  return [
    "# Agent Instructions",
    "",
    "This project uses MewoFlow to keep AI development work evidence-driven.",
    "",
    "For standard and complex development tasks, first show the MewoFlow judgment and ask the user whether that judgment has a problem. After the user accepts the judgment, ask the user to confirm task creation, then follow the full workflow:",
    "",
    "```txt",
    "judgment-review -> pending-task-confirmation -> research -> grill -> plan -> user-approval -> implement -> verify -> archive",
    "```",
    "",
    "Rules:",
    "",
    "- On every new user prompt, first make the MewoFlow judgment visible: decide whether it is a simple request, standard task, or epic task; state the reason; then ask the user whether this judgment has a problem before proposing a task or doing work.",
    "- If the user says the judgment is wrong, ask for the corrected classification or clarified request. Do not propose or create a task until the judgment is accepted.",
    "- Do not create task files or start research until the user explicitly accepts the judgment and then confirms the proposed MewoFlow task.",
    "- For a pending task, first run `mewoflow propose-task --title \"...\" --slug \"descriptive-kebab-slug\"`, then ask for/consume user confirmation with `mewoflow confirm-task` or `mewoflow check pending-task-confirmation`.",
    "- Research must write `## Tool Evidence` and use Claude Code WebSearch, WebFetch, MCP search, a relevant skill, or explicit user-provided sources before planning or implementing.",
    "- During the `grill` gate, use the project-local `grill-me` skill directly; do not merely imitate it.",
    "- Ask and record clarifying questions before locking the plan; cover product goal, MVP scope, non-goals, navigation, data source, interactions, UI/responsive behavior, empty/error states, testing/acceptance, risks, budget/timebox, infra/deployment, security/privacy, and failure modes/rollback.",
    "- Record that the model/assistant decided no meaningful questions remain before leaving `grill`.",
    "- Before finalizing `plan.md`, run a fresh WebSearch/WebFetch/MCP/skill shortcut scan and record `## Shortcut / Existing Solution Scan` plus MVP slice, phases, deferred work, risks, and verification.",
    "- For from-scratch epic projects, keep the first task as the parent epic, list child tasks under `## Parent / Child Task Breakdown`, then split them with `mewoflow split-task --from-plan` after plan approval.",
    "- Show the plan to the user and wait for explicit approval before running `mewoflow check plan` or entering implementation.",
    "- If plan approval was collected through structured UI, run `mewoflow approve-plan --prompt \"...\"` before `mewoflow check plan`.",
    "- Do not edit implementation files before the active task reaches the `implement` gate with plan approval recorded.",
    "- Do not claim completion without command evidence, critical-path evidence, and review notes in `verify.md`.",
    "- Use `mewoflow status` to inspect the active task.",
    "- Use `mewoflow check <gate>` to advance a gate only after the evidence file is complete.",
    "- Use `mewoflow doctor` to check local wiring.",
    "",
    "Task evidence lives in `.mewoflow/tasks/<task-id>/`.",
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
    "- Use `/mewoflow` to initialize or resume the local MewoFlow workflow entry point.",
    "- Use `/mewoflow-doctor` when asked to verify whether MewoFlow is working.",
    "- Before creating or skipping a task, visibly report the MewoFlow prompt judgment: simple / standard / epic and the reason, then ask whether the judgment has a problem.",
    "- Do not propose a task until the user accepts the prompt judgment. If the user says the judgment is wrong, ask for the corrected classification or clarified request first.",
    "- Pending task ids are not final. Use `mewoflow propose-task --title \"...\" --slug \"descriptive-kebab-slug\"` before `mewoflow confirm-task` or `mewoflow check pending-task-confirmation`.",
    "- Research must use Claude Code WebSearch, WebFetch, MCP search, relevant skill lookup, or explicit user-provided sources before `mewoflow check research`, and must write `## Tool Evidence`.",
    "- Grill must directly use the project-local `grill-me` skill from `.claude/skills/grill-me/SKILL.md` before `mewoflow check grill`.",
    "- New development requests first become a pending judgment review. After the user accepts the judgment, create only a pending task proposal; ask the user to confirm before research or task file creation.",
    "- Plan must include a fresh shortcut/existing-solution scan and be shown to the user before explicit approval. Use `mewoflow approve-plan --prompt \"...\"` when approval is captured structurally.",
    "- From-scratch epic projects should use one parent epic for research/grill/plan, then split child tasks with `mewoflow split-task --from-plan` and complete children one by one.",
    "- Read `.mewoflow/rules.md` and the active task evidence before implementation writes.",
    "- Let hooks block incomplete work instead of bypassing the workflow.",
  ].join("\n") + "\n";
}

function rulesTemplate(): string {
  return `# MewoFlow Rules\n\n- Follow the active task gate.\n- Standard and epic tasks must complete: judgment-review -> pending-task-confirmation -> research -> grill -> plan -> user-approval -> implement -> verify -> archive.\n- Before creating or skipping a task, make the MewoFlow prompt judgment visible: simple / standard / epic and why, then ask whether the judgment has a problem.\n- If the user says the judgment is wrong, ask for the corrected classification or clarified request before proposing or creating a task.\n- Do not create a task or start research until the user accepts the prompt judgment and then confirms the pending task proposal.\n- Pending task confirmation requires a model-proposed title/slug via \`mewoflow propose-task --title \"...\" --slug \"...\"\` before \`mewoflow confirm-task\` or \`mewoflow check pending-task-confirmation\`.\n- Use Claude Code WebSearch/WebFetch/MCP, relevant skill lookup, or user-provided sources during research; record them under \`## Tool Evidence\`.\n- Grill must use project-local grill-me, cover product/testing/risk/budget/infra/security/failure decisions, and record model/assistant stop judgment.\n- Before finalizing plan, run a fresh shortcut/existing-solution scan and record MVP slice, phases, deferred work, risks, and verification.\n- From-scratch epic projects should keep one parent task, list child tasks in plan, then split children with \`mewoflow split-task --from-plan\`.\n- Show plan to the user and record explicit approval before implementation; use \`mewoflow approve-plan --prompt \"...\"\` for structured approval.\n- Read this file plus task research/grill/plan before editing.\n- Do not claim completion without command, critical-path, and review evidence.\n`;
}

function workflowTemplate(): string {
  return `# MewoFlow Workflow\n\nnone -> judgment-review -> pending-task-confirmation -> research -> grill -> plan -> user-approval -> implement -> verify -> archive -> done\n`;
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
  return `#!/usr/bin/env node\nconst { spawnSync } = require("node:child_process");\nconst result = spawnSync("npx", ["mewoflow", "hook", ...process.argv.slice(2)], { stdio: "inherit", shell: true });\nprocess.exit(result.status ?? 1);\n`;
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
    "Cover product goal, MVP scope, non-goals, pages/navigation, data source, core interactions, UI/responsive behavior, empty/error states, testing/acceptance, risks, budget/timebox, infra/deployment, security/privacy, and failure modes/rollback.",
    "",
    "Stop only when model/assistant judgment says additional questions are low-value; record that judgment and the low-value follow-ups.",
    "",
    "If a question can be answered by exploring the codebase, explore the codebase instead.",
  ].join("\n") + "\n";
}

function doctorSkillTemplate(): string {
  return `---\ndescription: Run MewoFlow doctor with a forced search-backed health check. Use when the user asks to check whether MewoFlow hooks, workflow files, and search evidence are working.\ndisable-model-invocation: true\n---\n\n# MewoFlow Doctor\n\nRun this skill when the user invokes \`/mewoflow-doctor\` or asks to check whether MewoFlow is working.\n\n## Required flow\n\n1. Use Claude Code WebSearch first. Search for current Claude Code hooks or custom skills documentation so the session records search evidence.\n2. Run:\n\n\`\`\`bash\nnpx mewoflow doctor --require-search\n\`\`\`\n\n3. Report PASS/WARN/FAIL items exactly.\n4. If the doctor fails, explain the smallest next fix. Do not claim MewoFlow is healthy unless the command exits successfully.\n`;
}

function mewoflowHooks(): Record<string, ClaudeHookGroup[]> {
  const command = 'node ".mewoflow/runtime/mewoflow-hook.cjs"';
  return {
    UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: `${command} user-prompt-submit` }] }],
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${command} pre-tool-use` }] }],
    PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${command} post-tool-use` }] }],
    Stop: [{ matcher: "*", hooks: [{ type: "command", command: `${command} stop` }] }],
  };
}
