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
    "## Question Log",
    "## Decision Coverage",
    "## Locked Decisions",
    "## Acceptance Criteria",
    "## Grill Completion Judgment",
  ]);

  const grillSkillSection = sectionContent(text, "Grill Skill");
  if (!/\bgrill-me\b/i.test(grillSkillSection) || !hasMeaningfulSectionContent(text, "Grill Skill")) {
    errors.push("Grill must record direct use of the project-local grill-me skill.");
  }

  if (!hasMeaningfulSectionContent(text, "Question Log", 4)) {
    errors.push("Grill requires a concrete multi-line question log with interview and decision evidence.");
  }

  if (!hasMeaningfulSectionContent(text, "Decision Coverage", 3)) {
    errors.push("Grill requires concrete decision coverage evidence.");
  }

  if (!hasMeaningfulSectionContent(text, "Locked Decisions")) {
    errors.push("Grill requires non-empty locked decisions evidence.");
  }

  if (!hasMeaningfulSectionContent(text, "Acceptance Criteria")) {
    errors.push("Grill requires non-empty acceptance criteria evidence.");
  }

  if (!hasMeaningfulSectionContent(text, "Grill Completion Judgment", 2)) {
    errors.push("Grill requires a concrete completion judgment with stop rationale.");
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
  const resultPassed = resultValue(text, "Result") === "passed";
  if (!resultPassed) {
    errors.push("Verify result must be passed.");
  }

  const commandsSection = sectionContent(text, "Commands Run");
  const hasCommandEvidenceRow = hasNonPlaceholderTableRow(commandsSection, ["command"]);
  if (!hasCommandEvidenceRow) {
    errors.push("Verify requires at least one non-placeholder command evidence row.");
  }

  const criticalPathSection = sectionContent(text, "Critical Path");
  if (!hasNonPlaceholderTableRow(criticalPathSection, ["path"])) {
    errors.push("Verify requires at least one non-placeholder critical path row.");
  }

  if (/all checks green|looks good|trust me|全部通过|看起来没问题/i.test(text)) {
    errors.push("Verify evidence must cite concrete command output or critical-path observations, not generic claims.");
  }

  if (resultPassed && hasCommandEvidenceRow && session && task && !hasMatchingCommandEvidence(commandsSection, session, task)) {
    errors.push("Verify requires a logged command from this task/session to match Commands Run.");
  }

  return toResult(errors);
}

export function validateReview(text: string, session?: SessionState, task?: Task): ValidationResult {
  const errors = requireSections(text, [
    "## Result",
    "## Scope",
    "## File-by-file Review",
    "## Architecture Impact",
    "## Security",
    "## Performance",
    "## Maintainability",
    "## Unresolved Questions",
    "## Skill / Subagent Evidence",
    "## Required Follow-up Verification",
  ]);

  const reviewResult = resultValue(text, "Result");
  if (!reviewResult || !["passed", "needs-work", "deferred-with-approval"].includes(reviewResult)) {
    errors.push("Review result must be passed.");
  }

  if (hasUnresolvedHighSeverityFinding(text) && reviewResult === "passed") {
    errors.push("Review has unresolved high-severity findings; use Result: needs-work and run `mewoflow rework --reason \"...\"`, or record explicit deferred-risk approval.");
  }

  if (!hasNonPlaceholderTableRow(sectionContent(text, "File-by-file Review"), ["file"])) {
    errors.push("Review requires at least one non-placeholder file-by-file review row.");
  }

  const skillSection = sectionContent(text, "Skill / Subagent Evidence");
  const documentsNoSuitableSkill = /no suitable skill|no relevant skill|无合适|没有合适|无需额外 skill/i.test(skillSection);
  if (!hasNonPlaceholderTableRow(skillSection, ["skill", "subagent"]) && !documentsNoSuitableSkill) {
    errors.push("Review must record relevant skill/subagent use, or explain why no suitable skill was available.");
  }

  if (session && task && !hasReviewStageSkillEvidence(session, task) && !documentsNoSuitableSkill) {
    errors.push("Review should use a logged review-stage skill when one is suitable.");
  }

  if (/looks good|看起来没问题|大概没问题|trust me/i.test(text)) {
    errors.push("Review must cite concrete files, risks, and decisions instead of generic approval claims.");
  }

  return toResult(errors);
}

