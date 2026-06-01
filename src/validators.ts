import type { SessionState, Task } from "./task.js";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

export function validateResearch(text: string, session: SessionState): ValidationResult {
  const errors = requireSections(text, [
    "## Tool Evidence",
    "## Sources",
    "## Current Facts",
    "## Assumptions",
    "## Impact On This Task",
    "## Unknowns",
  ]);
  const hasLoggedSearch = session.searchTools.length > 0 || session.skillUses.length > 0;
  const hasUserProvidedSource = /user-provided-source|user provided|用户提供/i.test(text);
  if (!hasLoggedSearch && !hasUserProvidedSource) {
    errors.push("Research requires a logged WebSearch/WebFetch/MCP/skill search or explicit user-provided-source evidence.");
  }

  if (!hasNonPlaceholderTableRow(sectionContent(text, "Sources"), ["source"])) {
    errors.push("Research requires at least one non-placeholder source row.");
  }

  const currentFacts = sectionContent(text, "Current Facts");
  if (/假设|猜测|可能|也许|大概|assum|guess|maybe|probably|用户拒绝|declined|not answered/i.test(currentFacts)) {
    errors.push("Research Current Facts must not mix assumptions or declined-question guesses; put them under Assumptions/Unknowns.");
  }

  return toResult(errors);
}

export function validateGrill(text: string): ValidationResult {
  const errors = requireIncludes(text, [
    "## Grill Skill",
    "grill-me",
    "## Question Log",
    "Question:",
    "Recommended Answer:",
    "User Answer:",
    "Decision:",
    "## Decision Coverage",
    "Product Goal:",
    "MVP Scope:",
    "Non-goals:",
    "Pages/Navigation:",
    "Data Source:",
    "Core Interactions:",
    "UI/Responsive:",
    "Error/Empty States:",
    "Testing/Acceptance:",
    "Risks:",
    "Budget/Timebox:",
    "Infra/Deployment:",
    "Security/Privacy:",
    "Failure Modes/Rollback:",
    "## Locked Decisions",
    "## Acceptance Criteria",
    "## Grill Completion Judgment",
    "Status:",
    "Stopped By:",
    "Reason:",
    "Low-value Follow-ups:",
  ]);

  if (!/## Grill Skill[\s\S]*?Used:\s*grill-me/i.test(text)) {
    errors.push("Grill must record direct use of the project-local grill-me skill.");
  }

  for (const field of requiredGrillLineFields()) {
    if (!hasNonEmptyLineField(text, field)) {
      errors.push(`Grill requires non-empty ${field}.`);
    }
  }

  if (!/^Stopped By:\s*(model|assistant|大模型|模型)\b/im.test(text)) {
    errors.push("Grill completion judgment must say it was stopped by model/assistant judgment.");
  }

  return toResult(errors);
}

export function validatePlan(text: string, session?: SessionState, task?: Task): ValidationResult {
  const errors = requireSections(text, [
    "## Goal",
    "## Scope",
    "## Non-goals",
    "## Shortcut / Existing Solution Scan",
    "## MVP Slice",
    "## Parent / Child Task Breakdown",
    "## Phases",
    "## Deferred / Later",
    "## Steps",
    "## Risks",
    "## Verification",
  ]);

  if (!hasNonPlaceholderTableRow(sectionContent(text, "Shortcut / Existing Solution Scan"), ["source", "finding", "decision"])) {
    errors.push("Plan requires at least one non-placeholder shortcut/existing-solution source row.");
  }

  if (session && task && !hasPlanStageToolEvidence(session, task)) {
    errors.push("Plan requires a logged plan-stage WebSearch/WebFetch/MCP/skill lookup before finalizing.");
  }

  if (task?.taskRole === "parent" && !hasNonPlaceholderTableRow(sectionContent(text, "Parent / Child Task Breakdown"), ["child", "task"])) {
    errors.push("Parent epic plan requires concrete child task rows under Parent / Child Task Breakdown.");
  }

  return toResult(errors);
}

