import { describe, expect, it } from "vitest";
import { validateGrill, validateReview } from "../src/validators.js";

const validGrill = `# Grill

## Grill Skill
- Used: grill-me
- Source: .claude/skills/grill-me/SKILL.md

## Question Log

### Q1
Question: What is the MVP scope?
Recommended Answer: Keep only player, search, playlist, and profile.
User Answer: Yes.
Decision: MVP excludes backend.

## Decision Coverage
Product Goal: Build a music player MVP.
MVP Scope: Player, search, playlist, profile.
Non-goals: Backend and auth are excluded.
Pages/Navigation: Home, search, playlist, profile.
Data Source: Local JSON and sample audio.
Core Interactions: Play, pause, seek, volume, mode switching.
UI/Responsive: Dark responsive layout.
Error/Empty States: Empty search and audio load failure states.
Testing/Acceptance: Build, player controls, search filtering, responsive smoke checks.
Risks: Audio autoplay restrictions and scope creep.
Budget/Timebox: Keep to a small MVP slice.
Infra/Deployment: Static frontend deployment.
Security/Privacy: No auth or private user data in MVP.
Failure Modes/Rollback: Fall back to sample data and disable broken audio items.

## Locked Decisions
- Use pure frontend MVP.

## Acceptance Criteria
- Player controls work.

## Grill Completion Judgment
Status: complete
Stopped By: model
Reason: All high-risk product, UX, data, and testing decisions are covered.
Low-value Follow-ups: Exact copywriting can be adjusted during implementation.

## Open Questions
- None
`;

describe("validateGrill", () => {
  it("accepts grill-me evidence with decision coverage and model stop judgment", () => {
    expect(validateGrill(validGrill)).toEqual({ ok: true, errors: [] });
  });

  it("requires direct use of the project-local grill-me skill", () => {
    const result = validateGrill(validGrill.replace("- Used: grill-me", "- Used: custom questions"));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Grill must record direct use of the project-local grill-me skill.");
  });

  it("requires testing and acceptance coverage", () => {
    const result = validateGrill(validGrill.replace("Testing/Acceptance: Build, player controls, search filtering, responsive smoke checks.", ""));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Missing Testing/Acceptance:");
    expect(result.errors).toContain("Grill requires non-empty Testing/Acceptance.");
  });

  it("requires model or assistant stop judgment", () => {
    const result = validateGrill(validGrill.replace("Stopped By: model", "Stopped By: user"));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Grill completion judgment must say it was stopped by model/assistant judgment.");
  });

  it("requires non-empty completion reason", () => {
    const result = validateGrill(
      validGrill.replace("Reason: All high-risk product, UX, data, and testing decisions are covered.", "Reason:"),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Grill requires non-empty Reason.");
  });
});

const validReview = `# Review

## Result
- passed

## Scope
Reviewed changed workflow, CLI, and validators.

## File-by-file Review
| File | Finding | Decision |
|---|---|---|
| src/cli.ts | Commit command has a secret-path guard and dry-run preview | Keep |

## Architecture Impact
Review gate is explicit and requires a second verification pass before archive.

## Security
Likely secret paths are refused by the controlled commit command.

## Performance
No hot-path runtime changes are introduced.

## Maintainability
Review evidence stays structured and auditable.

## Unresolved Questions
- None

## Skill / Subagent Evidence
No suitable skill was available for this synthetic validator test.

## Required Follow-up Verification
Run npm test after review.
`;

describe("validateReview", () => {
  it("accepts concrete file review with skill decision evidence", () => {
    expect(validateReview(validReview)).toEqual({ ok: true, errors: [] });
  });

  it("rejects generic review approval claims", () => {
    const result = validateReview(validReview.replace("Review evidence stays structured and auditable.", "Looks good."));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Review must cite concrete files, risks, and decisions instead of generic approval claims.");
  });

  it("requires file-by-file review rows", () => {
    const result = validateReview(validReview.replace("| src/cli.ts | Commit command has a secret-path guard and dry-run preview | Keep |", ""));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Review requires at least one non-placeholder file-by-file review row.");
  });

  it("requires skill/subagent evidence or an explicit no-suitable-skill explanation", () => {
    const result = validateReview(validReview.replace("No suitable skill was available for this synthetic validator test.", ""));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Review must record relevant skill/subagent use, or explain why no suitable skill was available.");
  });
});
