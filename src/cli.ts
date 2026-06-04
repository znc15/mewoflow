#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { initProject, updateProject, type UpdateResult } from "./init.js";
import { runDoctor } from "./doctor.js";
import {
  acceptPendingJudgment,
  allChildTasksDone,
  appendArchiveToJournal,
  approveDeferredRisk,
  approvePlan,
  advanceTask,
  archiveTask,
  cancelPendingTask,
  confirmPendingTask,
  getActiveTask,
  hasPlanApproval,
  loadSession,
  loadSessionWithDefault,
  nextGateForCheck,
  proposePendingTask,
  readTaskMarkdown,
  rejectPendingJudgment,
  reworkTask,
  saveTask,
  splitParentTaskFromPlan,
  type Gate,
} from "./task.js";
import { validateArchive, validateGrill, validatePlan, validateResearch, validateReview, validateVerify } from "./validators.js";
import {
  MEWOFLOW_NOTICE_FIELD,
  handlePostToolUse,
  handlePreToolUse,
  handleStop,
  handleUserPromptSubmit,
  type HookInput,
} from "./hooks.js";

const execFileAsync = promisify(execFile);

const version = packageVersion();

function packageVersion(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(current, "package.json");
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      // Keep walking up from src/ or dist/src/ until the package root is found.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "0.0.0";
}

export async function main(argv = process.argv.slice(2), root = process.cwd()): Promise<number> {
  const [command, subcommand, ...rest] = argv;

  if (!command || command === "help" || command === "--help") {
    console.log(`mewoflow ${version}\n\nUsage: mewoflow <command>`);
    return 0;
  }

  if (command === "version" || command === "--version") {
    console.log(version);
    return 0;
  }

  if (command === "init") {
    await initProject(root);
    console.log("MewoFlow initialized.");
    return 0;
  }

  if (command === "update") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    const result = await updateProject(root, {
      dryRun: args.includes("--dry-run"),
      force: args.includes("--force") || args.includes("-f"),
    });
    console.log(formatUpdateResult(result));
    return 0;
  }

  if (command === "status") return printStatus(root);

  if (command === "commit") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return commitCommand(root, args);
  }

  if (command === "accept-judgment") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return acceptJudgmentCommand(root, optionValue(args, "--session") ?? "default");
  }

  if (command === "reject-judgment") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return rejectJudgmentCommand(root, args);
  }

  if (command === "propose-task") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return proposeTask(root, args);
  }

  if (command === "cancel-task") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return cancelTaskCommand(root, optionValue(args, "--session") ?? "default");
  }

  if (command === "confirm-task") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return confirmTask(root, optionValue(args, "--session") ?? "default");
  }

  if (command === "approve-plan") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return approvePlanCommand(root, args);
  }

  if (command === "rework") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return reworkCommand(root, args);
  }

  if (command === "approve-deferred-risk") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return approveDeferredRiskCommand(root, args);
  }

  if (command === "split-task") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return splitTaskCommand(root, args);
  }

  if (command === "doctor") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    const report = await runDoctor(root, {
      requireSearch: args.includes("--require-search"),
      sessionId: optionValue(args, "--session") ?? "default",
    });
    console.log(report.text);
    return report.ok ? 0 : 1;
  }

  if (command === "check") {
    if (!subcommand) return fail("Usage: mewoflow check <pending-task-confirmation|research|grill|plan|implement|verify|review|archive>");
    if (subcommand === "pending-task-confirmation") return confirmTask(root, optionValue(rest, "--session") ?? "default");
    if (subcommand === "user-approval") return approvePlanCommand(root, rest);
    return checkGate(root, subcommand as Gate, optionValue(rest, "--session") ?? "default");
  }

  if (command === "override") {
    if (!subcommand) return fail("Usage: mewoflow override <gate> --reason \"...\"");
    return overrideGate(root, subcommand as Gate, rest);
  }

  if (command === "hook") {
    if (!subcommand) return fail("Usage: mewoflow hook <event>");
    return runHook(root, subcommand);
  }

  console.error(`Unknown command: ${command}`);
  return 1;
}

async function printStatus(root: string): Promise<number> {
  const task = await getActiveTask(root);
  if (!task) {
    console.log("No active MewoFlow task.");
    return 0;
  }
  console.log(`Task: ${task.id}\nType: ${task.type}\nRole: ${task.taskRole}\nGate: ${task.gate}`);
  return 0;
}

function formatUpdateResult(result: UpdateResult): string {
  const lines = [
    result.dryRun ? "MewoFlow update dry run." : "MewoFlow update complete.",
    result.force ? "Mode: force overwrite generated templates." : "Mode: preserve local template edits; refresh managed wiring.",
    "Actions:",
  ];

  for (const action of result.actions) {
    lines.push(`- ${action.action} ${action.file}: ${action.reason}`);
  }

  return lines.join("\n");
}

