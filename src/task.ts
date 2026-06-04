import fs from "node:fs/promises";
import path from "node:path";
import { appendFileEnsured, pathExists, readJson, readTextIfExists, writeFileEnsured, writeJson } from "./fs.js";

export type Gate = "research" | "grill" | "plan" | "implement" | "verify" | "review" | "archive" | "done";
export type TaskType = "standard" | "epic";
export type TaskRole = "standard" | "parent" | "child";

export type OverrideRecord = {
  gate: Gate;
  reason: string;
  at: string;
};

export type ReworkRecord = {
  fromGate: Gate;
  reason: string;
  at: string;
};

export type DeferredRiskApproval = {
  reason: string;
  approved_at: string;
};

export type Task = {
  id: string;
  title: string;
  type: TaskType;
  taskRole: TaskRole;
  parentTaskId?: string;
  childTaskIds: string[];
  gate: Gate;
  reviewed: boolean;
  created_at: string;
  updated_at: string;
  overrides: OverrideRecord[];
  reworks: ReworkRecord[];
  deferredRiskApprovals: DeferredRiskApproval[];
};

export type PendingTask = {
  id: string;
  title: string;
  proposedTitle?: string;
  proposedSlug?: string;
  type: TaskType;
  prompt: string;
  created_at: string;
};

export type PendingJudgment = {
  prompt: string;
  classification: TaskType | "simple";
  requiresWorkflow: boolean;
  reason: string;
  created_at: string;
};

export type PlanApproval = {
  approved_at: string;
  prompt: string;
};

export type ToolEvidence = {
  tool: string;
  at: string;
  query?: string;
  taskId?: string;
  gate?: Gate;
};

export type SkillUse = {
  skill: string;
  at: string;
  taskId?: string;
  gate?: Gate;
};

export type CommandRecord = {
  command: string;
  at: string;
  taskId?: string;
  gate?: Gate;
};

export type SessionState = {
  activeTaskId?: string;
  pendingJudgment?: PendingJudgment;
  pendingTask?: PendingTask;
  planApprovals: Record<string, PlanApproval>;
  readFiles: string[];
  searchTools: ToolEvidence[];
  skillUses: SkillUse[];
  commands: CommandRecord[];
};

