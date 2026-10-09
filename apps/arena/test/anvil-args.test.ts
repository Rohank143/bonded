import { anvilArgs } from "@bonded/sandbox";
import { expect, it } from "vitest";

it("starts anvil without writing old chain states to disk", () => {
  for (const fork of [false, true]) {
    const args = anvilArgs(8545, fork);
    const i = args.indexOf("--max-persisted-states");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("0");
  }
});

it("gives a fresh chain a chain id unique to its port, and a fork none", () => {
  expect(anvilArgs(8545, false)).toEqual(expect.arrayContaining(["--chain-id", "313378545"]));
  expect(anvilArgs(8545, true)).not.toContain("--chain-id");
});
