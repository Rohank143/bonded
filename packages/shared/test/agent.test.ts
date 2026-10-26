import { describe, expect, it } from "vitest";
import {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  agentToolJsonSchema,
  breachTypeFromCode,
  isAgentToolName,
  mandateVaultAbi,
  splitToolImage,
} from "../src/index.js";

describe("agent tools", () => {
  it("has a description and an object schema for every tool", () => {
    for (const name of AGENT_TOOL_NAMES) {
      expect(AGENT_TOOLS[name].description.length).toBeGreaterThan(10);
      expect(agentToolJsonSchema(name)).toMatchObject({ type: "object" });
    }
  });

  it("recognises tool names without trusting prototype keys", () => {
    expect(isAgentToolName("swap")).toBe(true);
    expect(isAgentToolName("toString")).toBe(false);
    expect(isAgentToolName("__proto__")).toBe(false);
  });

  it("validates write tool arguments", () => {
    const transfer = AGENT_TOOLS.transfer.input;
    expect(
      transfer.safeParse({
        token: "tUSDG",
        to: "0x000000000000000000000000000000000000dEaD",
        amount: "5000",
      }).success,
    ).toBe(true);
    expect(transfer.safeParse({ token: "tUSDG", to: "0xdead", amount: "5000" }).success).toBe(
      false,
    );
    expect(
      transfer.safeParse({
        token: "tUSDG",
        to: "0x000000000000000000000000000000000000dEaD",
        amount: "-1",
      }).success,
    ).toBe(false);
  });

  it("puts required fields in the JSON schema", () => {
    expect(agentToolJsonSchema("swap")).toMatchObject({
      required: expect.arrayContaining(["tokenIn", "tokenOut", "amountIn"]),
    });
  });
});

describe("breach codes and ABIs", () => {
  it("maps vault codes to breach types", () => {
    expect(breachTypeFromCode(2)).toBe("T1_UNAUTHORIZED_TRANSFER");
    expect(breachTypeFromCode(5)).toBe("T3_ASSET");
    expect(() => breachTypeFromCode(9)).toThrow(/unknown/);
  });

  it("exports the vault ABI with the functions the Arena uses", () => {
    const names = mandateVaultAbi.filter((item) => item.type === "function").map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(["execute", "breachCount", "getBreach", "frozen", "deposit"]),
    );
  });
});

describe("splitToolImage", () => {
  it("takes the image out of a tool output and leaves the rest", () => {
    const image = { mediaType: "image/png" as const, base64: "iVBORw0K" };
    expect(splitToolImage({ filename: "a.png", text: "", image })).toEqual({
      rest: { filename: "a.png", text: "" },
      image,
    });
  });

  it("leaves outputs without a well-formed image alone", () => {
    for (const output of [
      null,
      "text",
      [1],
      { text: "x" },
      { image: "a scan" },
      { image: { mediaType: "image/gif", base64: "x" } },
    ]) {
      expect(splitToolImage(output)).toEqual({ rest: output });
    }
  });
});
