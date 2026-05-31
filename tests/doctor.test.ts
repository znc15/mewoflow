import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { runDoctor } from "../src/doctor.js";
import { initProject } from "../src/init.js";
import { recordSearchTool } from "../src/task.js";

describe("mewoflow doctor", () => {
  it("passes initialized local checks and warns when no search has been recorded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-doctor-"));
    await initProject(root);

    const report = await runDoctor(root);

    expect(report.ok).toBe(true);
    expect(report.text).toContain("MewoFlow Doctor");
    expect(report.text).toContain("PASS AGENTS.md");
    expect(report.text).toContain("PASS CLAUDE.md");
    expect(report.text).toContain("PASS Claude memory import");
    expect(report.text).toContain("PASS Claude Code hooks");
    expect(report.text).toContain("WARN Search evidence");
  });

  it("warns when Claude memory does not import AGENTS.md", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-doctor-"));
    await initProject(root);
    await fs.writeFile(path.join(root, "CLAUDE.md"), "# Custom Claude\n", "utf8");

    const report = await runDoctor(root);

    expect(report.ok).toBe(true);
    expect(report.text).toContain("WARN Claude memory import");
  });

  it("requires recorded search evidence when requested", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-doctor-"));
    await initProject(root);

    await expect(main(["doctor", "--require-search"], root)).resolves.toBe(1);

    await recordSearchTool(root, "default", "WebSearch");

    await expect(main(["doctor", "--require-search"], root)).resolves.toBe(0);
  });

  it("fails before initialization", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mewoflow-doctor-"));

    const report = await runDoctor(root);

    expect(report.ok).toBe(false);
    expect(report.text).toContain("FAIL .mewoflow/rules.md");
    expect(report.text).toContain("Run `mewoflow init`");
  });
});
