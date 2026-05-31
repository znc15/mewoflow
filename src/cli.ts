#!/usr/bin/env node

import { initProject } from "./init.js";
import {
  advanceTask,
  getActiveTask,
  loadSession,
  nextGateForCheck,
  readTaskMarkdown,
  saveTask,
  type Gate,
} from "./task.js";
import { validateArchive, validateGrill, validatePlan, validateResearch, validateVerify } from "./validators.js";
import { handlePostToolUse, handlePreToolUse, handleStop, handleUserPromptSubmit, type HookInput } from "./hooks.js";

const version = "0.1.0";

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

  if (command === "check") {
    if (!subcommand) return fail("Usage: mewoflow check <research|grill|plan|implement|verify|archive>");
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
  console.log(`Task: ${task.id}\nType: ${task.type}\nGate: ${task.gate}`);
  return 0;
}

async function checkGate(root: string, gate: Gate): Promise<number> {
  const task = await getActiveTask(root);
  if (!task) return fail("No active MewoFlow task.");
  if (task.gate !== gate) return fail(`Current gate is ${task.gate}, not ${gate}.`);

  const session = await loadSession(root);
  const validation =
    gate === "research"
      ? validateResearch(await readTaskMarkdown(root, task, "research.md"), session)
      : gate === "grill"
        ? validateGrill(await readTaskMarkdown(root, task, "grill.md"))
        : gate === "plan"
          ? validatePlan(await readTaskMarkdown(root, task, "plan.md"))
          : gate === "verify"
            ? validateVerify(await readTaskMarkdown(root, task, "verify.md"))
            : gate === "archive"
              ? validateArchive(await readTaskMarkdown(root, task, "archive.md"), task)
              : { ok: true, errors: [] };

  if (!validation.ok) return fail(validation.errors.join("\n"));

  const nextGate = nextGateForCheck(gate);
  if (!nextGate) return fail(`No next gate for ${gate}.`);
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
  if (Object.keys(output).length > 0) console.log(JSON.stringify(output));
  return 0;
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
