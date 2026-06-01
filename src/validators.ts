import type { SessionState, Task } from "./task.js";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

export function validateResearch(text: string, session: SessionState): ValidationResult {
  const errors = requireSections(text, ["## Search Evidence", "## Sources", "## Current Facts", "## Impact On This Task"]);
  const hasLoggedSearch = session.searchTools.length > 0;
  const hasUserProvidedSource = /user-provided-source|user provided|用户提供/i.test(text);
  if (!hasLoggedSearch && !hasUserProvidedSource) {
    errors.push("Research requires a logged WebSearch/WebFetch/MCP search or explicit user-provided-source evidence.");
  }
  if (!hasSourceRow(text)) errors.push("Research requires at least one source row.");
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
    "## Locked Decisions",
    "## Acceptance Criteria",
    "## Grill Completion Judgment",
    "Status:",
    "Reason:",
  ]);

  if (!/## Grill Skill[\s\S]*?Used:\s*grill-me/i.test(text)) {
    errors.push("Grill must record direct use of the project-local grill-me skill.");
  }

  if (!/Status:\s*\S+/i.test(text)) {
    errors.push("Grill completion judgment requires a non-empty Status.");
  }

  if (!/Reason:\s*\S+/i.test(text)) {
    errors.push("Grill completion judgment requires a reason explaining why no meaningful questions remain.");
  }

  return toResult(errors);
}

export function validatePlan(text: string): ValidationResult {
  return toResult(requireSections(text, ["## Goal", "## Scope", "## Non-goals", "## Steps", "## Verification"]));
}

export function validateVerify(text: string): ValidationResult {
  const errors = requireSections(text, ["## Result", "## Review"]);
  if (!/## Result[\s\S]*?-\s*passed/i.test(text)) {
    errors.push("Verify result must be passed.");
  }
  if (!text.includes("## Commands Run") && !text.includes("## Critical Path")) {
    errors.push("Verify requires Commands Run or Critical Path evidence.");
  }
  if (!hasEvidenceRow(text)) errors.push("Verify requires at least one evidence row.");
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

function hasSourceRow(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith("|") && !line.includes("---") && !line.includes("Source") && line.split("|").length >= 4);
}

function hasEvidenceRow(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith("|") && !line.includes("---") && !line.includes("Command") && !line.includes("Path"));
}

function toResult(errors: string[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}
