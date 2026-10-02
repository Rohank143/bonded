import { describe, expect, it } from "vitest";
import { composeHashOf } from "../src/compose-hash.js";

const manifest = {
  manifest_version: 2,
  name: "bonded-tee-agent",
  runner: "docker-compose",
  docker_compose_file: "services:\n  agent:\n    image: example@sha256:abc\n",
  kms_enabled: true,
};

describe("composeHashOf", () => {
  it("is a 32-byte hash", () => {
    expect(composeHashOf(JSON.stringify(manifest))).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("does not depend on key order or whitespace", () => {
    const reordered = Object.fromEntries(Object.entries(manifest).reverse());
    expect(composeHashOf(JSON.stringify(reordered, null, 4))).toBe(
      composeHashOf(JSON.stringify(manifest)),
    );
  });

  it("gives the same hash for Phala's API view, with unset fields as null and an empty init_script", () => {
    const apiView = {
      ...manifest,
      salt: null,
      port_policy: null,
      swap_size: null,
      init_script: [],
    };
    expect(composeHashOf(JSON.stringify(apiView))).toBe(composeHashOf(JSON.stringify(manifest)));
  });

  it("still changes when a set field changes", () => {
    expect(composeHashOf(JSON.stringify({ ...manifest, kms_enabled: false }))).not.toBe(
      composeHashOf(JSON.stringify(manifest)),
    );
  });

  it("changes when the image changes", () => {
    const other = {
      ...manifest,
      docker_compose_file: manifest.docker_compose_file.replace("abc", "abd"),
    };
    expect(composeHashOf(JSON.stringify(other))).not.toBe(composeHashOf(JSON.stringify(manifest)));
  });

  it("refuses something that is not a manifest", () => {
    expect(() => composeHashOf("[]")).toThrow(/JSON object/);
    expect(() => composeHashOf("not json")).toThrow();
  });
});
