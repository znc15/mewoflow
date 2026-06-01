import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { handlePostToolUse, handlePreToolUse, handleUserPromptSubmit } from "../src/hooks.js";
import { writeFileEnsured } from "../src/fs.js";
import { loadSession, loadTask, taskFile } from "../src/task.js";

describe("mewoflow gated workflow", () => {
  it("requires task confirmation, grill coverage, plan approval, implementation reads, verify, and archive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-e2e-"));

    await expect(main(["init"], root)).resolves.toBe(0);

    const judged = await handleUserPromptSubmit(root, { prompt: "开发一个音乐网站", session_id: "s1" });
    expect(String(judged.additionalContext)).toContain("MewoFlow prompt judgment");
    expect(String(judged.additionalContext)).toContain("No pending task has been proposed yet");
    let session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();
    expect(session.activeTaskId).toBeUndefined();

    const blockedBeforeJudgmentReview = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "pnpm create next-app@latest . --typescript" },
    });
    expect(JSON.stringify(blockedBeforeJudgmentReview)).toContain("Pending MewoFlow prompt judgment");

    const proposed = await handleUserPromptSubmit(root, { prompt: "判断没问题", session_id: "s1" });
    expect(String(proposed.additionalContext)).toContain("pending task proposed after judgment confirmation");
    session = await loadSession(root, "s1");
    expect(session.pendingJudgment).toBeUndefined();
    expect(session.pendingTask).toBeTruthy();
    expect(session.activeTaskId).toBeUndefined();

    const blockedBeforeConfirmation = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "pnpm create next-app@latest . --typescript" },
    });
    expect(JSON.stringify(blockedBeforeConfirmation)).toContain("waiting for explicit user confirmation");

    const allowedConfirmationCommand = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "npx mewoflow propose-task --title \"开发音乐网站\" --slug music-site --session s1" },
    });
    expect(JSON.stringify(allowedConfirmationCommand)).not.toContain("deny");
    await expect(main(["propose-task", "--title", "开发音乐网站", "--slug", "music-site", "--session", "s1"], root)).resolves.toBe(0);
    await expect(main(["check", "pending-task-confirmation"], root)).resolves.toBe(0);

    session = await loadSession(root, "s1");
    expect(session.activeTaskId).toBeTruthy();
    expect(session.pendingTask).toBeUndefined();
    const task = await loadTask(root, session.activeTaskId!);
    expect(task.gate).toBe("research");

    await handlePostToolUse(root, { session_id: "s1", tool_name: "WebSearch", tool_input: {} });
    await writeFileEnsured(
      taskFile(root, task.id, "research.md"),
      `# Research

## Tool Evidence
- Tool Used: WebSearch
- Query / Skill / MCP: music website MVP examples
- Result Summary: Keep first slice frontend-only with sample audio.

## Sources
| Source | Type | Why It Matters |
|---|---|---|
| user-provided-source | user | Defines the requested music website scope |

## Current Facts
- The user wants a music website MVP.

## Assumptions
- Backend auth and streaming provider integration can wait.

## Impact On This Task
- Keep scope focused and validate player interactions.

## Unknowns
- None
`,
    );
    await expect(main(["check", "research"], root)).resolves.toBe(0);

    await writeFileEnsured(taskFile(root, task.id, "grill.md"), validGrillMarkdown());
    await expect(main(["check", "grill"], root)).resolves.toBe(0);

    await handlePostToolUse(root, { session_id: "s1", tool_name: "WebSearch", tool_input: { query: "music website starter template MVP" } });

    await writeFileEnsured(
      taskFile(root, task.id, "plan.md"),
      `# Plan

## Goal
Build a focused music website MVP.

## Scope
- Player controls
- Search and playlist views
- Responsive dark UI

## Non-goals
- Backend auth and streaming integration

## Files To Change
- src/*

## Steps
1. Scaffold the UI shell.
2. Add sample data and player state.
3. Add search, playlist, and empty/error states.

## Verification
- Run build and player/search smoke checks.
`,
    );
    await expect(main(["check", "plan"], root)).resolves.toBe(1);

    await writeFileEnsured(
      taskFile(root, task.id, "plan.md"),
      `# Plan

## Goal
Build a focused music website MVP.

## Scope
- Player controls
- Search and playlist views
- Responsive dark UI

## Non-goals
- Backend auth and streaming integration

## Shortcut / Existing Solution Scan
| Source | Type | Finding | Decision |
|---|---|---|---|
| WebSearch: music website starter template MVP | web | Existing starters are broader than the requested MVP | Build a focused frontend slice with sample data |

## MVP Slice
- Static frontend music browsing and playback demo using sample JSON/audio.

## Parent / Child Task Breakdown
| Child Task | Purpose | Acceptance |
|---|---|---|
| Music UI shell | Build layout and navigation | Responsive dark shell renders |
| Playback/search interactions | Add sample data, playback state, and filtering | Controls and search work in smoke test |

## Phases
1. UI shell.
2. Player/search interactions.
3. Empty/error states and verification.

## Deferred / Later
- Auth, accounts, payments, and streaming provider integration.

## Files To Change
- src/*

## Steps
1. Scaffold the UI shell.
2. Add sample data and player state.
3. Add search, playlist, and empty/error states.

## Risks
- Browser autoplay rules may limit sample playback.

## Verification
- Run npm test and player/search smoke checks.
`,
    );

    const approved = await handleUserPromptSubmit(root, { prompt: "同意计划，开始实现", session_id: "s1" });
    expect(String(approved.additionalContext)).toContain("MewoFlow plan approved");
    await expect(main(["check", "plan"], root)).resolves.toBe(0);

    const blockedBeforeReads = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts" },
    });
    expect(JSON.stringify(blockedBeforeReads)).toContain("Read required MewoFlow context");

    for (const file of [
      ".mewoflow/rules.md",
      `.mewoflow/tasks/${task.id}/research.md`,
      `.mewoflow/tasks/${task.id}/grill.md`,
      `.mewoflow/tasks/${task.id}/plan.md`,
    ]) {
      await handlePostToolUse(root, { session_id: "s1", tool_name: "Read", tool_input: { file_path: file } });
    }

    const allowedEdit = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts" },
    });
    expect(JSON.stringify(allowedEdit)).not.toContain("deny");

    await expect(main(["check", "implement"], root)).resolves.toBe(0);

    await handlePostToolUse(root, { session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" } });

    await writeFileEnsured(
      taskFile(root, task.id, "verify.md"),
      `# Verify

## Result
- passed

## Commands Run
| Command | Result | Evidence |
|---|---|---|
| npm test | passed | Vitest run completed for workflow smoke coverage |

## Critical Path
| Path | Result | Evidence |
|---|---|---|
| player/search smoke | passed | Sample player controls and search filtering were reviewed against the plan |

## Review
Reviewer: assistant
Result: passed
Findings: none
`,
    );
    await expect(main(["check", "verify"], root)).resolves.toBe(0);

    await writeFileEnsured(
      taskFile(root, task.id, "archive.md"),
      `# Archive

## Summary
- Music website MVP workflow completed.

## Verification
- npm test passed.
`,
    );
    await expect(main(["check", "archive"], root)).resolves.toBe(0);

    const done = await loadTask(root, task.id);
    expect(done.gate).toBe("done");
  });
});

