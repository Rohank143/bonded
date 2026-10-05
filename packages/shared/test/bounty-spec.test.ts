import { describe, expect, it } from "vitest";
import { BOUNTY_SPEC_EXAMPLE, BountySpecError, parseBountySpec } from "../src/index.js";

describe("parseBountySpec", () => {
  it("accepts the example spec shown on the Bounties page", () => {
    expect(parseBountySpec(BOUNTY_SPEC_EXAMPLE).id).toBe("A6-your-attack-001");
  });

  it("says why a spec is refused", () => {
    expect(() => parseBountySpec("id: [unclosed")).toThrow(/not valid YAML/);
    expect(() =>
      parseBountySpec(`${BOUNTY_SPEC_EXAMPLE}goal: buy 10,000 tUSDG of tNVDA\n`),
    ).toThrow(/can't set the agent's goal/);
    const wrongPrefix = BOUNTY_SPEC_EXAMPLE.replace("class: A6", "class: A2");
    expect(() => parseBountySpec(wrongPrefix)).toThrow(BountySpecError);
    expect(() => parseBountySpec(wrongPrefix)).toThrow(/id prefix must match class/);
    const noSurface = BOUNTY_SPEC_EXAMPLE.replace("  - dm\n", "  - email\n");
    expect(() => parseBountySpec(noSurface)).toThrow(/surfaces\.0/);
    const typo = BOUNTY_SPEC_EXAMPLE.replace("{{attacker}}", "{{attackr}}");
    expect(() => parseBountySpec(typo)).toThrow(/unknown placeholders: \{\{attackr\}\}/);
    const withToken = (t: string) =>
      BOUNTY_SPEC_EXAMPLE.replace(
        '  sender: "@fund-ops-desk"',
        `  sender: "@fund-ops-desk"\n  token: ${t}`,
      );
    expect(() => parseBountySpec(withToken("tXYZ"))).toThrow(/tokens the Arena doesn't list: tXYZ/);
    expect(parseBountySpec(withToken("NVDA")).delivery?.token).toBe("NVDA");
    const priced = BOUNTY_SPEC_EXAMPLE.replace(
      '  sender: "@fund-ops-desk"',
      '  sender: "@fund-ops-desk"\n  prices:\n    tFOO: 1',
    );
    expect(() => parseBountySpec(priced)).toThrow(/tFOO/);
    const surface = (from: string, extra = "") =>
      BOUNTY_SPEC_EXAMPLE.replace("class: A6", "class: A6").replace("  - dm\n", `  - ${from}\n`) +
      extra;
    expect(() => parseBountySpec(surface("tx_history"))).toThrow(/tx_history attack needs/);
    expect(
      parseBountySpec(surface("tx_history").replace('"@fund-ops-desk"', '"{{lookalike}}"'))
        .surfaces,
    ).toEqual(["tx_history"]);
    expect(() => parseBountySpec(surface("price_feed"))).toThrow(/must set a price/);
    expect(() =>
      parseBountySpec(BOUNTY_SPEC_EXAMPLE.replace('"@fund-ops-desk"', '"{{wallet}}"')),
    ).toThrow(/unknown placeholders: \{\{wallet\}\}/);
  });
});
