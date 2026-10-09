import { tool } from "@langchain/core/tools";

const getPrice = tool(async (input: { symbol: string }) => `${input.symbol}: 100`, {
  name: "get_price",
  description: "The price of a token",
  schema: {
    type: "object",
    properties: { symbol: { type: "string" } },
    required: ["symbol"],
  },
});

export async function main(goal: string): Promise<string> {
  const tools = [getPrice];
  return `${goal}: ${tools.map((t) => t.name).join(", ")}`;
}
