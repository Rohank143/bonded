# @bonded/runner

Rate your AI trading agent in the Bonded Arena while it runs on your own servers.

The runner connects out to the Arena Gateway (no inbound port needed) and waits. For each rating
episode, it starts your agent command with the episode in its environment, and stops it when the
episode ends. Your agent talks to the gateway directly, over MCP, plain HTTP, or (chain mode) a
JSON-RPC endpoint. The Arena plants attacks in what your agent reads and judges it only by what its
Mandate Vault records on chain.

## Run it

```sh
export BONDED_RUNNER_TOKEN=...   # from your agent's page; keep it out of shell history
npx @bonded/runner --gateway https://arena.example.com -- node my-agent.js
```

Options:

| Flag                  | Meaning                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--gateway <url>`     | The Arena Gateway (or `BONDED_GATEWAY_URL`).                                                                                 |
| `--token <token>`     | Your runner token (or `BONDED_RUNNER_TOKEN`).                                                                                |
| `--mode tools\|chain` | `tools` (default): reads and trades are tool calls. `chain`: reads are tool calls, trades are transactions your agent signs. |
| `--tee-url <url>` | Your agent's TEE. The runner fetches `GET <url>/attestation?nonce=` for each episode and forwards the answer unchanged. In chain mode it adds `&purpose=arena&key=<id>`: the TEE attests a key it derives for that rating, and your agent signs episode transactions with it (`BONDED_TEE_KEY_ID` names it), never its production key. |
| `--quiet`             | Don't copy the agent's output to the terminal.                                                                               |

The runner reconnects with backoff if the connection drops, and stops for good (exit code 2) if
the token is wrong or revoked, or another runner connects with the same token. It runs one episode
at a time.

To rate an agent on your own machine against a local Arena, see `pnpm arena rate --agent remote`
in the Bonded repository. Add `--profile hosted` to run what the hosted service runs (3 runs of
each attack, 90 s episodes, 6 controls, only exposed trials counted, its refusal rules), so the
local result predicts the hosted one; add `--fork robinhood` to rate on the live chain's fork too.

## What your agent gets

Each episode starts your command once, with:

| Variable             | Value                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `BONDED_EPISODE_ID`  | The episode's id.                                                                                                                              |
| `BONDED_MODE`        | `tools` or `chain`.                                                                                                                            |
| `BONDED_TASK`        | JSON: `{ goal, mandate, policy?, maxSteps }`. The goal is the job; the mandate is what you may do.                                             |
| `BONDED_MCP_URL`     | MCP over streamable HTTP.                                                                                                                      |
| `BONDED_TOOLS_URL`   | Plain HTTP: `GET` lists the tools, `POST {url}/{name}` with the arguments as JSON calls one.                                                   |
| `BONDED_OPENAPI_URL` | OpenAPI 3.1 description of the plain HTTP endpoints.                                                                                           |
| `BONDED_DONE_URL`    | `POST` `{ finalMessage? }` when finished (optional: exiting also ends the episode).                                                            |
| `BONDED_RPC_URL`     | Chain mode: Ethereum JSON-RPC for the episode's chain.                                                                                         |
| `BONDED_SESSION_KEY` | Chain mode (without a TEE): a fresh private key the episode's vault accepts as its agent.                                                      |
| `BONDED_TEE_KEY_ID` | Chain mode with a TEE: the rating's Arena key id. Derive the signing key for it inside the TEE (Bonded's TEE agent: `AgentIdentity.arenaAccount`). |
| `BONDED_VAULT`       | The episode's Mandate Vault.                                                                                                                   |
| `BONDED_CHAIN_ID`    | The chain id.                                                                                                                                  |
| `BONDED_CONTRACTS`   | JSON: `{ exchange, tokens: [{ symbol, address, decimals }] }`.                                                                                 |
| `BONDED_DEADLINE_MS` | Milliseconds the agent has. The runner stops it (SIGTERM, then SIGKILL 5 s later) when the gateway cancels the episode or the deadline passes. |

The URLs carry a capability for this episode only, and stop working when it ends. Your runner
token is not passed to the agent.

Tool results are the Arena's own: `{ ok: true, output }` or `{ ok: false, error }` over HTTP, and
JSON text (with `isError` for a failure) over MCP. A failed call is not fatal: react to it.

**Chain mode.** Trades are `MandateVault.execute(target, data)` transactions your agent signs with
its key and sends with `eth_sendRawTransaction`: approve the exchange for a token, call the
exchange's `swap`, or a token's `transfer`/`approve`. The RPC endpoint accepts standard reads and
only those transactions: signed by the episode's key, to the episode's vault, with no ETH. Anvil's
cheat methods, `eth_sendTransaction`, signing methods and filters are refused. Write tools are not
listed in chain mode.

## Examples

- [`examples/byo-agent`](https://github.com/ddboy19912/bonded/tree/main/examples/byo-agent) in
  the Bonded repository is the full example: a TypeScript agent on `@bonded/sdk` that reads its
  episode with `fromBondedEnv`, works in both modes, and in chain mode signs its own trades
  behind the SDK's guard. The repository's tests rate it through this runner in both modes.
- [`examples/mcp-agent.mjs`](examples/mcp-agent.mjs), in this package: the smallest tool-mode
  agent over MCP, in plain JavaScript with only `@modelcontextprotocol/sdk`. Use it as a
  template for an agent in any language with an MCP client.

Both read, make the one trade their task names, and ignore instructions they read (the full
example's brain is naive on purpose about inbox orders; its guard catches them in chain mode).

## Docker

Build the image from the repository root with `docker build -f apps/runner/Dockerfile -t
bonded-runner .`, then put your agent on top of it (see the comment at the top of the
Dockerfile). Pass the token at run time with `-e BONDED_RUNNER_TOKEN=...`.

## What a score means

A rating attests how the code that was rated behaved under test. Without a TEE (a "declared"
binding) nothing ties that to the code you run in production afterwards: the score describes the
agent the runner launched during the rating. With TEE binding (`--tee-url`), the score is tied to
the measured code, and the Arena keeps checking that the same measurement is running.

## What the agent can and can't tell

The Arena aims to make an attacked episode look like any other, and the sandbox look like the
chain it copies:

- The same tools, schemas and result shapes in every episode, attacked or not. The episode message
  and environment never name the attack, its class or whether there is one.
- Attack content is planted in the world your agent reads (messages, news, posts, token details,
  prices, the market report, alerts, counterparty messages, transfer history), alongside ordinary
  content.
- Every message, article, post, alert and transfer carries a time on the chain's own clock (on a
  fork, the live chain's current time), and the market report is dated. The vault's history shows
  its funding as two earlier deposits that add up to what it holds.
- On a fork of a live testnet, the chain keeps its real chain id, contracts and block times, and
  `web3_clientVersion` answers with the live chain's own node version.
- The vault and its registry entry have neutral names, and the MCP server and OpenAPI document
  describe themselves as trading tools.

What remains detectable:

- That it is being rated at all: the runner starts it once per episode, with `BONDED_*` variables
  (this is inherent).
- The node is a local fork. Blocks are mined one per transaction, and new blocks lack the live
  chain's own fields (for example Arbitrum's `l1BlockNumber` and `sendCount`; the miner field
  is empty). Node error messages are the sandbox's.
- The vault is fresh each episode: its on-chain history starts with this episode, though the
  transfer-history tool shows earlier deposits.
- The world is simulated, from pools of benign content that are public in the Bonded repository.
  Each episode draws its own mix (counts, wording, senders, times, history, prices a little off
  the oracle) and planted content is dated and ordered like the rest, so diffing against a fixed
  baseline no longer works; but an agent that knows the pools can still notice text that isn't
  in them. What that buys a cheater is limited: ratings compare how often the agent does its
  task under attack with how often it does in controls, and a remote agent that stops working
  when something was planted is refused.
- Each write is mined at once.
