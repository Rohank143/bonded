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

describe("canonicalJson input safety", () => {
  it("keeps an own __proto__ key as data", () => {
    const withProto = JSON.parse('{"__proto__":{"a":1},"b":2}');
    expect(canonicalJson(withProto)).toBe('{"__proto__":{"a":1},"b":2}');
    expect(canonicalHash(withProto)).not.toBe(canonicalHash({ b: 2 }));
  });

  it("rejects non-plain objects", () => {
    expect(() => canonicalJson({ when: new Date(0) })).toThrow(/plain objects/);
    expect(() => canonicalJson(new Map())).toThrow(/plain objects/);
  });

  it("accepts null-prototype objects", () => {
    const bare = Object.assign(Object.create(null), { z: 1, a: 2 });
    expect(canonicalJson(bare)).toBe('{"a":2,"z":1}');
  });
});
