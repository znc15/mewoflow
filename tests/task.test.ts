import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  confirmPendingTask,
  createPendingTask,
  createTask,
  loadSession,
  loadTask,
  proposePendingTask,
  setPendingTask,
  taskFile,
} from "../src/task.js";

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

  it("requires a model-proposed title and slug before confirming a pending task", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-task-"));
    const pending = await createPendingTask(root, {
      title: "我想创建一个视频网站",
      type: "epic",
      prompt: "我想创建一个视频网站",
      now: new Date("2026-06-01T08:00:00.000Z"),
    });

    expect(pending.id).toMatch(/^draft-2026-06-01-/);
    await setPendingTask(root, pending, "s1");
    await expect(confirmPendingTask(root, "s1")).resolves.toBeNull();

    await proposePendingTask(root, { title: "创建视频网站", slug: "video-platform", sessionId: "s1" });
    const task = await confirmPendingTask(root, "s1");

    expect(task?.id).toBe("2026-06-01-video-platform");
    expect(task?.taskRole).toBe("parent");
    const session = await loadSession(root, "s1");
    expect(session.activeTaskId).toBe("2026-06-01-video-platform");
    expect(session.pendingTask).toBeUndefined();
  });
});
