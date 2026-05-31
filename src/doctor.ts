import path from "node:path";
import { pathExists, readTextIfExists } from "./fs.js";
import { getActiveTask, loadSession } from "./task.js";

export type DoctorStatus = "PASS" | "WARN" | "FAIL";

export type DoctorCheck = {
  status: DoctorStatus;
  name: string;
  detail: string;
};

export type DoctorOptions = {
  requireSearch?: boolean;
  sessionId?: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
  text: string;
};

type ClaudeHook = {
  command?: unknown;
};

type ClaudeHookGroup = {
  hooks?: unknown;
};

type ClaudeSettings = {
  hooks?: unknown;
};

const requiredFiles = [
  ".mewoflow/rules.md",
  ".mewoflow/workflow.md",
  ".mewoflow/runtime/mewoflow-hook.cjs",
  ".mewoflow/journal.md",
  ".mewoflow/specs/coding.md",
  ".mewoflow/specs/testing.md",
  ".mewoflow/specs/agent.md",
  ".claude/settings.json",
  ".claude/skills/mewoflow-doctor/SKILL.md",
];

const expectedHooks = {
  UserPromptSubmit: 'node ".mewoflow/runtime/mewoflow-hook.cjs" user-prompt-submit',
  PreToolUse: 'node ".mewoflow/runtime/mewoflow-hook.cjs" pre-tool-use',
  PostToolUse: 'node ".mewoflow/runtime/mewoflow-hook.cjs" post-tool-use',
  Stop: 'node ".mewoflow/runtime/mewoflow-hook.cjs" stop',
};

export async function runDoctor(root = process.cwd(), options: DoctorOptions = {}): Promise<DoctorReport> {
  const sessionId = options.sessionId ?? "default";
  const checks: DoctorCheck[] = [];

  checks.push(checkNodeVersion());
  checks.push(...(await checkRequiredFiles(root)));
  checks.push(await checkClaudeHooks(root));
  checks.push(await checkActiveTask(root, sessionId));
  checks.push(await checkSearchEvidence(root, sessionId, options.requireSearch ?? false));

  const ok = checks.every((check) => check.status !== "FAIL");
  return { ok, checks, text: formatDoctorReport(checks) };
}

function checkNodeVersion(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return major >= 18
    ? pass("Node.js", `Detected ${process.versions.node}.`)
    : fail("Node.js", `MewoFlow requires Node.js >=18, detected ${process.versions.node}.`);
}

async function checkRequiredFiles(root: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const file of requiredFiles) {
    checks.push((await pathExists(path.join(root, file))) ? pass(file, "Found.") : fail(file, "Missing. Run `mewoflow init`."));
  }
  return checks;
}

async function checkClaudeHooks(root: string): Promise<DoctorCheck> {
  const settingsFile = path.join(root, ".claude", "settings.json");
  const text = await readTextIfExists(settingsFile);
  if (!text) return fail("Claude Code hooks", "Missing .claude/settings.json. Run `mewoflow init`.");

  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("Claude Code hooks", `Invalid .claude/settings.json: ${message}`);
  }

  const hooks = isRecord(settings) ? (settings as ClaudeSettings).hooks : undefined;
  const missing = Object.entries(expectedHooks)
    .filter(([event, command]) => !hasHookCommand(hooks, event, command))
    .map(([event]) => event);

  return missing.length === 0
    ? pass("Claude Code hooks", "All MewoFlow hook events are configured.")
    : fail("Claude Code hooks", `Missing hook event(s): ${missing.join(", ")}. Run ` + "`mewoflow init`.");
}

async function checkActiveTask(root: string, sessionId: string): Promise<DoctorCheck> {
  try {
    const task = await getActiveTask(root, sessionId);
    if (!task) return warn("Active task", "No active task. This is OK before starting a workflow task.");
    return pass("Active task", `${task.id} (${task.type}) is at gate ${task.gate}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("Active task", `Could not read active task: ${message}`);
  }
}

async function checkSearchEvidence(root: string, sessionId: string, required: boolean): Promise<DoctorCheck> {
  const session = await loadSession(root, sessionId);
  const latest = session.searchTools.at(-1);
  if (latest) return pass("Search evidence", `Last recorded search tool: ${latest.tool} at ${latest.at}.`);
  return required
    ? fail("Search evidence", "No WebSearch/WebFetch/MCP search was recorded in this session.")
    : warn("Search evidence", "No search recorded yet. Use `/mewoflow-doctor` in Claude to force a search-backed check.");
}

function formatDoctorReport(checks: DoctorCheck[]): string {
  const lines = ["MewoFlow Doctor", ""];
  for (const check of checks) {
    lines.push(`${check.status} ${check.name}: ${check.detail}`);
  }
  const failed = checks.filter((check) => check.status === "FAIL").length;
  const warned = checks.filter((check) => check.status === "WARN").length;
  lines.push("", failed === 0 ? `Result: ok (${warned} warning${warned === 1 ? "" : "s"}).` : `Result: failed (${failed} failure${failed === 1 ? "" : "s"}).`);
  return lines.join("\n");
}

function pass(name: string, detail: string): DoctorCheck {
  return { status: "PASS", name, detail };
}

function warn(name: string, detail: string): DoctorCheck {
  return { status: "WARN", name, detail };
}

function fail(name: string, detail: string): DoctorCheck {
  return { status: "FAIL", name, detail };
}

function hasHookCommand(hooks: unknown, event: string, expectedCommand: string): boolean {
  if (!isRecord(hooks)) return false;
  const groups = hooks[event];
  if (!Array.isArray(groups)) return false;

  return groups.some((group: ClaudeHookGroup) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
    return group.hooks.some((hook: ClaudeHook) => isRecord(hook) && hook.command === expectedCommand);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
