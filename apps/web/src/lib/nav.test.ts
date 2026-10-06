import { describe, expect, it } from "vitest";
import { isNavActive } from "./nav";

describe("isNavActive", () => {
  it("keeps the pool link and the underwriting link apart", () => {
    expect(isNavActive("/underwrite", "/underwrite", "")).toBe(true);
    expect(isNavActive("/underwrite?mine=1", "/underwrite", "")).toBe(false);
    expect(isNavActive("/underwrite", "/underwrite", "?mine=1")).toBe(false);
    expect(isNavActive("/underwrite?mine=1", "/underwrite", "?mine=1")).toBe(true);
  });

  it("matches child pages unless end is set", () => {
    expect(isNavActive("/agents", "/agents/7", "")).toBe(true);
    expect(isNavActive("/agents", "/agents/7", "", true)).toBe(false);
    expect(isNavActive("/agents", "/agentsx", "")).toBe(false);
  });

  it("ignores other query parameters", () => {
    expect(isNavActive("/agents", "/agents", "?show=rated")).toBe(true);
  });
});
