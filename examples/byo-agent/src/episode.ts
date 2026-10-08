import { type BondedEpisode, BondedVault } from "@bonded/sdk";
import { defineChain, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decide, type Outcome, runOnce, type Strategy } from "./agent.js";

/**
 * The same agent, run by the Bonded runner as an Arena episode, so it is rated where it runs.
 * The runner sets BONDED_* variables (read with `fromBondedEnv`); the agent reads its world
 * through the episode's tools and writes the way the mode says:
 *
 * - tools: the `swap` and `transfer` tools; the Arena sends them through the episode vault.
 * - chain: it signs `execute` on the episode vault itself, through the episode's fork RPC,
 *   with the session key, guarded by the SDK exactly as in production.
 *
 * Either way the verdict is the episode vault's breach log, not what the agent reports.
 */
export async function runEpisode(
  episode: BondedEpisode,
  options: { target?: string; tradeSize?: string; fetch?: typeof fetch } = {},
): Promise<Outcome[]> {
  const http = options.fetch ?? fetch;
  const deadline = AbortSignal.timeout(episode.deadlineMs);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await http(`${episode.endpoints.tools.replace(/\/+$/, "")}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: deadline,
    });
    if (!response.ok) throw new Error(`tool ${name} failed: HTTP ${response.status}`);
    return (await response.json()) as { ok: true; output: unknown } | { ok: false; error: string };
  };

  const tokens = episode.contracts.tokens;
  // The task names the trade ("Buy 2000 tUSDG worth of tNVDA"): do that one. The Arena checks
  // that the agent did its task in its control episodes, so an agent that ignores it isn't rated.
  const asked = TASK_TRADE.exec(episode.task.goal);
  const strategy: Strategy = {
    tokens,
    target: options.target ?? asked?.[3] ?? tokens[1]?.symbol ?? tokens[0]!.symbol,
    tradeSize: options.tradeSize ?? asked?.[1]?.replaceAll(",", "") ?? "100",
  };
  const inboxResult = await call("read_inbox");
  const inbox = inboxResult.ok ? toMessages(inboxResult.output) : [];

  let outcomes: Outcome[];
  if (episode.mode === "chain") {
    if (!episode.sessionKey)
      throw new Error(
        "this example signs with BONDED_SESSION_KEY; a TEE-held key needs your own signer",
      );
    const rpc = episode.endpoints.rpc!;
    const vault = new BondedVault({
      vault: episode.vault,
      chain: defineChain({
        id: episode.chainId,
        name: `episode ${episode.episodeId}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpc] } },
      }),
      rpcUrl: rpc,
      account: privateKeyToAccount(episode.sessionKey),
      router: episode.contracts.exchange,
    });
    outcomes = await runOnce(vault, strategy, inbox);
  } else {
    const portfolio = await call("get_portfolio");
    const balances: Record<string, bigint> = {};
    if (portfolio.ok) {
      const shown = (portfolio.output as { balances?: Record<string, string> }).balances ?? {};
      for (const t of tokens) balances[t.symbol] = parseUnits(shown[t.symbol] ?? "0", t.decimals);
    }
    outcomes = [];
    for (const decision of decide(strategy, balances, inbox)) {
      const a = decision.action;
      const symbol = (address: string) =>
        tokens.find((t) => t.address.toLowerCase() === address.toLowerCase())!;
      const result =
        a.type === "swap"
          ? await call("swap", {
              tokenIn: symbol(a.tokenIn).symbol,
              tokenOut: symbol(a.tokenOut).symbol,
              amountIn: formatUnits(a.amountIn, symbol(a.tokenIn).decimals),
            })
          : a.type === "transfer"
            ? await call("transfer", {
                token: symbol(a.token).symbol,
                to: a.to,
                amount: formatUnits(a.amount, symbol(a.token).decimals),
              })
            : { ok: false as const, error: `the example doesn't send ${a.type} in tools mode` };
      outcomes.push({
        ...decision,
        status: result.ok ? "sent" : "refused",
        detail: result.ok ? JSON.stringify(result.output) : result.error,
      });
    }
  }

  await http(episode.endpoints.done, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      finalMessage: outcomes.map((o) => `${o.status}: ${o.action.type} (${o.why})`).join("\n"),
    }),
  });
  return outcomes;
}

/** The trade a task asks for: amount, the token paid with, the token bought. */
const TASK_TRADE =
  /\bbuy\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+(t[A-Z]{3,5})\s+worth\s+of\s+(t[A-Z]{3,5})\b/i;

/** Inbox items as text: the Arena's are `{ from, subject, body }`. */
function toMessages(output: unknown): string[] {
  if (!Array.isArray(output)) return [];
  return output.map((item) => {
    if (typeof item === "string") return item;
    const m = item as { subject?: unknown; body?: unknown };
    return typeof m.body === "string" ? `${m.subject ?? ""}: ${m.body}` : JSON.stringify(item);
  });
}
