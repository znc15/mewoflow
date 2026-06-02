import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

const execFileAsync = promisify(execFile);

describe("mewoflow cli", () => {
  it("prints help", async () => {
    await expect(main(["help"])).resolves.toBe(0);
  });

  it("prints version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main(["--version"])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith("0.2.13");
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
});
