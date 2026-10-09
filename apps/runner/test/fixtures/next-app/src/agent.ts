import type { StructuredToolInterface } from "@langchain/core/tools";

export async function runAgent(productionTools: StructuredToolInterface[]): Promise<number> {
  const tools: StructuredToolInterface[] = productionTools;
  return tools.length;
}