export function validateVerify(text: string, session?: SessionState, task?: Task): ValidationResult {
  const errors = requireSections(text, ["## Result", "## Commands Run", "## Critical Path", "## Review"]);
  if (!/## Result[\s\S]*?-\s*passed/i.test(text)) {
    errors.push("Verify result must be passed.");
  }

  const commandsSection = sectionContent(text, "Commands Run");
  if (!hasNonPlaceholderTableRow(commandsSection, ["command"])) {
    errors.push("Verify requires at least one non-placeholder command evidence row.");
  }

  const criticalPathSection = sectionContent(text, "Critical Path");
  if (!hasNonPlaceholderTableRow(criticalPathSection, ["path"])) {
    errors.push("Verify requires at least one non-placeholder critical path row.");
  }

  if (/all checks green|looks good|trust me|全部通过|看起来没问题/i.test(text)) {
    errors.push("Verify evidence must cite concrete command output or critical-path observations, not generic claims.");
  }

  if (session && task && !hasMatchingCommandEvidence(commandsSection, session, task)) {
    errors.push("Verify requires a logged command from this task/session to match Commands Run.");
  }

  return toResult(errors);
}

export function validateArchive(text: string, task: Task): ValidationResult {
  const errors = requireSections(text, ["## Summary", "## Verification"]);
  if (task.overrides.length > 0 && !/override|风险|risk/i.test(text)) {
    errors.push("Archive must mention override risk when overrides exist.");
  }
  return toResult(errors);
}

function requireSections(text: string, sections: string[]): string[] {
  return sections.filter((section) => !text.includes(section)).map((section) => `Missing ${section}`);
}

function requireIncludes(text: string, values: string[]): string[] {
  return values.filter((value) => !text.includes(value)).map((value) => `Missing ${value}`);
}

function requiredGrillLineFields(): string[] {
  return [
    "Product Goal",
    "MVP Scope",
    "Non-goals",
    "Pages/Navigation",
    "Data Source",
    "Core Interactions",
    "UI/Responsive",
    "Error/Empty States",
    "Testing/Acceptance",
    "Risks",
    "Budget/Timebox",
    "Infra/Deployment",
    "Security/Privacy",
    "Failure Modes/Rollback",
    "Status",
    "Stopped By",
    "Reason",
    "Low-value Follow-ups",
  ];
}

function hasNonEmptyLineField(text: string, field: string): boolean {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}:[^\\S\\r\\n]*\\S+`, "im").test(text);
}

function sectionContent(text: string, section: string): string {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\r?\\n)##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, "i").exec(text);
  return match?.[1] ?? "";
}

function hasNonPlaceholderTableRow(section: string, headerWords: string[]): boolean {
  return section
    .split(/\r?\n/)
    .some((line) => isNonPlaceholderTableRow(line, headerWords));
}

function isNonPlaceholderTableRow(line: string, headerWords: string[]): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  if (/^\|?\s*:?-{3,}/.test(trimmed) || trimmed.includes("---")) return false;

  const cells = trimmed
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean);
  if (cells.length < 2) return false;

  const row = cells.join(" ");
  const normalizedFirstCell = (cells[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
  const normalizedHeader = headerWords.join(" ").toLowerCase();
  if (normalizedFirstCell === normalizedHeader || headerWords.some((word) => normalizedFirstCell === word.toLowerCase())) return false;
  const hasPlaceholderCell = cells.some((cell) => /^(?:tbd|todo|none|n\/a|placeholder|example|sample|待定|暂无|无|示例|占位)$/i.test(cell.trim()));
  if (hasPlaceholderCell || /did 0 searches|0 searches|no results|没有结果/i.test(row)) {
    return false;
  }

  return cells.some((cell) => /[\p{L}\p{N}]/u.test(cell));
}

function hasPlanStageToolEvidence(session: SessionState, task: Task): boolean {
  return [...session.searchTools, ...session.skillUses].some((entry) => {
    const sameTask = !entry.taskId || entry.taskId === task.id;
    return sameTask && entry.gate === "plan";
  });
}

function hasMatchingCommandEvidence(commandsSection: string, session: SessionState, task: Task): boolean {
  const commandRows = commandsSection
    .split(/\r?\n/)
    .filter((line) => isNonPlaceholderTableRow(line, ["command"]));
  if (commandRows.length === 0) return false;

  const commands = session.commands.filter((entry) => (!entry.taskId || entry.taskId === task.id) && (!entry.gate || entry.gate === "verify"));
  if (commands.length === 0) return false;

  return commands.some((entry) => commandRows.some((row) => row.includes(entry.command) || entry.command.includes(firstTableCell(row))));
}

function firstTableCell(row: string): string {
  return row
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)[0] ?? "";
}

function toResult(errors: string[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}
