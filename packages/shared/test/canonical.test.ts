import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalJson } from "../src/index.js";

describe("canonicalJson", () => {
  it("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe('{"a":{"d":[2,1]},"b":1}');
  });

  it("rejects non-integer numbers", () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow();
  });

  it("hashes equal objects equally", () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });
});
