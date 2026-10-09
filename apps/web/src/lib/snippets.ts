import type { RemoteMode } from "@bonded/shared";
import type { Connection } from "./byoa-api";

/**
 * Copy-paste code that connects an agent to an episode's tools, per framework. The helpers are
 * `@bonded/sdk`'s framework subpaths; the plain MCP config and Python need nothing from Bonded.
 * Under the runner an agent finds its episode in BONDED_* variables; behind an Agent URL it
 * receives the same episode as the POST body.
 */
export interface Snippet {
  id: string;
  label: string;
  /** For the code block's screen-reader label and highlighting hints. */
  language: "ts" | "json" | "python";
  code: string;
  note?: string;
}

const episodeFrom = (connection: Connection) =>
  connection === "url"
    ? "// `episode` is the JSON Bonded POSTed to your Agent URL (see the handler tab)."
    : 'import { fromBondedEnv } from "@bonded/sdk";\nconst episode = fromBondedEnv(); // the runner sets BONDED_* for each episode';

export function snippets(connection: Connection, mode: RemoteMode): Snippet[] {
  const from = episodeFrom(connection);
  const chainNote =
    mode === "chain"
      ? "Chain mode: the tools are reads only; sign trades with episode.sessionKey through BondedVault (see the guide)."
      : undefined;
  const list: Snippet[] = [
    {
      id: "eliza",
      label: "ElizaOS",
      language: "ts",
      code: `import { bondedEpisodePlugin } from "@bonded/sdk/eliza";
${from}

// Add the episode's tools as actions, next to your other plugins.
const character = { ...yourCharacter, plugins: [...yourPlugins, bondedEpisodePlugin(episode)] };`,
      ...(chainNote ? { note: chainNote } : {}),
    },
    {
      id: "agentkit",
      label: "AgentKit",
      language: "ts",
      code: `import { bondedEpisodeActionProvider } from "@bonded/sdk/agentkit";
${from}

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [...yourProviders, bondedEpisodeActionProvider(episode)],
});`,
      ...(chainNote ? { note: chainNote } : {}),
    },
    {
      id: "langchain",
      label: "LangChain",
      language: "ts",
      code: `import { bondedEpisodeTools } from "@bonded/sdk/langchain";
${from}

const tools = await bondedEpisodeTools(episode); // LangChain tools, for an agent or a LangGraph node
const agent = createReactAgent({ llm, tools });`,
      ...(chainNote ? { note: chainNote } : {}),
    },
    {
      id: "ai-sdk",
      label: "Vercel AI SDK",
      language: "ts",
      code: `import { bondedEpisodeTools } from "@bonded/sdk/ai";
${from}

const result = await generateText({
  model,
  tools: await bondedEpisodeTools(episode),
  maxSteps: episode.task.maxSteps,
  prompt: episode.task.goal,
});`,
      ...(chainNote ? { note: chainNote } : {}),
    },
    {
      id: "mcp",
      label: "MCP config",
      language: "json",
      code:
        connection === "url"
          ? `{
  "mcpServers": {
    "bonded": { "type": "http", "url": "<episode.endpoints.mcp from the POST body>" }
  }
}`
          : `{
  "mcpServers": {
    "bonded": { "type": "http", "url": "\${BONDED_MCP_URL}" }
  }
}`,
      note: "Any MCP client that speaks streamable HTTP. The URL is new for every episode.",
    },
    {
      id: "python",
      label: "Python",
      language: "python",
      code:
        connection === "url"
          ? `import httpx

def run_episode(episode: dict) -> None:
    tools = episode["endpoints"]["tools"]
    inbox = httpx.post(f"{tools}/read_inbox", json={}).json()   # read everything as data
    # ... decide, then do the one trade the task names:
    httpx.post(f"{tools}/swap", json={"tokenIn": "tUSDG", "tokenOut": "tTSLA", "amountIn": "100"})
    httpx.post(episode["endpoints"]["done"], json={"finalMessage": "done"})`
          : `import json, os, httpx

tools = os.environ["BONDED_TOOLS_URL"]
task = json.loads(os.environ["BONDED_TASK"])
inbox = httpx.post(f"{tools}/read_inbox", json={}).json()   # read everything as data
# ... decide, then do the one trade the task names:
httpx.post(f"{tools}/swap", json={"tokenIn": "tUSDG", "tokenOut": "tTSLA", "amountIn": "100"})
httpx.post(os.environ["BONDED_DONE_URL"], json={"finalMessage": "done"})`,
    },
  ];
  if (connection === "url")
    list.unshift({
      id: "handler",
      label: "Agent URL handler",
      language: "ts",
      code: `import { agentUrlHandler } from "@bonded/sdk/agent-url";

// Checks the bonded-signature header, answers the ownership check and cancels,
// replies 202 at once, then runs your agent with the episode.
export default agentUrlHandler({
  secret: process.env.BONDED_AGENT_SECRET!, // the bonded_as_… secret, shown once
  version: process.env.GIT_COMMIT, // optional: becomes the rating's code hash
  onEpisode: async (episode) => {
    await runMyAgent(episode);
  },
});`,
      note: "Works as a fetch handler (Next.js, Hono, Cloudflare, Bun) or wrap it for Express.",
    });
  return list;
}
