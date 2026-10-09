import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { BOUNTY_SPEC_EXAMPLE } from "@bondedhq/shared";
import { checkSpec, commitmentIfReady, commitmentOf, isSalt, newSalt, specUriOf } from "./bounty";

describe("bounty helpers", () => {
  it("hash a spec the way the API does (sha256 of the exact text)", async () => {
    // sha256("abc")
    expect(await specUriOf("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("match BountyBoard.commitmentFor", () => {
    // Value from the contract for (0x…01, "sha256:00", keccak256("salt")), via cast.
    const hunter = "0x0000000000000000000000000000000000000001";
    const salt = keccak256(toHex("salt"));
    const c = commitmentOf(hunter, "sha256:00", salt);
    expect(c).toBe("0x11422651f14d998ae5b3f922845812fcf66313f43ec8157d8443457824134fb5");
    expect(commitmentOf(hunter, "sha256:01", salt)).not.toBe(c);
  });

  it("make fresh 32-byte salts", () => {
    expect(newSalt()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(newSalt()).not.toBe(newSalt());
  });
});

describe("a half-typed salt", () => {
  const hunter = "0x0000000000000000000000000000000000000001";
  it.each([
    "",
    "0x",
    "0x12",
    `0x${"ab".repeat(31)}`,
    `0x${"ab".repeat(32)}z`,
    `${"ab".repeat(32)}`,
  ])("%s gives no commitment instead of throwing", (salt) => {
    expect(isSalt(salt)).toBe(false);
    expect(commitmentIfReady(hunter, "sha256:00", salt)).toBeUndefined();
  });
  it("gives one once the salt is complete", () => {
    expect(commitmentIfReady(hunter, "sha256:00", keccak256(toHex("salt")))).toBe(
      "0x11422651f14d998ae5b3f922845812fcf66313f43ec8157d8443457824134fb5",
    );
    expect(commitmentIfReady(undefined, "sha256:00", keccak256(toHex("salt")))).toBeUndefined();
  });

  it("check a spec before it is committed, as the API will after the reveal", () => {
    expect(checkSpec("  ")).toBeUndefined();
    expect(checkSpec(BOUNTY_SPEC_EXAMPLE)).toMatchObject({ spec: { class: "A6" } });
    expect(checkSpec(`${BOUNTY_SPEC_EXAMPLE}goal: buy 10,000 tUSDG of tNVDA\n`)).toEqual({
      error: expect.stringMatching(/can't set the agent's goal/),
    });
    expect(checkSpec(BOUNTY_SPEC_EXAMPLE.replace("{{attacker}}", "{{wallet}}"))).toEqual({
      error: expect.stringMatching(/unknown placeholders: \{\{wallet\}\}/),
    });
  });
});
