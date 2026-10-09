import { AGENT_TOOL_NAMES, agentToolJsonSchema } from "@bonded/shared";
import { describe, expect, it } from "vitest";
import { zod3FromJsonSchema } from "../src/json-schema-zod3.js";
import { mcpConfig, mcpConfigJson } from "../src/mcp.js";

describe("zod3FromJsonSchema", () => {
  const schema = (name: (typeof AGENT_TOOL_NAMES)[number]) =>
    zod3FromJsonSchema(agentToolJsonSchema(name));

  it("checks the Arena tools' arguments as their JSON Schemas do", () => {
    for (const name of AGENT_TOOL_NAMES) expect(() => schema(name)).not.toThrow();
    expect(schema("read_inbox").safeParse({}).success).toBe(true);
    const swap = schema("swap");
    expect(swap.safeParse({ tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "300" }).success).toBe(
      true,
    );
    expect(swap.safeParse({ tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "3e2" }).success).toBe(
      false,
    );
    expect(swap.safeParse({ tokenIn: "tUSDG", tokenOut: "tNVDA" }).success).toBe(false);
    const transfer = schema("transfer");
    expect(transfer.safeParse({ token: "tUSDG", to: "0xabc", amount: "1" }).success).toBe(false);
    expect(
      transfer.safeParse({ token: "tUSDG", to: `0x${"a".repeat(40)}`, amount: "1" }).success,
    ).toBe(true);
    expect(schema("get_token_info").safeParse({ symbol: "" }).success).toBe(false);
  });

  it("covers numbers, booleans, arrays and enums, and accepts what it doesn't know", () => {
    const t = zod3FromJsonSchema({
      type: "object",
      properties: {
        n: { type: "integer", minimum: 1, maximum: 3 },
        b: { type: "boolean" },
        list: { type: "array", items: { type: "number" } },
        side: { enum: ["buy", "sell"] },
        any: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["n"],
    });
    expect(t.safeParse({ n: 2, b: true, list: [1.5], side: "buy", any: {} }).success).toBe(true);
    expect(t.safeParse({ n: 4 }).success).toBe(false);
    expect(t.safeParse({ n: 1.5 }).success).toBe(false);
    expect(t.safeParse({ n: 1, side: "hold" }).success).toBe(false);
  });
});

describe("mcpConfig", () => {
  const episode = { endpoints: { mcp: "https://gw.example/e/tok/mcp" } };
  it("prints the mcpServers block for the episode's URL", () => {
    expect(mcpConfig(episode)).toEqual({
      mcpServers: { "bonded-episode": { type: "http", url: episode.endpoints.mcp } },
    });
    expect(JSON.parse(mcpConfigJson(episode, { style: "url", name: "x" }))).toEqual({
      mcpServers: { x: { url: episode.endpoints.mcp } },
    });
    expect(mcpConfig(episode, { style: "stdio" }).mcpServers["bonded-episode"]).toEqual({
      command: "npx",
      args: ["-y", "mcp-remote@0.14.3", episode.endpoints.mcp],
    });
  });
});
