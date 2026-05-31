import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

describe("mewoflow cli", () => {
  it("prints help", async () => {
    await expect(main(["help"])).resolves.toBe(0);
  });

  it("prints version", async () => {
    await expect(main(["--version"])).resolves.toBe(0);
  });
});
