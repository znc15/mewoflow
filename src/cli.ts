#!/usr/bin/env node

import { initProject } from "./init.js";
import { runDoctor } from "./doctor.js";
import {
  allChildTasksDone,
  appendArchiveToJournal,
  approvePlan,
  advanceTask,
  confirmPendingTask,
  getActiveTask,
  hasPlanApproval,
  loadSession,
  nextGateForCheck,
  proposePendingTask,
  readTaskMarkdown,
  saveTask,
  splitParentTaskFromPlan,
  type Gate,
} from "./task.js";
import { validateArchive, validateGrill, validatePlan, validateResearch, validateVerify } from "./validators.js";
import {
  MEWOFLOW_NOTICE_FIELD,
  handlePostToolUse,
  handlePreToolUse,
  handleStop,
  handleUserPromptSubmit,
  type HookInput,
} from "./hooks.js";

const version = "0.2.12";

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

  if (command === "status") return printStatus(root);

  if (command === "propose-task") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return proposeTask(root, args);
  }

  if (command === "confirm-task") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return confirmTask(root, optionValue(args, "--session") ?? "default");
  }

  if (command === "approve-plan") {
    const args = [subcommand, ...rest].filter((value): value is string => Boolean(value));
    return approvePlanCommand(root, args);
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
    if (!subcommand) return fail("Usage: mewoflow check <pending-task-confirmation|research|grill|plan|implement|verify|archive>");
    if (subcommand === "pending-task-confirmation") return confirmTask(root, optionValue(rest, "--session") ?? "default");
    if (subcommand === "user-approval") return approvePlanCommand(root, rest);
    return checkGate(root, subcommand as Gate);
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
  if (task.gate !== "plan") return fail(`Current gate is ${task.gate}, not plan.`);
  await approvePlan(root, task.id, sessionId, prompt);
  console.log(`Plan approved. Task: ${task.id}`);
  return 0;
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

async function checkGate(root: string, gate: Gate): Promise<number> {
  const task = await getActiveTask(root);
  if (!task) return fail("No active MewoFlow task.");
  if (task.gate !== gate) return fail(`Current gate is ${task.gate}, not ${gate}.`);

  const session = await loadSession(root);
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
            : gate === "archive"
              ? validateArchive((markdown = await readTaskMarkdown(root, task, "archive.md")), task)
              : { ok: true, errors: [] };

  if (!validation.ok) return fail(validation.errors.join("\n"));

  if (gate === "plan" && !hasPlanApproval(session, task.id)) {
    return fail([
      `Plan for task ${task.id} is valid, but explicit user approval is required before entering implement.`,
      "Show the plan to the user and wait for an approval message such as `确认执行`, `开始实现`, or `同意计划`.",
    ].join("\n"));
  }

  const nextGate = nextGateForCheck(gate);
  if (!nextGate) return fail(`No next gate for ${gate}.`);
  if (gate === "archive" && task.taskRole === "parent" && !(await allChildTasksDone(root, task))) {
    return fail(`Parent task ${task.id} cannot be archived until all child tasks are done.`);
  }
  if (gate === "archive") await appendArchiveToJournal(root, task, markdown);
  await advanceTask(root, task, nextGate);
  console.log(`Gate ${gate} passed. Next gate: ${nextGate}.`);
  return 0;
}

async function overrideGate(root: string, gate: Gate, args: string[]): Promise<number> {
  const task = await getActiveTask(root);
  if (!task) return fail("No active MewoFlow task.");
  if (task.gate !== gate) return fail(`Current gate is ${task.gate}, not ${gate}.`);

  const reason = optionValue(args, "--reason");
  if (!reason) return fail("Override requires --reason.");

  const nextGate = nextGateForCheck(gate);
  if (!nextGate) return fail(`No next gate for ${gate}.`);

  task.overrides.push({ gate, reason, at: new Date().toISOString() });
  await saveTask(root, task);
  await advanceTask(root, task, nextGate);
  console.log(`Gate ${gate} overridden. Next gate: ${nextGate}.`);
  return 0;
}

async function runHook(root: string, event: string): Promise<number> {
  const input = (await readStdinJson()) as HookInput;
  const output =
    event === "user-prompt-submit"
      ? await handleUserPromptSubmit(root, input)
      : event === "pre-tool-use"
        ? await handlePreToolUse(root, input)
        : event === "post-tool-use"
          ? await handlePostToolUse(root, input)
          : event === "stop"
            ? await handleStop(root, input)
            : {};
  const hookOutput = stripMewoFlowNotice(output);
  if (typeof output[MEWOFLOW_NOTICE_FIELD] === "string") console.error(output[MEWOFLOW_NOTICE_FIELD]);
  if (Object.keys(hookOutput).length > 0) console.log(JSON.stringify(hookOutput));
  return 0;
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
  if (index === -1) return null;
  return args[index + 1] ?? null;
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
