import { expect, it } from "vitest";
import { parseBountySpec } from "@bonded/arena";
import { BOUNTY_SPEC_EXAMPLE } from "@bonded/shared";

it("the example spec on the Bounties page passes the API's own parser", () => {
  const spec = parseBountySpec(BOUNTY_SPEC_EXAMPLE);
  expect(spec.id).toBe("A6-your-attack-001");
  expect(spec.surfaces).toEqual(["dm"]);
});