const gateAfterCheck: Partial<Record<Gate, Gate>> = {
  research: "grill",
  grill: "plan",
  plan: "implement",
  implement: "verify",
  review: "verify",
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

export function archiveRoot(root: string): string {
  return path.join(mewoflowDir(root), "archive");
}

export function taskDir(root: string, taskId: string): string {
  return path.join(taskRoot(root), taskId);
}

export function archivedTaskDir(root: string, taskId: string): string {
  return path.join(archiveRoot(root), taskId);
}

export function taskFile(root: string, taskId: string, file: string): string {
  return path.join(taskDir(root, taskId), file);
}

export function archivedTaskFile(root: string, taskId: string, file: string): string {
  return path.join(archivedTaskDir(root, taskId), file);
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

export function nextGateForCheck(gate: Gate, task?: Task): Gate | null {
  if (gate === "verify") return task?.reviewed ? "archive" : "review";
  return gateAfterCheck[gate] ?? null;
}

export async function createTask(
  root: string,
  input: { title: string; type: TaskType; now?: Date; id?: string; taskRole?: TaskRole; parentTaskId?: string; gate?: Gate },
): Promise<Task> {
  const now = input.now ?? new Date();
  const date = todayIsoDate(now);
  const baseId = `${date}-${slugify(input.title)}`;
  const id = input.id && !(await taskIdExists(root, input.id)) ? input.id : await uniqueTaskId(root, baseId);
  const iso = now.toISOString();
  const taskRole = input.taskRole ?? (input.type === "epic" ? "parent" : "standard");
  const task: Task = {
    id,
    title: input.title,
    type: input.type,
    taskRole,
    parentTaskId: input.parentTaskId,
    childTaskIds: [],
    gate: input.gate ?? "research",
    reviewed: false,
    created_at: iso,
    updated_at: iso,
    overrides: [],
    reworks: [],
    deferredRiskApprovals: [],
  };

  await writeJson(taskFile(root, id, "task.json"), task);
  await writeFileEnsured(taskFile(root, id, "research.md"), researchTemplate());
  await writeFileEnsured(taskFile(root, id, "grill.md"), grillTemplate());
  await writeFileEnsured(taskFile(root, id, "plan.md"), planTemplate());
  await writeFileEnsured(taskFile(root, id, "verify.md"), verifyTemplate());
  await writeFileEnsured(taskFile(root, id, "review.md"), reviewTemplate());
  await writeFileEnsured(taskFile(root, id, "archive.md"), archiveTemplate());

  return task;
}

export async function createPendingTask(root: string, input: { title: string; type: TaskType; prompt: string; now?: Date }): Promise<PendingTask> {
  const now = input.now ?? new Date();
  const id = `draft-${todayIsoDate(now)}-${now.getTime().toString(36)}`;
  return { id, title: input.title, type: input.type, prompt: input.prompt, created_at: now.toISOString() };
}

export function validateTaskSlug(slug: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(slug)) {
    return "Task slug must be 3-60 chars of lowercase letters, numbers, and single hyphens, with no leading or trailing hyphen.";
  }
  if (slug.includes("--")) return "Task slug cannot contain consecutive hyphens.";
  if (slug === "task" || slug.startsWith("draft-")) return "Task slug must describe the task and cannot be a generic or draft slug.";
  return null;
}

export async function proposePendingTask(root: string, input: { title: string; slug: string; sessionId?: string }): Promise<PendingTask | null> {
  const sessionId = input.sessionId ?? "default";
  const pendingTask = await findPendingTask(root, sessionId);
  if (!pendingTask) return null;

  const slugError = validateTaskSlug(input.slug);
  if (slugError) throw new Error(slugError);

  const updated: PendingTask = { ...pendingTask, proposedTitle: input.title.trim(), proposedSlug: input.slug.trim() };
  await setPendingTaskForMatchingSessions(root, pendingTask.id, updated);
  return updated;
}

export async function loadTask(root: string, taskId: string): Promise<Task> {
  return normalizeTask(await readJson<Partial<Task>>(await taskJsonPath(root, taskId)));
}

export async function saveTask(root: string, task: Task): Promise<void> {
  await writeJson(await taskJsonPath(root, task.id), { ...task, updated_at: new Date().toISOString() });
}

export async function advanceTask(root: string, task: Task, nextGate: Gate): Promise<Task> {
  const updated = {
    ...task,
    gate: nextGate,
    reviewed: nextGate === "implement" ? false : task.reviewed || (task.gate === "review" && nextGate === "verify"),
    updated_at: new Date().toISOString(),
  };
  await writeJson(await taskJsonPath(root, task.id), updated);
  return updated;
}

export async function reworkTask(root: string, task: Task, reason: string): Promise<Task> {
  const updated: Task = {
    ...task,
    gate: "implement",
    reviewed: false,
    reworks: [...task.reworks, { fromGate: task.gate, reason, at: new Date().toISOString() }],
    updated_at: new Date().toISOString(),
  };
  await writeJson(await taskJsonPath(root, task.id), updated);
  return updated;
}

export async function approveDeferredRisk(root: string, task: Task, reason: string): Promise<Task> {
  const updated: Task = {
    ...task,
    deferredRiskApprovals: [...task.deferredRiskApprovals, { reason, approved_at: new Date().toISOString() }],
    updated_at: new Date().toISOString(),
  };
  await writeJson(await taskJsonPath(root, task.id), updated);
  return updated;
}

export async function archiveTask(root: string, task: Task): Promise<void> {
  const source = taskDir(root, task.id);
  const destination = archivedTaskDir(root, task.id);
  if (!(await pathExists(source))) {
    if (await pathExists(destination)) return;
    throw new Error(`Cannot archive missing task directory: ${task.id}`);
  }
  if (await pathExists(destination)) {
    throw new Error(`Archive directory already exists for task ${task.id}. Refusing to overwrite it.`);
  }
  await fs.mkdir(archiveRoot(root), { recursive: true });
  await fs.rename(source, destination);
}

export async function loadSession(root: string, sessionId = "default"): Promise<SessionState> {
  const file = sessionFile(root, sessionId);
  if (!(await pathExists(file))) return emptySessionState();
  try {
    const session = await readJson<Partial<SessionState>>(file);
    return normalizeSessionState(session);
  } catch {
    const session = emptySessionState();
    await writeJson(file, session);
    return session;
  }
}

export async function saveSession(root: string, sessionId: string, session: SessionState): Promise<void> {
  await writeJson(sessionFile(root, sessionId), session);
}

export async function setActiveTask(root: string, taskId: string, sessionId = "default"): Promise<void> {
  const session = await loadSession(root, sessionId);
  await saveSession(root, sessionId, { ...session, activeTaskId: taskId, pendingJudgment: undefined, pendingTask: undefined });
  if (sessionId !== "default") {
    const defaultSession = await loadSession(root, "default");
    await saveSession(root, "default", { ...defaultSession, activeTaskId: taskId, pendingJudgment: undefined, pendingTask: undefined });
  }
}

export async function setPendingJudgment(root: string, pendingJudgment: PendingJudgment, sessionId = "default"): Promise<void> {
  const session = await loadSession(root, sessionId);
  await saveSession(root, sessionId, { ...session, pendingJudgment });
  if (sessionId !== "default") {
    const defaultSession = await loadSession(root, "default");
    await saveSession(root, "default", { ...defaultSession, pendingJudgment });
  }
}

export async function clearPendingJudgment(root: string, sessionId = "default"): Promise<void> {
  const session = await loadSession(root, sessionId);
  await saveSession(root, sessionId, { ...session, pendingJudgment: undefined });
  if (sessionId !== "default") {
    const defaultSession = await loadSession(root, "default");
    await saveSession(root, "default", { ...defaultSession, pendingJudgment: undefined });
  }
}

export async function setPendingTask(root: string, pendingTask: PendingTask, sessionId = "default"): Promise<void> {
  const session = await loadSession(root, sessionId);
  await saveSession(root, sessionId, { ...session, pendingJudgment: undefined, pendingTask });
  if (sessionId !== "default") {
    const defaultSession = await loadSession(root, "default");
    await saveSession(root, "default", { ...defaultSession, pendingJudgment: undefined, pendingTask });
  }
}

export async function clearPendingTask(root: string, sessionId = "default"): Promise<void> {
  const session = await loadSession(root, sessionId);
  await saveSession(root, sessionId, { ...session, pendingTask: undefined });
  if (sessionId !== "default") {
    const defaultSession = await loadSession(root, "default");
    await saveSession(root, "default", { ...defaultSession, pendingTask: undefined });
  }
}

export async function acceptPendingJudgment(root: string, sessionId = "default"): Promise<{ judgment: PendingJudgment; pendingTask?: PendingTask } | null> {
  const session = await loadSession(root, sessionId);
  const defaultJudgment = sessionId !== "default" && !session.pendingJudgment ? (await loadSession(root, "default")).pendingJudgment : undefined;
  const judgment = session.pendingJudgment ?? defaultJudgment;
  if (!judgment) return null;

  if (judgment.classification === "simple") {
    await clearPendingJudgment(root, sessionId);
    return { judgment };
  }

  const pendingTask = await createPendingTask(root, {
    title: judgment.prompt,
    type: judgment.classification,
    prompt: judgment.prompt,
  });
  await setPendingTask(root, pendingTask, sessionId);
  return { judgment, pendingTask };
}

export async function rejectPendingJudgment(root: string, sessionId = "default"): Promise<PendingJudgment | null> {
  const session = await loadSession(root, sessionId);
  const defaultJudgment = sessionId !== "default" && !session.pendingJudgment ? (await loadSession(root, "default")).pendingJudgment : undefined;
  const judgment = session.pendingJudgment ?? defaultJudgment;
  if (!judgment) return null;

  await clearPendingJudgment(root, sessionId);
  return judgment;
}

export async function cancelPendingTask(root: string, sessionId = "default"): Promise<PendingTask | null> {
  const pendingTask = await findPendingTask(root, sessionId);
  if (!pendingTask) return null;

  await clearPendingTask(root, sessionId);
  return pendingTask;
}

export async function confirmPendingTask(root: string, sessionId = "default"): Promise<Task | null> {
  const pendingTask = await findPendingTask(root, sessionId);
  if (!pendingTask) return null;
  if (!pendingTask.proposedTitle || !pendingTask.proposedSlug) return null;

  const slugError = validateTaskSlug(pendingTask.proposedSlug);
  if (slugError) throw new Error(slugError);

  const date = todayIsoDate(new Date(pendingTask.created_at));
  const role = pendingTask.type === "epic" ? "parent" : "standard";
  const task = await createTask(root, {
    title: pendingTask.proposedTitle,
    type: pendingTask.type,
    id: `${date}-${pendingTask.proposedSlug}`,
    taskRole: role,
    now: new Date(pendingTask.created_at),
  });
  await setActiveTask(root, task.id, sessionId);
  await setActiveTaskForMatchingPendingSessions(root, pendingTask.id, task.id);
  return task;
}

export async function approvePlan(root: string, taskId: string, sessionId: string, prompt: string): Promise<void> {
  const approval = { approved_at: new Date().toISOString(), prompt };
  const session = await loadSession(root, sessionId);
  await saveSession(root, sessionId, { ...session, planApprovals: { ...session.planApprovals, [taskId]: approval } });
  if (sessionId !== "default") {
    const defaultSession = await loadSession(root, "default");
    await saveSession(root, "default", { ...defaultSession, planApprovals: { ...defaultSession.planApprovals, [taskId]: approval } });
  }
}

export function hasPlanApproval(session: SessionState, taskId: string): boolean {
  return Boolean(session.planApprovals[taskId]);
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

export async function recordSearchTool(root: string, sessionId: string, tool: string, query?: string): Promise<void> {
  const task = await getActiveTask(root, sessionId);
  await updateSession(root, sessionId, (session) => ({
    ...session,
    searchTools: [...session.searchTools, { tool, query, taskId: task?.id, gate: task?.gate, at: new Date().toISOString() }],
  }));
}

export async function recordCommand(root: string, sessionId: string, command: string): Promise<void> {
  const task = await getActiveTask(root, sessionId);
  await updateSession(root, sessionId, (session) => ({
    ...session,
    commands: [...session.commands, { command, taskId: task?.id, gate: task?.gate, at: new Date().toISOString() }],
  }));
}

export async function recordSkillUse(root: string, sessionId: string, skill: string): Promise<void> {
  const task = await getActiveTask(root, sessionId);
  await updateSession(root, sessionId, (session) => ({
    ...session,
    skillUses: [...session.skillUses, { skill, taskId: task?.id, gate: task?.gate, at: new Date().toISOString() }],
  }));
}

export async function splitParentTaskFromPlan(root: string, sessionId = "default"): Promise<Task[]> {
  const parent = await getActiveTask(root, sessionId);
  if (!parent) throw new Error("No active MewoFlow task.");
  if (parent.taskRole !== "parent") throw new Error("Only parent epic tasks can be split into child tasks.");
  if (parent.gate !== "implement") throw new Error("Parent task must pass plan approval and reach implement before splitting child tasks.");
  if (parent.childTaskIds.length > 0) return Promise.all(parent.childTaskIds.map((id) => loadTask(root, id)));

  const plan = await readTaskMarkdown(root, parent, "plan.md");
  const titles = extractChildTaskTitles(plan);
  if (titles.length === 0) throw new Error("Plan must list child tasks under `## Parent / Child Task Breakdown` before splitting.");

  const children: Task[] = [];
  for (const title of titles) {
    const child = await createTask(root, {
      title,
      type: "standard",
      taskRole: "child",
      parentTaskId: parent.id,
      gate: "implement",
    });
    await approvePlan(root, child.id, sessionId, `Approved by parent epic plan ${parent.id}.`);
    children.push(child);
  }

  await saveTask(root, { ...parent, childTaskIds: children.map((child) => child.id) });
  if (children[0]) await setActiveTask(root, children[0].id, sessionId);
  return children;
}

export async function allChildTasksDone(root: string, task: Task): Promise<boolean> {
  if (task.childTaskIds.length === 0) return true;
  const children = await Promise.all(task.childTaskIds.map((id) => loadTask(root, id)));
  return children.every((child) => child.gate === "done");
}

function extractChildTaskTitles(plan: string): string[] {
  const section = markdownSection(plan, "Parent / Child Task Breakdown");
  if (!section) return [];

  const titles: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^\|?\s*-{3,}/.test(trimmed)) continue;

    let title = "";
    if (trimmed.startsWith("|")) {
      const cells = trimmed
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      const firstCell = cells[0] ?? "";
      if (/^(child\s*task|child|task|子任务|阶段|title|标题)$/i.test(firstCell)) continue;
      title = firstCell;
    } else {
      const listMatch = /^(?:[-*]|\d+[.)])\s+(.*)$/.exec(trimmed);
      if (listMatch) title = listMatch[1] ?? "";
    }

    const cleanTitle = cleanChildTitle(title);
    if (!cleanTitle || isPlaceholderTitle(cleanTitle) || titles.includes(cleanTitle)) continue;
    titles.push(cleanTitle);
  }

  return titles.slice(0, 20);
}

