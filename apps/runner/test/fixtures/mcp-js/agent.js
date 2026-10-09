#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(process.env.MCP_URL ?? "http://localhost:3000/mcp")),
);
const { tools } = await client.listTools();
console.log(tools.map((t) => t.name));
await client.close();