async function acceptJudgmentCommand(root: string, sessionId: string): Promise<number> {
  const result = await acceptPendingJudgment(root, sessionId);
  if (!result) return fail("No pending MewoFlow prompt judgment to accept.");

  if (!result.pendingTask) {
    console.log(`Prompt judgment accepted. Classification: ${result.judgment.classification}. No workflow task created.`);
    return 0;
  }

  console.log([
    "Prompt judgment accepted. Pending task draft created.",
    `Draft: ${result.pendingTask.id}`,
    `Type: ${result.pendingTask.type}`,
    `Draft title: ${result.pendingTask.title}`,
    "Next: mewoflow propose-task --title \"...\" --slug \"kebab-slug\", then mewoflow confirm-task after user confirmation.",
  ].join("\n"));
  return 0;
}

async function rejectJudgmentCommand(root: string, args: string[]): Promise<number> {
  const sessionId = optionValue(args, "--session") ?? "default";
  const reason = optionValue(args, "--reason");
  if (!reason) return fail("Usage: mewoflow reject-judgment --reason \"...\" [--session <id>]");

  const judgment = await rejectPendingJudgment(root, sessionId);
  if (!judgment) return fail("No pending MewoFlow prompt judgment to reject.");

  console.log(`Prompt judgment rejected. Classification: ${judgment.classification}\nReason: ${reason}`);
  return 0;
}

