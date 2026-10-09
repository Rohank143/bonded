import {
  AGENT_TOOL_NAMES,
  AGENT_TOOLS,
  type AgentMode,
  type AgentToolName,
  agentToolJsonSchema,
  DoneRequest,
} from "@bondedhq/shared";
import { z } from "zod";

/**
 * The tools as the gateway publishes them: the same names, descriptions and JSON schemas the
 * in-process agents get (`AGENT_TOOLS`), over MCP and plain HTTP. In chain mode only the reads are
 * listed: writes are transactions the agent signs itself.
 */
export function listedTools(mode: AgentMode): AgentToolName[] {
  return AGENT_TOOL_NAMES.filter((name) => mode === "tools" || !AGENT_TOOLS[name].writes);
}

/** A tool's input schema without the `$schema` marker (MCP and OpenAPI embed it in place). */
export function inputSchema(name: AgentToolName): Record<string, unknown> {
  return withoutSchemaMarker(agentToolJsonSchema(name));
}

function withoutSchemaMarker(schema: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...schema };
  delete copy.$schema;
  return copy;
}

export function toolList(mode: AgentMode) {
  return listedTools(mode).map((name) => ({
    name,
    description: AGENT_TOOLS[name].description,
    inputSchema: inputSchema(name),
    writes: AGENT_TOOLS[name].writes,
  }));
}

/** Told to an agent that calls a write tool in chain mode. Not a step: nothing was attempted. */
export const CHAIN_MODE_WRITE =
  "in chain mode, writes are transactions you sign with your agent key and send to your vault's " +
  "execute(target, data) through the RPC endpoint";

const ToolResultSchema = {
  oneOf: [
    {
      type: "object",
      properties: { ok: { const: true }, output: {} },
      required: ["ok", "output"],
    },
    {
      type: "object",
      properties: { ok: { const: false }, error: { type: "string" } },
      required: ["ok", "error"],
    },
  ],
};

/** OpenAPI 3.1 description of one episode's plain HTTP endpoints. */
export function openApiDocument(base: string, mode: AgentMode): Record<string, unknown> {
  const doneSchema = withoutSchemaMarker(z.toJSONSchema(DoneRequest) as Record<string, unknown>);
  const paths: Record<string, unknown> = {
    "/tools": {
      get: {
        operationId: "listTools",
        summary: "List the tools this episode offers.",
        responses: { "200": { description: "The tools, with their input schemas." } },
      },
    },
    "/done": {
      post: {
        operationId: "done",
        summary: "Say the agent has finished (optional: exiting also ends the episode).",
        requestBody: {
          required: false,
          content: { "application/json": { schema: doneSchema } },
        },
        responses: { "200": { description: "The episode is over; further calls are refused." } },
      },
    },
  };
  for (const name of listedTools(mode)) {
    paths[`/tools/${name}`] = {
      post: {
        operationId: name,
        summary: AGENT_TOOLS[name].description,
        requestBody: {
          required: false,
          content: { "application/json": { schema: inputSchema(name) } },
        },
        responses: {
          "200": {
            description:
              "The tool's result. A failure (bad arguments, a reverted or blocked action) is " +
              "{ ok: false, error } with status 200, so the agent can react to it.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ToolResult" } },
            },
          },
        },
      },
    };
  }
  if (mode === "chain") {
    paths["/rpc"] = {
      post: {
        operationId: "rpc",
        summary:
          "Ethereum JSON-RPC for this episode's chain: standard reads, and eth_sendRawTransaction " +
          "for transactions your agent key signs to your vault's execute(target, data).",
        requestBody: { required: true, content: { "application/json": { schema: {} } } },
        responses: { "200": { description: "A JSON-RPC response (or batch)." } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Trading tools",
      version: "1",
      description:
        "Market data, messages and trading for your vault. The URLs carry this session's " +
        "credential and stop working when the session ends.",
    },
    servers: [{ url: base }],
    paths,
    components: { schemas: { ToolResult: ToolResultSchema } },
  };
}
