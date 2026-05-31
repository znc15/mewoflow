import fs from "node:fs/promises";
import path from "node:path";
import { appendFileEnsured, pathExists, readJson, readTextIfExists, writeFileEnsured, writeJson } from "./fs.js";

export type Gate = "research" | "grill" | "plan" | "implement" | "verify" | "archive" | "done";
export type TaskType = "standard" | "epic";

export type OverrideRecord = {
  gate: Gate;
  reason: string;
  at: string;
};

export type Task = {
  id: string;
  title: string;
  type: TaskType;
  gate: Gate;
  created_at: string;
  updated_at: string;
  overrides: OverrideRecord[];
};

export type SessionState = {
  activeTaskId?: string;
  readFiles: string[];
  searchTools: { tool: string; at: string }[];
  commands: string[];
};

const gateAfterCheck: Partial<Record<Gate, Gate>> = {
  research: "grill",
  grill: "plan",
  plan: "implement",
  implement: "verify",
  verify: "archive",
  archive: "done",
};

const chineseMap: Record<string, string> = {
  修: "xiu",
  复: "fu",
  登: "deng",
  录: "lu",
  开: "kai",
  发: "fa",
  音: "yin",
  乐: "yue",
  系: "xi",
  统: "tong",
  工: "gong",
  具: "ju",
  集: "ji",
};

export function mewoflowDir(root: string): string {
  return path.join(root, ".mewoflow");
}

export function taskRoot(root: string): string {
  return path.join(mewoflowDir(root), "tasks");
}

export function taskDir(root: string, taskId: string): string {
  return path.join(taskRoot(root), taskId);
}

export function taskFile(root: string, taskId: string, file: string): string {
  return path.join(taskDir(root, taskId), file);
}

export function sessionFile(root: string, sessionId = "default"): string {
  return path.join(mewoflowDir(root), "runtime", "sessions", `${safeSessionId(sessionId)}.json`);
}

export function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

export function slugify(input: string): string {
  const expanded = Array.from(input)
    .map((char) => (chineseMap[char] ? ` ${chineseMap[char]} ` : char))
    .join("");

  return (
    expanded
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-") || "task"
  );
}

export function todayIsoDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function nextGateForCheck(gate: Gate): Gate | null {
  return gateAfterCheck[gate] ?? null;
}

export async function createTask(root: string, input: { title: string; type: TaskType; now?: Date }): Promise<Task> {
  const now = input.now ?? new Date();
  const date = todayIsoDate(now);
  const baseId = `${date}-${slugify(input.title)}`;
  const id = await uniqueTaskId(root, baseId);
  const iso = now.toISOString();
  const task: Task = {
    id,
    title: input.title,
    type: input.type,
    gate: "research",
    created_at: iso,
    updated_at: iso,
    overrides: [],
  };

  await writeJson(taskFile(root, id, "task.json"), task);
  await writeFileEnsured(taskFile(root, id, "research.md"), researchTemplate());
  await writeFileEnsured(taskFile(root, id, "grill.md"), grillTemplate());
  await writeFileEnsured(taskFile(root, id, "plan.md"), planTemplate());
  await writeFileEnsured(taskFile(root, id, "verify.md"), verifyTemplate());
  await writeFileEnsured(taskFile(root, id, "archive.md"), archiveTemplate());

  return task;
}

export async function loadTask(root: string, taskId: string): Promise<Task> {
  return readJson<Task>(taskFile(root, taskId, "task.json"));
}

export async function saveTask(root: string, task: Task): Promise<void> {
  await writeJson(taskFile(root, task.id, "task.json"), { ...task, updated_at: new Date().toISOString() });
}

export async function advanceTask(root: string, task: Task, nextGate: Gate): Promise<Task> {
  const updated = { ...task, gate: nextGate, updated_at: new Date().toISOString() };
  await writeJson(taskFile(root, task.id, "task.json"), updated);
  return updated;
}

export async function loadSession(root: string, sessionId = "default"): Promise<SessionState> {
  const file = sessionFile(root, sessionId);
  if (!(await pathExists(file))) return { readFiles: [], searchTools: [], commands: [] };
  const session = await readJson<Partial<SessionState>>(file);
  return {
    activeTaskId: session.activeTaskId,
    readFiles: session.readFiles ?? [],
    searchTools: session.searchTools ?? [],
    commands: session.commands ?? [],
  };
}

export async function saveSession(root: string, sessionId: string, session: SessionState): Promise<void> {
  await writeJson(sessionFile(root, sessionId), session);
}

export async function setActiveTask(root: string, taskId: string, sessionId = "default"): Promise<void> {
  const session = await loadSession(root, sessionId);
  await saveSession(root, sessionId, { ...session, activeTaskId: taskId });
  if (sessionId !== "default") {
    const defaultSession = await loadSession(root, "default");
    await saveSession(root, "default", { ...defaultSession, activeTaskId: taskId });
  }
}