function validGrillMarkdown(): string {
  return `# Grill

## Grill Skill
- Used: grill-me
- Source: .claude/skills/grill-me/SKILL.md

## Question Log

### Q1
Question: What should the MVP include?
Recommended Answer: Keep playback, search, playlist, responsive UI, and sample data.
User Answer: Yes.
Decision: Exclude backend and auth.

## Decision Coverage
Product Goal: Build a music website MVP for browsing and playback demos.
MVP Scope: Player controls, search, playlist, responsive dark UI.
Non-goals: Backend auth, payments, and streaming provider integration.
Pages/Navigation: Home, search, playlist, and profile placeholders.
Data Source: Local sample JSON and bundled sample audio.
Core Interactions: Play, pause, seek, volume, playlist selection, and search filtering.
UI/Responsive: Mobile-first dark layout with desktop two-column player view.
Error/Empty States: Empty search result, missing audio, and no playlist states.
Testing/Acceptance: Build passes, controls update state, search filters data, responsive smoke checks pass.
Risks: Browser autoplay rules and MVP scope creep.
Budget/Timebox: Keep implementation to the smallest frontend MVP slice.
Infra/Deployment: Static frontend deployment without external services.
Security/Privacy: No accounts, auth, or private user data in MVP.
Failure Modes/Rollback: Disable broken audio entries and fall back to sample data.

## Locked Decisions
- Use frontend-only sample data.

## Acceptance Criteria
- Users can browse, search, and use player controls.

## Grill Completion Judgment
Status: complete
Stopped By: assistant
Reason: Product, scope, navigation, data, interaction, UI, edge state, and testing decisions are covered.
Low-value Follow-ups: Exact copy and icon choices can be adjusted during implementation.

## Open Questions
- None
`;
}
