import { describe, expect, it } from "vitest";
import { tierMeaning } from "./glossary";

describe("tierMeaning", () => {
  it("states the bond rule for insurable tiers", () => {
    expect(tierMeaning("AA")).toBe("Insurable; bond of at least 10% of cover.");
    expect(tierMeaning("BB")).toBe("Insurable; bond of at least 20% of cover.");
  });
  it("adds the pool cap where a tier has one", () => {
    expect(tierMeaning("B")).toBe(
      "Insurable; bond of at least 30% of cover, cover capped at 2% of the pool.",
    );
  });
  it("says CCC can't be covered", () => {
    expect(tierMeaning("CCC")).toBe("Not insurable: report only, no cover.");
  });
});
