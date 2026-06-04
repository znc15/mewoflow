import { describe, expect, it } from "vitest";
import { validateArchive, validateGrill, validateReview, validateVerify } from "../src/validators.js";
import type { SessionState, Task } from "../src/task.js";

const validGrill = `# Grill

## Grill Skill
- Used: grill-me
- Source: .claude/skills/grill-me/SKILL.md

## Question Log

### Q1
Question: What is the MVP scope?
Analysis: Keep only player, search, playlist, and profile.
Source / Answer: User agreed.
Decision: MVP excludes backend.

## Decision Coverage
- 用户价值: Build a music player MVP.
- 首版边界: Player, search, playlist, profile; backend and auth are excluded.
- 数据与交互: Local JSON/sample audio with play, pause, seek, volume, and mode switching.
- 体验与验收: Dark responsive layout, empty/audio-error states, build and player smoke checks.
- 风险处理: Audio autoplay restrictions and scope creep are handled by sample-data fallback.

## Locked Decisions
- Use pure frontend MVP.

## Acceptance Criteria
- Player controls work.

## Grill Completion Judgment
Status: complete
停止依据: Further questions are low-value because key value, scope, UX, data, and testing decisions are covered.
Low-value Follow-ups: Exact copywriting can be adjusted during implementation.

## Open Questions
- None
`;