export async function getActiveTaskId(root: string, sessionId = "default"): Promise<string | null> {
  const session = await loadSession(root, sessionId);
  if (session.activeTaskId) return session.activeTaskId;
  if (sessionId !== "default") {
    const defaultSession = await loadSession(root, "default");
    if (defaultSession.activeTaskId) return defaultSession.activeTaskId;
  }
  return latestTaskId(root);
}

export async function getActiveTask(root: string, sessionId = "default"): Promise<Task | null> {
  const taskId = await getActiveTaskId(root, sessionId);
  if (!taskId) return null;
  return loadTask(root, taskId);
}

export async function recordReadFile(root: string, sessionId: string, file: string): Promise<void> {
  await updateSession(root, sessionId, (session) => {
    const normalized = normalizePath(file, root);
    return session.readFiles.includes(normalized)
      ? session
      : { ...session, readFiles: [...session.readFiles, normalized] };
  });
}

export async function recordSearchTool(root: string, sessionId: string, tool: string): Promise<void> {
  await updateSession(root, sessionId, (session) => ({
    ...session,
    searchTools: [...session.searchTools, { tool, at: new Date().toISOString() }],
  }));
}

export async function recordCommand(root: string, sessionId: string, command: string): Promise<void> {
  await updateSession(root, sessionId, (session) => ({ ...session, commands: [...session.commands, command] }));
}

export function requiredImplementationReads(task: Task): string[] {
  const base = `.mewoflow/tasks/${task.id}`;
  return [".mewoflow/rules.md", `${base}/research.md`, `${base}/grill.md`, `${base}/plan.md`];
}

export function normalizePath(file: string, root?: string): string {
  let normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (root) {
    const normalizedRoot = path.resolve(root).replace(/\\/g, "/");
    if (normalized === normalizedRoot) return ".";
    if (normalized.startsWith(`${normalizedRoot}/`)) {
      normalized = normalized.slice(normalizedRoot.length + 1);
    }
  }
  return normalized;
}

export async function readTaskMarkdown(root: string, task: Task, file: string): Promise<string> {
  return (await readTextIfExists(taskFile(root, task.id, file))) ?? "";
}

export async function appendArchiveToJournal(root: string, task: Task, archiveText: string): Promise<void> {
  const completedAt = new Date().toISOString();
  const entry = [
    "",
    `## ${todayIsoDate()} ${task.title}`,
    "",
    `- Task: ${task.id}`,
    `- Type: ${task.type}`,
    `- Completed: ${completedAt}`,
    "",
    archiveText.trim(),
    "",
  ].join("\n");
  await appendFileEnsured(path.join(mewoflowDir(root), "journal.md"), entry);
}

async function updateSession(
  root: string,
  sessionId: string,
  updater: (session: SessionState) => SessionState,
): Promise<void> {
  const session = updater(await loadSession(root, sessionId));
  await saveSession(root, sessionId, session);
  if (sessionId !== "default") {
    const defaultSession = updater(await loadSession(root, "default"));
    await saveSession(root, "default", defaultSession);
  }
}

async function latestTaskId(root: string): Promise<string | null> {
  const rootDir = taskRoot(root);
  if (!(await pathExists(rootDir))) return null;
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return dirs.at(-1) ?? null;
}

async function uniqueTaskId(root: string, baseId: string): Promise<string> {
  let id = baseId;
  let counter = 2;
  while (await pathExists(taskDir(root, id))) {
    id = `${baseId}-${counter}`;
    counter += 1;
  }
  return id;
}

function researchTemplate(): string {
  return `# Research\n\n## Search Evidence\n- Tool Used: \n\n## Sources\n| Source | Type | Why It Matters |\n|---|---|---|\n\n## Current Facts\n\n## Impact On This Task\n\n## Unknowns\n`;
}

function grillTemplate(): string {
  return `# Grill\n\n## Q1\nQuestion:\nRecommended Answer:\nUser Answer:\nDecision:\n\n## Locked Decisions\n\n## Acceptance Criteria\n\n## Open Questions\n- None\n`;
}

function planTemplate(): string {
  return `# Plan\n\n## Goal\n\n## Scope\n\n## Non-goals\n\n## Files To Change\n\n## Steps\n\n## Verification\n`;
}

function verifyTemplate(): string {
  return `# Verify\n\n## Result\n- blocked\n\n## Commands Run\n| Command | Result | Evidence |\n|---|---|---|\n\n## Critical Path\n| Path | Result | Evidence |\n|---|---|---|\n\n## Review\nReviewer:\nResult:\nFindings:\n\n## Notes\n`;
}

function archiveTemplate(): string {
  return `# Archive\n\n## Summary\n\n## Decisions\n\n## Verification\n\n## Follow-ups\n\n## Rule Updates\n- none\n`;
}
