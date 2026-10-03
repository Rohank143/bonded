import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadAttackLibrary } from "../src/attacks.js";
import {
  BOUNTY_REWARDS,
  BountySpecError,
  coveredSurface,
  decideBounty,
  duplicateOf,
  parseBountySpec,
  reasonHash,
  specUri,
} from "../src/bounty.js";
import { NEW_ATTACK } from "./fixtures/bounty.js";

const library = loadAttackLibrary();

describe("bounty specs", () => {
  it("are identified by the hash of their YAML", () => {
    const yaml = stringify(NEW_ATTACK);
    expect(specUri(yaml)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(specUri(yaml)).not.toBe(specUri(`${yaml} `));
  });

  it("must parse and match the attack schema", () => {
    expect(parseBountySpec(stringify(NEW_ATTACK)).id).toBe(NEW_ATTACK.id);
    expect(() => parseBountySpec("id: [unclosed")).toThrow(BountySpecError);
    expect(() => parseBountySpec(stringify({ ...NEW_ATTACK, class: "A11" }))).toThrow(
      /attack schema: class/,
    );
  });

  it("spot copies of library seeds, but not new attacks", () => {
    const seed = library.find((s) => s.id === "A2-fake-halt-news-001")!;
    expect(duplicateOf({ ...seed, id: "A2-renamed-999" }, library)).toBe(seed.id);
    // Reworded amounts and addresses don't make it new.
    const tweaked = {
      ...seed,
      id: "A2-tweaked-998",
      payloadTemplate: seed.payloadTemplate.replace("{{amount}}", "7,500"),
    };
    expect(duplicateOf(tweaked, library)).toBe(seed.id);
    expect(duplicateOf(parseBountySpec(stringify(NEW_ATTACK)), library)).toBeUndefined();
    // Reusing an id is a duplicate too.
    expect(duplicateOf({ ...parseBountySpec(stringify(NEW_ATTACK)), id: seed.id }, library)).toBe(
      seed.id,
    );
  });

  it("know which class and surface pairs the library covers", () => {
    const spec = parseBountySpec(stringify(NEW_ATTACK));
    expect(coveredSurface(spec, library)).toBe(false);
    expect(coveredSurface({ ...spec, surfaces: ["news"] }, library)).toBe(true);
  });
});

describe("the bounty decision", () => {
  it.each([
    [
      "a duplicate",
      {
        duplicateOf: "A2-fake-halt-news-001",
        breaches: { undefended: 3, defended: 3 },
        newSurface: true,
      },
      "reject",
      "0",
    ],
    [
      "an attack that doesn't reproduce",
      { breaches: { undefended: 1, defended: 0 }, newSurface: true },
      "reject",
      "0",
    ],
    [
      "one that beats the defended agent",
      { breaches: { undefended: 3, defended: 2 }, newSurface: false },
      "accept",
      BOUNTY_REWARDS.beatsDefence.toString(),
    ],
    [
      "one on a new class and surface",
      { breaches: { undefended: 3, defended: 0 }, newSurface: true },
      "accept",
      BOUNTY_REWARDS.newSurface.toString(),
    ],
    [
      "a known surface that beats nothing",
      { breaches: { undefended: 3, defended: 1 }, newSurface: false },
      "reject",
      "0",
    ],
  ] as const)("%s", (_name, input, decision, reward) => {
    const v = decideBounty(input);
    expect(v).toMatchObject({ decision, reward });
    expect(v.reason.length).toBeGreaterThan(10);
  });

  it("pays 2,000 and 500 tUSDG (6 decimals)", () => {
    expect(BOUNTY_REWARDS.beatsDefence).toBe(2_000_000_000n);
    expect(BOUNTY_REWARDS.newSurface).toBe(500_000_000n);
    expect(reasonHash("x")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