describe("validateGrill", () => {
  it("accepts grill-me evidence with flexible decision coverage and stop rationale", () => {
    expect(validateGrill(validGrill)).toEqual({ ok: true, errors: [] });
  });

  it("accepts custom decision coverage labels without hardcoded business fields", () => {
    const markdownListGrill = validGrill
      .replace(
        /## Decision Coverage[\s\S]*?## Locked Decisions/,
        `## Decision Coverage
- 用户价值: 搜索并播放网易云音乐结果。
- 播放体验: 支持播放、暂停、进度、音量和歌词展示。
- 降级策略: API 不可用时展示错误和空状态，不静默失败。

## Locked Decisions`,
      )
      .replace("Status: complete", "- Status: Complete")
      .replace("停止依据: Further questions are low-value because key value, scope, UX, data, and testing decisions are covered.", "- 停止依据: Further questions are low-value because key value, scope, UX, data, and testing decisions are covered.")
      .replace("Low-value Follow-ups: Exact copywriting can be adjusted during implementation.", "- Low-value Follow-ups: Exact copywriting can be adjusted during implementation.");

    expect(validateGrill(markdownListGrill)).toEqual({ ok: true, errors: [] });
  });

  it("accepts bold markdown field labels", () => {
    const boldGrill = validGrill
      .replace(
        /## Decision Coverage[\s\S]*?## Locked Decisions/,
        `## Decision Coverage
- **核心价值**: 用户能搜索并播放歌曲。
- **体验边界**: 先做桌面端播放器体验。
- **验收方式**: 构建通过并完成播放链路 smoke check。

## Locked Decisions`,
      )
      .replace("Status: complete", "- **Status**: complete")
      .replace("停止依据: Further questions are low-value because key value, scope, UX, data, and testing decisions are covered.", "- **停止依据**: Further questions are low-value because key value, scope, UX, data, and testing decisions are covered.");

    expect(validateGrill(boldGrill)).toEqual({ ok: true, errors: [] });
  });

  it("requires direct use of the project-local grill-me skill", () => {
    const result = validateGrill(validGrill.replace(/grill-me/g, "custom-questions"));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Grill must record direct use of the project-local grill-me skill.");
  });

  it("requires concrete decision coverage evidence", () => {
    const result = validateGrill(
      validGrill.replace(
        /## Decision Coverage[\s\S]*?## Locked Decisions/,
        `## Decision Coverage

## Locked Decisions`,
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Grill requires concrete decision coverage evidence.");
  });

  it("accepts custom stop-judgment wording without fixed actor terms", () => {
    const result = validateGrill(validGrill.replace("停止依据: Further questions are low-value because key value, scope, UX, data, and testing decisions are covered.", "自定义停问判断: 当前对话根据剩余问题价值判断"));

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("requires concrete completion rationale", () => {
    const result = validateGrill(
      validGrill.replace(
        /## Grill Completion Judgment[\s\S]*?## Open Questions/,
        `## Grill Completion Judgment
停止依据:

## Open Questions`,
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Grill requires a concrete completion judgment with stop rationale.");
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

  it("requires needs-work when high severity findings remain unresolved", () => {
    const result = validateReview(
      validReview.replace(
        "| src/cli.ts | Commit command has a secret-path guard and dry-run preview | Keep |",
        "| src/player.ts | Infinite recursion can crash playback | High | unresolved; needs fix |",
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Review has unresolved high-severity findings; use Result: needs-work and run `mewoflow rework --reason \"...\"`, or record explicit deferred-risk approval.");
  });

  it("allows needs-work review result for unresolved high severity findings", () => {
    const result = validateReview(
      validReview
        .replace("- passed", "- needs-work")
        .replace(
          "| src/cli.ts | Commit command has a secret-path guard and dry-run preview | Keep |",
          "| src/player.ts | Infinite recursion can crash playback | High | unresolved; needs fix |",
        ),
    );

    expect(result.ok).toBe(true);
  });
});

const validTask: Task = {
  id: "2026-06-04-workflow-hardening",
  title: "Workflow hardening",
  type: "standard",
  taskRole: "standard",
  childTaskIds: [],
  gate: "verify",
  reviewed: false,
  created_at: "2026-06-04T00:00:00.000Z",
  updated_at: "2026-06-04T00:00:00.000Z",
  overrides: [],
  reworks: [],
  deferredRiskApprovals: [],
};

const validSession: SessionState = {
  activeTaskId: validTask.id,
  planApprovals: {},
  readFiles: [],
  searchTools: [],
  skillUses: [],
  commands: [{ command: "npm test", at: "2026-06-04T00:00:00.000Z", taskId: validTask.id, gate: "verify" }],
};

const validVerify = `# Verify

## Result
- passed

## Commands Run
| Command | Result | Evidence |
|---|---|---|
| npm test | passed | Vitest passed |

## Critical Path
| Path | Result | Evidence |
|---|---|---|
| workflow smoke | passed | Covered verify/review/archive |

## Review
Reviewer: assistant
Result: passed
`;

describe("validateVerify", () => {
  it("accepts Result: passed variants and normalized command cells", () => {
    const result = validateVerify(validVerify.replace("- passed", "Result: passed").replace("| npm test |", "| `npm test` |"), validSession, validTask);

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("reports missing passed result without also blaming matching command evidence", () => {
    const result = validateVerify(validVerify.replace("- passed", "- blocked"), validSession, validTask);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Verify result must be passed.");
    expect(result.errors).not.toContain("Verify requires a logged command from this task/session to match Commands Run.");
  });

  it("reports command mismatch when result is passed but no logged command matches", () => {
    const result = validateVerify(validVerify.replace("npm test", "pnpm build"), validSession, validTask);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Verify requires a logged command from this task/session to match Commands Run.");
  });
});

describe("validateArchive", () => {
  it("blocks archive when high severity follow-ups are unresolved without deferred risk approval", () => {
    const result = validateArchive(
      `# Archive

## Summary
- Completed with known issue.

## Verification
- npm test passed.

## Review
| File | Finding | Severity | Decision |
|---|---|---|---|
| src/player.ts | Infinite recursion can crash playback | High | unresolved; deferred |
`,
      validTask,
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Archive cannot proceed with unresolved high-severity findings unless `mewoflow approve-deferred-risk --reason \"...\"` was recorded.");
  });

  it("allows archive with unresolved high severity follow-ups after deferred risk approval", () => {
    const result = validateArchive(
      `# Archive

## Summary
- Completed with accepted deferred risk.

## Verification
- npm test passed.

## Review
| File | Finding | Severity | Decision |
|---|---|---|---|
| src/player.ts | Infinite recursion can crash playback | High | deferred with user approval |
`,
      { ...validTask, deferredRiskApprovals: [{ reason: "User accepted follow-up risk", approved_at: "2026-06-04T00:00:00.000Z" }] },
    );

    expect(result).toEqual({ ok: true, errors: [] });
  });
});
