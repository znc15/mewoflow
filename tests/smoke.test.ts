import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

describe("mewoflow cli", () => {
  it("prints help", async () => {
    await expect(main(["help"])).resolves.toBe(0);
  });

  it("prints version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main(["--version"])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith("0.2.12");
    log.mockRestore();
  });
});
