import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { writeFileEnsured } from "../src/fs.js";
import { handlePostToolUse, handlePreToolUse, handleUserPromptSubmit } from "../src/hooks.js";
import { loadSession, loadTask, taskFile } from "../src/task.js";

describe("MewoFlow local workflow", () => {
  it("runs the required local workflow gates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-e2e-"));

    await expect(main(["init"], root)).resolves.toBe(0);

    await handleUserPromptSubmit(root, { prompt: "修复登录 bug", session_id: "s1" });
    const session = await loadSession(root, "s1");
    expect(session.activeTaskId).toBeTruthy();
    const taskId = session.activeTaskId!;

    await handlePostToolUse(root, { session_id: "s1", tool_name: "WebSearch", tool_input: {} });
    await writeFileEnsured(
      taskFile(root, taskId, "research.md"),
      `# Research

## Search Evidence
- Tool Used: WebSearch

## Sources
| Source | Type | Why It Matters |
|---|---|---|
| https://code.claude.com/docs/en/hooks | official | current hook behavior |

## Current Facts
- Claude Code hooks can block tool use.

## Impact On This Task
- Use PreToolUse to block early edits.

## Unknowns
- None
`,
    );
    await expect(main(["check", "research"], root)).resolves.toBe(0);
    expect((await loadTask(root, taskId)).gate).toBe("grill");

    await writeFileEnsured(
      taskFile(root, taskId, "grill.md"),
      `# Grill

## Q1
Question: Should the fix include regression verification?
Recommended Answer: Yes.
User Answer: Yes.
Decision: Include verification evidence.

## Locked Decisions
- Fix must include proof.

## Acceptance Criteria
- Login works.

## Open Questions
- None
`,
    );
    await expect(main(["check", "grill"], root)).resolves.toBe(0);
    expect((await loadTask(root, taskId)).gate).toBe("plan");

    await writeFileEnsured(
      taskFile(root, taskId, "plan.md"),
      `# Plan

## Goal
Fix login bug.

## Scope
Login flow only.

## Non-goals
No auth rewrite.

## Files To Change
- src/login.ts

## Steps
1. Read context.
2. Fix bug.
3. Verify login.

## Verification
- npm test
`,
    );
    await expect(main(["check", "plan"], root)).resolves.toBe(0);
    expect((await loadTask(root, taskId)).gate).toBe("implement");

    const blocked = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Edit",
      tool_input: { file_path: "src/login.ts" },
    });
    expect(JSON.stringify(blocked)).toContain("Read required MewoFlow context");

    for (const file of [
      ".mewoflow/rules.md",
      `.mewoflow/tasks/${taskId}/research.md`,
      `.mewoflow/tasks/${taskId}/grill.md`,
      `.mewoflow/tasks/${taskId}/plan.md`,
    ]) {
      await handlePostToolUse(root, { session_id: "s1", tool_name: "Read", tool_input: { file_path: file } });
    }

    const allowed = await handlePreToolUse(root, {
      session_id: "s1",
      tool_name: "Edit",
      tool_input: { file_path: "src/login.ts" },
    });
    expect(JSON.stringify(allowed)).not.toContain("deny");

    await expect(main(["check", "implement"], root)).resolves.toBe(0);
    expect((await loadTask(root, taskId)).gate).toBe("verify");

    await writeFileEnsured(
      taskFile(root, taskId, "verify.md"),
      `# Verify

## Result
- passed

## Commands Run
| Command | Result | Evidence |
|---|---|---|
| npm test | passed | login test passed |

## Critical Path
| Path | Result | Evidence |
|---|---|---|
| Login | passed | user can login |

## Review
Reviewer: main-agent
Result: passed
Findings: No blocking issues.

## Notes
- Verified.
`,
    );
    await expect(main(["check", "verify"], root)).resolves.toBe(0);
    expect((await loadTask(root, taskId)).gate).toBe("archive");

    await writeFileEnsured(
      taskFile(root, taskId, "archive.md"),
      `# Archive

## Summary
Login bug fixed.

## Decisions
- Keep change scoped.

## Verification
- npm test passed.

## Follow-ups
- None.

## Rule Updates
- none
`,
    );
    await expect(main(["check", "archive"], root)).resolves.toBe(0);
    expect((await loadTask(root, taskId)).gate).toBe("done");
    await expect(fs.readFile(path.join(root, ".mewoflow", "journal.md"), "utf8")).resolves.toContain("Login bug fixed.");
    await expect(fs.readFile(path.join(root, ".mewoflow", "journal.md"), "utf8")).resolves.toContain(taskId);
  });
});