export function validateArchive(text: string, task: Task): ValidationResult {
  const errors = requireSections(text, ["## Summary", "## Verification"]);
  if (task.overrides.length > 0 && !/override|风险|risk/i.test(text)) {
    errors.push("Archive must mention override risk when overrides exist.");
  }
  if (hasUnresolvedHighSeverityFinding(text) && task.deferredRiskApprovals.length === 0) {
    errors.push("Archive cannot proceed with unresolved high-severity findings unless `mewoflow approve-deferred-risk --reason \"...\"` was recorded.");
  }
  return toResult(errors);
}

function requireSections(text: string, sections: string[]): string[] {
  return sections.filter((section) => !text.includes(section)).map((section) => `Missing ${section}`);
}

function requireIncludes(text: string, values: string[]): string[] {
  return values.filter((value) => !text.includes(value)).map((value) => `Missing ${value}`);
}

function sectionContent(text: string, section: string): string {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\r?\\n)##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, "i").exec(text);
  return match?.[1] ?? "";
}

function hasMeaningfulSectionContent(text: string, section: string, minLines = 1): boolean {
  return meaningfulEvidenceLines(sectionContent(text, section)).length >= minLines;
}

function meaningfulEvidenceLines(section: string): string[] {
  const lines = section.split(/\r?\n/);
  return lines.filter((line, index) => isMeaningfulEvidenceLine(line, lines[index + 1]));
}

function isMeaningfulEvidenceLine(line: string, nextLine?: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^\|?\s*:?-{3,}/.test(trimmed) || trimmed.includes("---")) return false;
  if (trimmed.startsWith("|") && nextLine && /^\|?\s*:?-{3,}/.test(nextLine.trim())) return false;

  const normalized = trimmed
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?/, "")
    .replace(/\*\*/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  if (/^[^:：]{1,80}[:：]\s*$/.test(normalized)) return false;
  if (/^(?:tbd|todo|none|n\/a|placeholder|example|sample|待定|暂无|无|示例|占位)$/i.test(normalized)) return false;
  return /[\p{L}\p{N}]/u.test(normalized);
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

function hasReviewStageSkillEvidence(session: SessionState, task: Task): boolean {
  return session.skillUses.some((entry) => {
    const sameTask = !entry.taskId || entry.taskId === task.id;
    return sameTask && entry.gate === "review";
  });
}

function resultValue(text: string, section: string): string | null {
  const content = sectionContent(text, section);
  const match = /(?:^|\r?\n)\s*(?:[-*]\s*)?(?:result\s*:\s*)?(passed|needs-work|deferred-with-approval)\b/i.exec(content);
  return match?.[1]?.toLowerCase() ?? null;
}

function hasUnresolvedHighSeverityFinding(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    if (!line.trim().startsWith("|")) return false;
    if (!isNonPlaceholderTableRow(line, ["file"])) return false;

    const row = normalizeCellText(line);
    const hasHighSeverity = /\b(?:high|critical|blocker)\b|高|严重|阻塞/i.test(row);
    if (!hasHighSeverity) return false;

    const markedResolved = /\b(?:fixed|resolved|done|keep|accepted)\b|已修复|已解决|无需处理|接受/i.test(row);
    const markedUnresolved = /\b(?:unresolved|needs?\s+fix|todo|deferred|pending|open|follow[- ]?up|known\s+issue)\b|待修|未修复|未解决|待处理|延期|遗留/i.test(row);
    return markedUnresolved && !markedResolved;
  });
}

function hasMatchingCommandEvidence(commandsSection: string, session: SessionState, task: Task): boolean {
  const commandCells = commandsSection
    .split(/\r?\n/)
    .filter((line) => isNonPlaceholderTableRow(line, ["command"]))
    .map((row) => normalizeCommand(firstTableCell(row)))
    .filter(Boolean);
  if (commandCells.length === 0) return false;

  const commands = session.commands.filter((entry) => (!entry.taskId || entry.taskId === task.id) && (!entry.gate || entry.gate === "verify"));
  if (commands.length === 0) return false;

  return commands.some((entry) => {
    const logged = normalizeCommand(entry.command);
    return commandCells.some((cell) => logged === cell || logged.includes(cell) || cell.includes(logged));
  });
}

function firstTableCell(row: string): string {
  return row
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)[0] ?? "";
}

function normalizeCellText(text: string): string {
  return text
    .replace(/`/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCommand(command: string): string {
  return command
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toResult(errors: string[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}
