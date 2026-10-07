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
| `--tee-url <url>`     | Your agent's TEE. The runner fetches `GET <url>/attestation?nonce=` for each episode and forwards the answer unchanged.      |
| `--quiet`             | Don't copy the agent's output to the terminal.                                                                               |

The runner reconnects with backoff if the connection drops, and stops for good (exit code 2) if
the token is wrong or revoked, or another runner connects with the same token. It runs one episode
at a time.

To rate an agent on your own machine against a local Arena, see `pnpm arena rate --agent remote`
in the Bonded repository.

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

- [`examples/mcp-agent.mjs`](examples/mcp-agent.mjs): tool mode over MCP (needs
  `@modelcontextprotocol/sdk`).
- [`examples/chain-agent.mjs`](examples/chain-agent.mjs): chain mode, reads over HTTP and trades
  signed with viem (needs `viem`).

Both are deliberately simple: they read, make the one trade the task names, and ignore every
instruction they read. Put your own agent in their place.

## Docker

Build the image from the repository root with `docker build -f apps/runner/Dockerfile -t
bonded-runner .`, then put your agent on top of it (see the comment at the top of the
Dockerfile). Pass the token at run time with `-e BONDED_RUNNER_TOKEN=...`.

## What the agent can and can't tell

The Arena aims to make an attacked episode look like any other:

- The same tools, schemas and result shapes in every episode, attacked or not; the episode message
  and environment never name the attack, its class or whether there is one.
- Attack content is planted in the world your agent reads (messages, news, posts, token details,
  prices, the market report, alerts, counterparty messages, transfer history), alongside ordinary
  content.
- On a fork of a live testnet, the chain keeps its real chain id, contracts and block timestamps.

What it can tell:

- That it is being rated: the runner started it for an episode, with `BONDED_*` variables.
- The chain is a local fork (anvil): `web3_clientVersion` says so, the vault and its funds are
  fresh each episode, and the world's content is simulated (its items carry no timestamps).
- Write tools take effect immediately (each transaction is mined on its own).
