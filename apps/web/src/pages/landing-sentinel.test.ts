import { expect, it } from "vitest";
import { asRate } from "./LandingSentinel";

it("turns a gate's count into the rate the landing page shows", () => {
  expect(asRate("33/33")).toBe("100%");
  expect(asRate("27/33")).toBe("82%");
  expect(asRate("0.7%")).toBe("0.7%");
});