async function proposeTask(root: string, args: string[]): Promise<number> {
  const title = optionValue(args, "--title");
  const slug = optionValue(args, "--slug");
  const sessionId = optionValue(args, "--session") ?? "default";
  if (!title || !slug) return fail("Usage: mewoflow propose-task --title \"...\" --slug \"kebab-slug\" [--session <id>]");

  try {
    const pending = await proposePendingTask(root, { title, slug, sessionId });
    if (!pending) return fail("No pending MewoFlow task to propose title/slug for.");
    console.log(`Pending task proposal recorded. Draft: ${pending.id}\nTitle: ${pending.proposedTitle}\nSlug: ${pending.proposedSlug}`);
    return 0;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function cancelTaskCommand(root: string, sessionId: string): Promise<number> {
  const pendingTask = await cancelPendingTask(root, sessionId);
  if (!pendingTask) return fail("No pending MewoFlow task to cancel.");

  console.log(`Pending task cancelled. Draft: ${pendingTask.id}`);
  return 0;
}

async function confirmTask(root: string, sessionId: string): Promise<number> {
  const task = await confirmPendingTask(root, sessionId);
  if (!task) {
    return fail([
      "No pending MewoFlow task with a model-proposed title/slug to confirm.",
      "First run: mewoflow propose-task --title \"...\" --slug \"kebab-slug\"",
    ].join("\n"));
  }

  console.log(`Pending task confirmed. Task: ${task.id}\nType: ${task.type}\nGate: ${task.gate}`);
  return 0;
}

async function approvePlanCommand(root: string, args: string[]): Promise<number> {
  const sessionId = optionValue(args, "--session") ?? "default";
  const prompt = optionValue(args, "--prompt") ?? "approved via mewoflow approve-plan";
  const task = await getActiveTask(root, sessionId);
  if (!task) return fail("No active MewoFlow task.");
  if (task.gate !== "plan" && task.gate !== "implement") return fail(`Current gate is ${task.gate}. Plan approval is only meaningful at the plan or implement gate (after a rework).`);
  await approvePlan(root, task.id, sessionId, prompt);
  console.log(`Plan approved. Task: ${task.id}`);
  return 0;
}

async function reworkCommand(root: string, args: string[]): Promise<number> {
  const sessionId = optionValue(args, "--session") ?? "default";
  const reason = optionValue(args, "--reason")?.trim();
  if (!reason) return fail("Usage: mewoflow rework --reason \"...\" [--session <id>]");

  const task = await getActiveTask(root, sessionId);
  if (!task) return fail("No active MewoFlow task.");
  if (!isReworkAllowedGate(task.gate)) {
    return fail(`Current gate is ${task.gate}; rework is only allowed from review, verify, or archive.`);
  }

  const updated = await reworkTask(root, task, reason);
  console.log(["Task sent back to implement for rework.", `Task: ${updated.id}`, `From gate: ${task.gate}`, `Reason: ${reason}`].join("\n"));
  return 0;
}

async function approveDeferredRiskCommand(root: string, args: string[]): Promise<number> {
  const sessionId = optionValue(args, "--session") ?? "default";
  const reason = optionValue(args, "--reason")?.trim();
  if (!reason) return fail("Usage: mewoflow approve-deferred-risk --reason \"...\" [--session <id>]");

  const task = await getActiveTask(root, sessionId);
  if (!task) return fail("No active MewoFlow task.");
  if (!isDeferredRiskAllowedGate(task.gate)) {
    return fail(`Current gate is ${task.gate}; deferred risk approval is only allowed after review, verify, or archive evidence exists.`);
  }

  const updated = await approveDeferredRisk(root, task, reason);
  console.log(["Deferred risk approved.", `Task: ${updated.id}`, `Reason: ${reason}`].join("\n"));
  return 0;
}

function isReworkAllowedGate(gate: Gate): boolean {
  return gate === "review" || gate === "verify" || gate === "archive";
}

function isDeferredRiskAllowedGate(gate: Gate): boolean {
  return gate === "review" || gate === "verify" || gate === "archive";
}

async function splitTaskCommand(root: string, args: string[]): Promise<number> {
  if (!args.includes("--from-plan")) return fail("Usage: mewoflow split-task --from-plan [--session <id>]");
  const sessionId = optionValue(args, "--session") ?? "default";
  try {
    const children = await splitParentTaskFromPlan(root, sessionId);
    console.log([`Parent task split into ${children.length} child task(s).`, ...children.map((child) => `- ${child.id}: ${child.title}`)].join("\n"));
    return 0;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function checkGate(root: string, gate: Gate, sessionId = "default"): Promise<number> {
  const task = await getActiveTask(root, sessionId);
  if (!task) return fail("No active MewoFlow task.");
  if (task.gate !== gate) return fail(`Current gate is ${task.gate}, not ${gate}.`);

  const session = await loadSessionWithDefault(root, sessionId);
  let markdown = "";
  const validation =
    gate === "research"
      ? validateResearch((markdown = await readTaskMarkdown(root, task, "research.md")), session)
      : gate === "grill"
        ? validateGrill((markdown = await readTaskMarkdown(root, task, "grill.md")))
        : gate === "plan"
          ? validatePlan((markdown = await readTaskMarkdown(root, task, "plan.md")), session, task)
        : gate === "verify"
          ? validateVerify((markdown = await readTaskMarkdown(root, task, "verify.md")), session, task)
          : gate === "review"
            ? validateReview((markdown = await readTaskMarkdown(root, task, "review.md")), session, task)
            : gate === "archive"
              ? validateArchive((markdown = await readTaskMarkdown(root, task, "archive.md")), task)
              : { ok: true, errors: [] };

  if (!validation.ok) return fail(validation.errors.join("\n"));

  if (gate === "review" && reviewNeedsWork(markdown)) {
    return fail("Review result is needs-work. Do not advance review; run `mewoflow rework --reason \"...\"` to return to implement, or record resolved/deferred findings before checking review again.");
  }

  if (gate === "plan" && !hasPlanApproval(session, task.id)) {
    return fail([
      `Plan for task ${task.id} is valid, but explicit user approval is required before entering implement.`,
      "Show the plan to the user. When Claude determines the latest user response approved it, run `mewoflow approve-plan --prompt \"<user approval>\" --session <session-id>` before `mewoflow check plan`.",
    ].join("\n"));
  }

  const nextGate = nextGateForCheck(gate, task);
  if (!nextGate) return fail(`No next gate for ${gate}.`);
  if (gate === "archive" && task.taskRole === "parent" && !(await allChildTasksDone(root, task))) {
    return fail(`Parent task ${task.id} cannot be archived until all child tasks are done.`);
  }
  if (gate === "archive") await appendArchiveToJournal(root, task, markdown);
  const updatedTask = await advanceTask(root, task, nextGate);
  if (gate === "archive") await archiveTask(root, updatedTask);
  console.log(`Gate ${gate} passed. Next gate: ${nextGate}.`);
  return 0;
}

function reviewNeedsWork(markdown: string): boolean {
  const match = /(?:^|\r?\n)##\s+Result\s*\r?\n([\s\S]*?)(?=\r?\n##\s+|$)/i.exec(markdown);
  return /(?:^|\r?\n)\s*(?:[-*]\s*)?(?:result\s*:\s*)?needs-work\b/i.test(match?.[1] ?? "");
}

async function overrideGate(root: string, gate: Gate, args: string[]): Promise<number> {
  const task = await getActiveTask(root);
  if (!task) return fail("No active MewoFlow task.");
  if (task.gate !== gate) return fail(`Current gate is ${task.gate}, not ${gate}.`);

  const reason = optionValue(args, "--reason");
  if (!reason) return fail("Override requires --reason.");

  const nextGate = nextGateForCheck(gate, task);
  if (!nextGate) return fail(`No next gate for ${gate}.`);

  task.overrides.push({ gate, reason, at: new Date().toISOString() });
  await saveTask(root, task);
  await advanceTask(root, task, nextGate);
  console.log(`Gate ${gate} overridden. Next gate: ${nextGate}.`);
  return 0;
}

async function commitCommand(root: string, args: string[]): Promise<number> {
  const message = optionValue(args, "--message") ?? optionValue(args, "-m");
  const dryRun = args.includes("--dry-run");

  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
    const status = (await git(root, ["status", "--porcelain"])).trim();
    if (!status) return fail("No git changes to commit.");

    const statusLines = status.split(/\r?\n/).filter(Boolean);
    const secretPaths = statusLines.map(statusPath).filter(isLikelySecretPath);
    if (secretPaths.length > 0) {
      return fail(`Refusing to commit likely secret files: ${secretPaths.join(", ")}`);
    }

    const commitMessage = (message?.trim() || autoCommitMessage(statusLines)).trim();
    if (dryRun) {
      console.log(["MewoFlow git commit dry run.", `Message: ${commitMessage}`, "Changed files:", ...statusLines.map((line) => `- ${statusPath(line)}`)].join("\n"));
      return 0;
    }

    await git(root, ["add", "-A"]);
    const stagedFiles = (await git(root, ["diff", "--cached", "--name-only"])).trim();
    if (!stagedFiles) return fail("No staged git changes to commit after git add -A.");

    const output = await git(root, ["commit", "-m", commitMessage]);
    console.log([`MewoFlow git commit created.`, `Message: ${commitMessage}`, output.trim()].filter(Boolean).join("\n"));
    return 0;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd: root });
  return `${stdout}${stderr}`;
}

function autoCommitMessage(statusLines: string[]): string {
  if (statusLines.some((line) => /package(?:-lock)?\.json|src\/cli\.ts|tests\/smoke\.test\.ts/i.test(statusPath(line)))) {
    return "chore: 提交版本与工作流更新";
  }
  return "chore: 提交当前变更";
}

function statusPath(line: string): string {
  const pathText = line.slice(3).trim();
  return pathText.includes(" -> ") ? pathText.split(" -> ").at(-1)!.trim() : pathText;
}

function isLikelySecretPath(file: string): boolean {
  return /(^|[\\/])\.env(?:\.|$)|secret|credential|private[-_]?key|\.pem$|\.key$/i.test(file);
}

async function runHook(root: string, event: string): Promise<number> {
  let output: Record<string, unknown>;
  try {
    const input = (await readStdinJson()) as HookInput;
    output =
      event === "user-prompt-submit"
        ? await handleUserPromptSubmit(root, input)
        : event === "pre-tool-use"
          ? await handlePreToolUse(root, input)
          : event === "post-tool-use"
            ? await handlePostToolUse(root, input)
            : event === "stop"
              ? await handleStop(root, input)
              : {};
  } catch (error) {
    output = safeHookFailureOutput(event, error);
  }
  const hookOutput = stripMewoFlowNotice(output);
  if (typeof output[MEWOFLOW_NOTICE_FIELD] === "string") console.error(output[MEWOFLOW_NOTICE_FIELD]);
  if (Object.keys(hookOutput).length > 0) console.log(JSON.stringify(hookOutput));
  return 0;
}

function safeHookFailureOutput(event: string, error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const hookName = hookEventName(event);
  const reason = `MewoFlow hook ${event || "unknown"} failed safely: ${message}`;
  const output: Record<string, unknown> = {
    [MEWOFLOW_NOTICE_FIELD]: "MewoFlow hook failed safely.",
    additionalContext: reason,
  };
  if (hookName === "PreToolUse") {
    output.hookSpecificOutput = {
      hookEventName: hookName,
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    };
  } else if (hookName) {
    output.hookSpecificOutput = { hookEventName: hookName };
  }
  return output;
}

function hookEventName(event: string): "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | null {
  if (event === "user-prompt-submit") return "UserPromptSubmit";
  if (event === "pre-tool-use") return "PreToolUse";
  if (event === "post-tool-use") return "PostToolUse";
  if (event === "stop") return "Stop";
  return null;
}

function stripMewoFlowNotice(output: Record<string, unknown>): Record<string, unknown> {
  const { [MEWOFLOW_NOTICE_FIELD]: _notice, ...hookOutput } = output;
  return hookOutput;
}

async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index !== -1) return args[index + 1] ?? null;
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : null;
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

if (process.argv[1]) {
  main().then((code) => {
    process.exitCode = code;
  });
}