function markdownSection(text: string, title: string): string {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\r?\\n)##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, "i").exec(text);
  return match?.[1]?.trim() ?? "";
}

function cleanChildTitle(title: string): string {
  return title
    .replace(/^\[[ x-]\]\s*/i, "")
    .replace(/^(?:child|task|phase|子任务|阶段)\s*\d*\s*[:：-]\s*/i, "")
    .replace(/`/g, "")
    .trim();
}

function isPlaceholderTitle(title: string): boolean {
  return /^(tbd|todo|none|n\/a|待定|无|暂无|placeholder)$/i.test(title.trim());
}

export function requiredImplementationReads(task: Task): string[] {
  const base = `.mewoflow/tasks/${task.parentTaskId ?? task.id}`;
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
  return (await readTextIfExists(await taskMarkdownPath(root, task.id, file))) ?? "";
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

async function findPendingTask(root: string, sessionId: string): Promise<PendingTask | null> {
  const session = await loadSession(root, sessionId);
  if (session.pendingTask) return session.pendingTask;

  if (sessionId !== "default") {
    const defaultSession = await loadSession(root, "default");
    if (defaultSession.pendingTask) return defaultSession.pendingTask;
  }

  const sessionsDir = path.dirname(sessionFile(root, "default"));
  if (!(await pathExists(sessionsDir))) return null;
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const candidate = await loadSession(root, path.basename(entry.name, ".json"));
    if (candidate.pendingTask) return candidate.pendingTask;
  }
  return null;
}

async function setActiveTaskForMatchingPendingSessions(root: string, pendingTaskId: string, taskId: string): Promise<void> {
  const sessionsDir = path.dirname(sessionFile(root, "default"));
  if (!(await pathExists(sessionsDir))) return;
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const sessionId = path.basename(entry.name, ".json");
    const session = await loadSession(root, sessionId);
    if (session.pendingTask?.id !== pendingTaskId) continue;
    await saveSession(root, sessionId, { ...session, activeTaskId: taskId, pendingTask: undefined });
  }
}

async function setPendingTaskForMatchingSessions(root: string, pendingTaskId: string, pendingTask: PendingTask): Promise<void> {
  const sessionsDir = path.dirname(sessionFile(root, "default"));
  if (!(await pathExists(sessionsDir))) return;
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const sessionId = path.basename(entry.name, ".json");
    const session = await loadSession(root, sessionId);
    if (session.pendingTask?.id !== pendingTaskId) continue;
    await saveSession(root, sessionId, { ...session, pendingTask });
  }
}

function emptySessionState(): SessionState {
  return { planApprovals: {}, readFiles: [], searchTools: [], skillUses: [], commands: [] };
}

function normalizeSessionState(session: Partial<SessionState>): SessionState {
  return {
    activeTaskId: typeof session.activeTaskId === "string" ? session.activeTaskId : undefined,
    pendingJudgment: normalizePendingJudgment(session.pendingJudgment),
    pendingTask: normalizePendingTask(session.pendingTask),
    planApprovals: normalizePlanApprovals(session.planApprovals),
    readFiles: Array.isArray(session.readFiles) ? session.readFiles.filter((file): file is string => typeof file === "string") : [],
    searchTools: Array.isArray(session.searchTools)
      ? session.searchTools.map(normalizeToolEvidence).filter((entry): entry is ToolEvidence => Boolean(entry))
      : [],
    skillUses: Array.isArray(session.skillUses)
      ? session.skillUses.map(normalizeSkillUse).filter((entry): entry is SkillUse => Boolean(entry))
      : [],
    commands: Array.isArray(session.commands)
      ? session.commands.map(normalizeCommandRecord).filter((entry): entry is CommandRecord => Boolean(entry))
      : [],
  };
}

function normalizeTask(task: Partial<Task>): Task {
  if (!task.id || !task.title || !task.type || !task.gate || !task.created_at || !task.updated_at) {
    throw new Error("Invalid MewoFlow task.json.");
  }
  return {
    id: task.id,
    title: task.title,
    type: task.type,
    taskRole: task.taskRole ?? (task.type === "epic" ? "parent" : "standard"),
    parentTaskId: typeof task.parentTaskId === "string" ? task.parentTaskId : undefined,
    childTaskIds: Array.isArray(task.childTaskIds) ? task.childTaskIds.filter((id): id is string => typeof id === "string") : [],
    gate: task.gate,
    reviewed: typeof task.reviewed === "boolean" ? task.reviewed : false,
    created_at: task.created_at,
    updated_at: task.updated_at,
    overrides: Array.isArray(task.overrides) ? task.overrides : [],
    reworks: Array.isArray(task.reworks) ? task.reworks.map(normalizeReworkRecord).filter((entry): entry is ReworkRecord => Boolean(entry)) : [],
    deferredRiskApprovals: Array.isArray(task.deferredRiskApprovals)
      ? task.deferredRiskApprovals.map(normalizeDeferredRiskApproval).filter((entry): entry is DeferredRiskApproval => Boolean(entry))
      : [],
  };
}

function normalizeReworkRecord(value: unknown): ReworkRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<ReworkRecord>;
  if (!isGate(record.fromGate) || typeof record.reason !== "string" || typeof record.at !== "string") return null;
  return { fromGate: record.fromGate, reason: record.reason, at: record.at };
}

function normalizeDeferredRiskApproval(value: unknown): DeferredRiskApproval | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const approval = value as Partial<DeferredRiskApproval>;
  if (typeof approval.reason !== "string" || typeof approval.approved_at !== "string") return null;
  return { reason: approval.reason, approved_at: approval.approved_at };
}

function normalizePendingTask(value: unknown): PendingTask | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const task = value as Partial<PendingTask>;
  return typeof task.id === "string" &&
    typeof task.title === "string" &&
    (task.type === "standard" || task.type === "epic") &&
    typeof task.prompt === "string" &&
    typeof task.created_at === "string"
    ? {
        id: task.id,
        title: task.title,
        proposedTitle: typeof task.proposedTitle === "string" ? task.proposedTitle : undefined,
        proposedSlug: typeof task.proposedSlug === "string" ? task.proposedSlug : undefined,
        type: task.type,
        prompt: task.prompt,
        created_at: task.created_at,
      }
    : undefined;
}

function normalizePendingJudgment(value: unknown): PendingJudgment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const judgment = value as Partial<PendingJudgment>;
  return typeof judgment.prompt === "string" &&
    (judgment.classification === "simple" || judgment.classification === "standard" || judgment.classification === "epic") &&
    typeof judgment.requiresWorkflow === "boolean" &&
    typeof judgment.reason === "string" &&
    typeof judgment.created_at === "string"
    ? {
        prompt: judgment.prompt,
        classification: judgment.classification,
        requiresWorkflow: judgment.requiresWorkflow,
        reason: judgment.reason,
        created_at: judgment.created_at,
      }
    : undefined;
}

function normalizeToolEvidence(value: unknown): ToolEvidence | null {
  if (typeof value === "string") return { tool: value, at: new Date(0).toISOString() };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Partial<ToolEvidence>;
  if (typeof entry.tool !== "string" || typeof entry.at !== "string") return null;
  return {
    tool: entry.tool,
    at: entry.at,
    query: typeof entry.query === "string" ? entry.query : undefined,
    taskId: typeof entry.taskId === "string" ? entry.taskId : undefined,
    gate: isGate(entry.gate) ? entry.gate : undefined,
  };
}

function normalizeSkillUse(value: unknown): SkillUse | null {
  if (typeof value === "string") return { skill: value, at: new Date(0).toISOString() };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Partial<SkillUse>;
  if (typeof entry.skill !== "string" || typeof entry.at !== "string") return null;
  return {
    skill: entry.skill,
    at: entry.at,
    taskId: typeof entry.taskId === "string" ? entry.taskId : undefined,
    gate: isGate(entry.gate) ? entry.gate : undefined,
  };
}

function normalizeCommandRecord(value: unknown): CommandRecord | null {
  if (typeof value === "string") return { command: value, at: new Date(0).toISOString() };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Partial<CommandRecord>;
  if (typeof entry.command !== "string" || typeof entry.at !== "string") return null;
  return {
    command: entry.command,
    at: entry.at,
    taskId: typeof entry.taskId === "string" ? entry.taskId : undefined,
    gate: isGate(entry.gate) ? entry.gate : undefined,
  };
}

function isGate(value: unknown): value is Gate {
  return value === "research" || value === "grill" || value === "plan" || value === "implement" || value === "verify" || value === "review" || value === "archive" || value === "done";
}

function normalizePlanApprovals(value: unknown): Record<string, PlanApproval> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const approvals: Record<string, PlanApproval> = {};
  for (const [taskId, approval] of Object.entries(value as Record<string, unknown>)) {
    if (!approval || typeof approval !== "object" || Array.isArray(approval)) continue;
    const candidate = approval as Partial<PlanApproval>;
    if (typeof candidate.approved_at === "string" && typeof candidate.prompt === "string") {
      approvals[taskId] = { approved_at: candidate.approved_at, prompt: candidate.prompt };
    }
  }
  return approvals;
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
  while (await taskIdExists(root, id)) {
    id = `${baseId}-${counter}`;
    counter += 1;
  }
  return id;
}

async function taskIdExists(root: string, taskId: string): Promise<boolean> {
  return (await pathExists(taskDir(root, taskId))) || (await pathExists(archivedTaskDir(root, taskId)));
}

async function taskJsonPath(root: string, taskId: string): Promise<string> {
  const activePath = taskFile(root, taskId, "task.json");
  if (await pathExists(activePath)) return activePath;
  return archivedTaskFile(root, taskId, "task.json");
}

async function taskMarkdownPath(root: string, taskId: string, file: string): Promise<string> {
  const activePath = taskFile(root, taskId, file);
  if (await pathExists(activePath)) return activePath;
  return archivedTaskFile(root, taskId, file);
}

function researchTemplate(): string {
  return `# Research\n\n## Tool Evidence\n- Tool Used:\n- Query / Skill / MCP:\n- Result Summary:\n\n## Sources\n| Source | Type | Why It Matters |\n|---|---|---|\n\n## Current Facts\n\n## Assumptions\n\n## Impact On This Task\n\n## Unknowns\n`;
}

function grillTemplate(): string {
  return `# Grill\n\n## Grill Skill\n- Used skill: grill-me\n- Source: .claude/skills/grill-me/SKILL.md\n\n## Question Log\n\n### Q1\nQuestion:\nRecommended answer:\nUser answer:\nDecision:\n\n## Decision Coverage\nRecord the decision areas required by the current task and the current grill-me skill. Field names are examples, not validator rules.\n\n## Locked Decisions\n\n## Acceptance Criteria\n\n## Grill Completion Judgment\nRecord why continuing to ask questions is now low-value.\n\n## Open Questions\n- None\n`;
}

function planTemplate(): string {
  return `# Plan\n\n## Goal\n\n## Scope\n\n## Non-goals\n\n## Shortcut / Existing Solution Scan\n| Source | Type | Finding | Decision |\n|---|---|---|---|\n\n## MVP Slice\n\n## Parent / Child Task Breakdown\n| Child Task | Purpose | Acceptance |\n|---|---|---|\n\n## Phases\n\n## Deferred / Later\n\n## Files To Change\n\n## Steps\n\n## Risks\n\n## Verification\n`;
}

function verifyTemplate(): string {
  return `# Verify\n\n## Result\n- blocked\n\n## Commands Run\n| Command | Result | Evidence |\n|---|---|---|\n\n## Critical Path\n| Path | Result | Evidence |\n|---|---|---|\n\n## Review Follow-up\n| Review Item | Verification | Evidence |\n|---|---|---|\n\n## Notes\n`;
}

function reviewTemplate(): string {
  return `# Review\n\n## Result\n- blocked\n\nAllowed final values: passed, needs-work, deferred-with-approval.\n\n## Scope\n\n## File-by-file Review\n| File | Finding | Severity | Decision |\n|---|---|---|---|\n\n## Architecture Impact\n\n## Security\n\n## Performance\n\n## Maintainability\n\n## Unresolved Questions\n- None\n\n## Skill / Subagent Evidence\n| Skill or Subagent | Purpose | Evidence |\n|---|---|---|\n\n## Required Follow-up Verification\n`;
}

function archiveTemplate(): string {
  return `# Archive\n\n## Summary\n\n## Decisions\n\n## Verification\n\n## Review\n\n## Deferred Risk Approval\n- none\n\n## Follow-ups\n\n## Archived Location\n.mewoflow/archive/<task-id>/\n\n## Rule Updates\n- none\n`;
}
