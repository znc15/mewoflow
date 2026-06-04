import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { createTask, loadTask, saveTask } from "../src/task.js";

const execFileAsync = promisify(execFile);

describe("mewoflow cli", () => {
  it("prints help", async () => {
    await expect(main(["help"])).resolves.toBe(0);
  });

  it("prints version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main(["--version"])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith("0.2.17");
    log.mockRestore();
  });

  it("previews project updates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-update-cli-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(main(["update", "--dry-run"], root)).resolves.toBe(0);

    const output = log.mock.calls.join("\n");
    expect(output).toContain("MewoFlow update dry run.");
    expect(output).toContain("Mode: preserve local template edits; refresh managed wiring.");
    expect(output).toContain(".mewoflow");
    log.mockRestore();
  });

  it("previews controlled git commits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-commit-"));
    await expect(main(["commit", "--dry-run"], root)).resolves.toBe(1);
    await execFileAsync("git", ["init"], { cwd: root });
    await fs.writeFile(path.join(root, "README.md"), "changed\n", "utf8");

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main(["commit", "--dry-run", "--message", "chore: test commit"], root)).resolves.toBe(0);

    expect(log.mock.calls.join("\n")).toContain("MewoFlow git commit dry run.");
    expect(log.mock.calls.join("\n")).toContain("Message: chore: test commit");
    log.mockRestore();
  });

  it("moves review/verify/archive tasks back to implement with rework", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-rework-cli-"));
    const task = await createTask(root, { title: "返工测试", type: "standard", gate: "review" });

    await expect(main(["rework"], root)).resolves.toBe(1);
    await expect(main(["rework", "--reason", "review found high severity bug"], root)).resolves.toBe(0);

    const updated = await loadTask(root, task.id);
    expect(updated.gate).toBe("implement");
    expect(updated.reviewed).toBe(false);
    expect(updated.reworks.at(-1)).toMatchObject({ fromGate: "review", reason: "review found high severity bug" });
  });

  it("records explicit deferred risk approval", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-risk-cli-"));
    const task = await createTask(root, { title: "延期风险测试", type: "standard", gate: "archive" });
    await saveTask(root, { ...task, reviewed: true });

    await expect(main(["approve-deferred-risk"], root)).resolves.toBe(1);
    await expect(main(["approve-deferred-risk", "--reason", "user accepted known high severity follow-up"], root)).resolves.toBe(0);

    const updated = await loadTask(root, task.id);
    expect(updated.deferredRiskApprovals.at(-1)).toMatchObject({ reason: "user accepted known high severity follow-up" });
  });
});
