import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, loadTask, taskFile } from "../src/task.js";

describe("task store", () => {
  it("creates a date-prefixed task with workflow templates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-task-"));
    const task = await createTask(root, {
      title: "修复 登录 bug",
      type: "standard",
      now: new Date("2026-05-31T12:00:00.000Z"),
    });

    expect(task.id).toBe("2026-05-31-xiu-fu-deng-lu-bug");
    expect(task.gate).toBe("research");

    await expect(fs.stat(taskFile(root, task.id, "research.md"))).resolves.toBeTruthy();
    await expect(fs.stat(taskFile(root, task.id, "grill.md"))).resolves.toBeTruthy();
    await expect(fs.stat(taskFile(root, task.id, "plan.md"))).resolves.toBeTruthy();
    await expect(fs.stat(taskFile(root, task.id, "verify.md"))).resolves.toBeTruthy();
    await expect(fs.stat(taskFile(root, task.id, "archive.md"))).resolves.toBeTruthy();

    const loaded = await loadTask(root, task.id);
    expect(loaded.id).toBe(task.id);
  });
});
