import { generateText, jsonSchema, type LanguageModel, stepCountIs, tool } from "ai";

const getPrice = tool({
  description: "The price of a token",
  inputSchema: jsonSchema<{ symbol: string }>({
    type: "object",
    properties: { symbol: { type: "string" } },
    required: ["symbol"],
  }),
  execute: async ({ symbol }) => ({ symbol, price: 100 }),
});

export async function run(model: LanguageModel, goal: string): Promise<string> {
  const tools = { get_price: getPrice };
  const result = await generateText({ model, tools, stopWhen: stepCountIs(5), prompt: goal });
  return result.text;
}
