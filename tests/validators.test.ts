import { describe, expect, it } from "vitest";
import { validateArchive, validateGrill, validatePlan, validateResearch, validateVerify } from "../src/validators.js";
import type { SessionState, Task } from "../src/task.js";

const sessionWithSearch: SessionState = {
  readFiles: [],
  searchTools: [{ tool: "WebSearch", at: "2026-05-31T12:00:00.000Z" }],
  commands: [],
};

describe("validators", () => {
  it("requires search evidence for research", () => {
    const markdown = `# Research

## Search Evidence
- Tool Used: WebSearch

## Sources
| Source | Type | Why It Matters |
|---|---|---|
| https://code.claude.com/docs/en/hooks | official | current hook docs |

## Current Facts
- Hooks can block tool use.

## Impact On This Task
- Use PreToolUse.

## Unknowns
- None
`;

    expect(validateResearch(markdown, sessionWithSearch).ok).toBe(true);
    expect(validateResearch(markdown, { readFiles: [], searchTools: [], commands: [] }).ok).toBe(false);
  });

  it("allows user-provided research sources without logged search", () => {
    const markdown = `# Research

## Search Evidence
- Tool Used: user-provided-source

## Sources
| Source | Type | Why It Matters |
|---|---|---|
| https://example.com | user-provided-source | user supplied docs |

## Current Facts
- Fact.

## Impact On This Task
- Impact.
`;

    expect(validateResearch(markdown, { readFiles: [], searchTools: [], commands: [] }).ok).toBe(true);
  });

  it("validates grill and plan documents", () => {
    expect(
      validateGrill(`# Grill
Recommended Answer:
User Answer:
## Locked Decisions
## Acceptance Criteria
`).ok,
    ).toBe(true);

    expect(
      validatePlan(`# Plan
## Goal
## Scope
## Non-goals
## Steps
## Verification
`).ok,
    ).toBe(true);
  });

  it("validates verify and archive documents", () => {
    expect(
      validateVerify(`# Verify
## Result
- passed
## Commands Run
| Command | Result | Evidence |
|---|---|---|
| npm test | passed | 1 test passed |
`).ok,
    ).toBe(true);

    const task: Task = {
      id: "task",
      title: "task",
      type: "standard",
      gate: "archive",
      created_at: "2026-05-31T12:00:00.000Z",
      updated_at: "2026-05-31T12:00:00.000Z",
      overrides: [],
    };

    expect(validateArchive("# Archive\n\n## Summary\nDone\n\n## Verification\nPassed\n", task).ok).toBe(true);
  });
});
