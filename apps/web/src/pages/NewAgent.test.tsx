import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Abi, type AbiEvent } from "viem";
import { bondedRegistryAbi, mandateVaultFactoryAbi } from "@bondedhq/shared";
import type { OfficialPrefill } from "../components/preview-report";
import { deployment } from "../config";
import { byoaApi } from "../lib/byoa-api";
import { saveSession } from "../lib/connect";
import { iso } from "../test/byoa-fixtures";
import { NewAgent } from "./NewAgent";

const chain = vi.hoisted(() => ({
  capabilities: {} as unknown,
  sendCalls: [] as unknown[],
  receipts: [] as unknown[][],
  writes: 0,
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: "0x00000000000000000000000000000000000000a1",
    isConnected: true,
    chainId: 46630,
  }),
  useSignMessage: () => ({ signMessageAsync: async () => "0x5151" }),
  useWriteContract: () => ({
    writeContractAsync: async () => {
      chain.writes++;
      return "0x1";
    },
  }),
  useBalance: () => ({ data: undefined }),
}));
vi.mock("wagmi/actions", () => ({
  getCapabilities: async () => chain.capabilities,
  getGasPrice: async () => 1n,
  sendCalls: async (_: unknown, args: unknown) => {
    chain.sendCalls.push(args);
    return { id: `batch-${chain.sendCalls.length}` };
  },
  waitForCallsStatus: async () => ({
    status: "success",
    receipts: [{ logs: chain.receipts[chain.sendCalls.length - 1] ?? [], transactionHash: "0xab" }],
  }),
  getPublicClient: () => undefined,
  readContract: async () => undefined,
  waitForTransactionReceipt: async () => ({ status: "success", logs: [] }),
}));
vi.mock("../wagmi", () => ({ wagmiConfig: {} }));
vi.mock("../lib/self-serve", async (load) => ({
  ...(await load<typeof import("../lib/self-serve")>()),
  registerForRatings: vi.fn(async () => ({})),
}));

/** A log of `eventName`, as a receipt carries it. */
function log(abi: Abi, eventName: string, args: Record<string, unknown>, address: string) {
  const event = getAbiItem({ abi, name: eventName }) as AbiEvent;
  const indexed = Object.fromEntries(
    event.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]]),
  );
  const rest = event.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi, eventName, args: indexed } as never),
    data: encodeAbiParameters(
      rest,
      rest.map((i) => args[i.name!]),
    ),
    blockNumber: 1n,
    transactionHash: "0xab",
    logIndex: 0,
    blockHash: "0x01",
    transactionIndex: 0,
    removed: false,
  };
}

function show(prefill?: OfficialPrefill) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter
      initialEntries={[
        prefill
          ? { pathname: "/agents/new", search: `?preview=${prefill.previewId}`, state: { prefill } }
          : "/agents/new",
      ]}
    >
      <QueryClientProvider client={client}>
        <NewAgent />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  chain.capabilities = {};
  chain.sendCalls = [];
  chain.receipts = [];
  chain.writes = 0;
});

describe("Onboarding your own agent", () => {
  it("offers the two ways to connect, with the code hash optional under Advanced", () => {
    show();
    fireEvent.click(screen.getByRole("radio", { name: /My own agent/ }));
    expect(screen.getByRole("link", { name: "Test your agent first" }).getAttribute("href")).toBe(
      "/agents/test",
    );
    expect(screen.getByRole("radio", { name: /It's online at a URL/ })).toHaveProperty(
      "checked",
      true,
    );
    // URL mode needs a URL, and says so in the list of what's missing.
    expect(screen.getByText("Paste your agent's URL.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your agent's URL"), {
      target: { value: "https://agent.example/bonded" },
    });
    expect(screen.queryByText("Paste your agent's URL.")).toBeNull();
    // No code hash needed: it fills itself in.
    expect(screen.queryByText("Enter your agent's code hash.")).toBeNull();
    const advanced = screen.getByText("Advanced (optional)").closest("details")!;
    expect(advanced.open).toBe(false);
    expect(screen.getByLabelText("Code hash").getAttribute("placeholder")).toBe(
      "Filled in automatically",
    );
    fireEvent.change(screen.getByLabelText("Code hash"), { target: { value: "0x12" } });
    expect(screen.getAllByText(/A code hash is 0x and 64 hex digits/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Then you connect it and check the connection, here/)).toBeTruthy();
  });

  it("with the runner, needs no URL and says the command comes right after", () => {
    show();
    fireEvent.click(screen.getByRole("radio", { name: /My own agent/ }));
    fireEvent.click(screen.getByRole("radio", { name: /On my computer or server/ }));
    expect(screen.queryByLabelText("Your agent's URL")).toBeNull();
    expect(screen.getByText(/Right after onboarding you get the runner's command/)).toBeTruthy();
  });

  it("fills itself in from a preview when made official", () => {
    show({
      previewId: "p1",
      mode: "chain",
      connection: "runner",
      agentUrl: null,
      codeHash: { value: `0x${"b".repeat(64)}`, source: "declared" },
    });
    expect(screen.getByText("Filled in from your preview")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /My own agent/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: /On my computer or server/ })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("radio", { name: /^Chain/ })).toHaveProperty("checked", true);
    expect(screen.getByText("Advanced (optional)").closest("details")!.open).toBe(true);
    expect((screen.getByLabelText("Code hash") as HTMLInputElement).value).toBe(
      `0x${"b".repeat(64)}`,
    );
  });

  it("carries an Agent URL over, and shows where an automatic code hash came from", () => {
    show({
      previewId: "p2",
      mode: "tools",
      connection: "url",
      agentUrl: "https://agent.example/bonded",
      codeHash: { value: `0x${"c".repeat(64)}`, source: "url", detail: "v1.4.2" },
    });
    expect((screen.getByLabelText("Your agent's URL") as HTMLInputElement).value).toBe(
      "https://agent.example/bonded",
    );
    expect((screen.getByLabelText("Code hash") as HTMLInputElement).value).toBe("");
    expect(
      screen.getByText(/In your preview it came from the version your agent reported \(v1.4.2\)/),
    ).toBeTruthy();
  });
});

describe("Onboarding, the wallet side", () => {
  it("counts one confirmation per transaction for a wallet that can't batch", async () => {
    show();
    expect(await screen.findByText(/^7 wallet confirmations, then one signature/)).toBeTruthy();
  });

  it("counts one per batch for a wallet that batches, and sends three batches", async () => {
    chain.capabilities = { 46630: { atomic: { status: "supported" } } };
    const vault = "0x00000000000000000000000000000000000000f1";
    chain.receipts = [
      [
        log(
          bondedRegistryAbi as Abi,
          "Registered",
          { agentId: 77n, agentURI: "x", owner: "0x00000000000000000000000000000000000000a1" },
          deployment.registry,
        ),
      ],
      [
        log(
          mandateVaultFactoryAbi as Abi,
          "VaultCreated",
          {
            vault,
            agentId: 77n,
            guardian: "0x00000000000000000000000000000000000000a1",
            agent: "0x00000000000000000000000000000000000000a1",
            mandateHash: `0x${"1".repeat(64)}`,
          },
          deployment.factory,
        ),
      ],
    ];
    show();
    expect(
      await screen.findByText(
        /^3 wallet confirmations \(your wallet sends them in batches, instead of 7\)/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Onboard the agent" }));
    await waitFor(() => expect(screen.getByText("Agent 77 is set up.")).toBeTruthy());
    expect(chain.sendCalls).toHaveLength(3);
    expect(chain.writes).toBe(0);
    const counts = (chain.sendCalls as { calls: unknown[]; forceAtomic: boolean }[]).map((c) => [
      c.calls.length,
      c.forceAtomic,
    ]);
    expect(counts).toEqual([
      [3, true],
      [2, true],
      [2, true],
    ]);
    // The deposit's batch goes to the vault the receipt named, not a guess.
    const last = (chain.sendCalls[2] as { calls: { to: string }[] }).calls;
    expect(last[1]!.to).toBe(vault);
  });

  it("explains the bond and recommends one for the cover wanted", () => {
    show();
    expect(screen.getByText(/the bond pays first, then the cover pool/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Cover you want"), { target: { value: "20000" } });
    expect(screen.getByText("BBB to AAA (10% of the cover)")).toBeTruthy();
    expect(screen.getByText(/without a score yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use this bond" }));
    expect((screen.getByLabelText(/Operator bond/) as HTMLInputElement).value).toBe("6000");
  });

  it("prefills the mandate from the preview's suggestion, with presets", async () => {
    saveSession(deployment.chainId, {
      session: "sess",
      wallet: "0x00000000000000000000000000000000000000a1",
      expiresAt: iso(3_600_000),
    });
    const suggest = vi.spyOn(byoaApi, "suggestedMandate").mockResolvedValue({
      tokens: ["tTSLA"],
      contracts: [{ address: deployment.router, label: "the test exchange" }],
      largestTradeUsd: 900,
      basis: {
        sources: ["check", "preview"],
        trades: 3,
        tokens: ["tTSLA"],
        largestTradeUsd: 900,
        usedRouter: true,
        transfers: 0,
        approvals: 1,
      },
      notes: ["Add your refund address: the agent made no transfers."],
      recommended: "active",
      presets: [
        {
          id: "conservative",
          label: "Conservative trader",
          line: "Enforce, the tokens it used.",
          mode: "enforce",
          tokens: ["tTSLA"],
          maxTxUsd: 1200,
          maxDailyUsd: 4000,
          rules: { assets: [deployment.tsla] },
        },
        {
          id: "active",
          label: "Active trader",
          line: "Enforce, more headroom.",
          mode: "enforce",
          tokens: ["tTSLA", "tNVDA"],
          maxTxUsd: 3000,
          maxDailyUsd: 15000,
          rules: { assets: [deployment.tsla, deployment.nvda] },
        },
      ],
    });
    show({ previewId: "p1", mode: "tools", connection: "url", agentUrl: null, codeHash: null });
    expect(
      await screen.findByText(/its largest trade was 900 USD, through the test exchange/),
    ).toBeTruthy();
    expect(suggest).toHaveBeenCalledWith({ kind: "preview", id: "p1" }, "sess");
    expect(
      screen.getByText(/From your passing check and your preview \(3 trades\): it traded tTSLA/),
    ).toBeTruthy();
    expect(screen.getByText(/Add your refund address/)).toBeTruthy();
    // The API's recommended preset is picked first.
    expect(screen.getByRole("radio", { name: /^Active trader/ })).toHaveProperty("checked", true);
    expect((screen.getByLabelText("Daily limit") as HTMLInputElement).value).toBe("15000");
    fireEvent.click(screen.getByRole("radio", { name: /^Conservative trader/ }));
    expect((screen.getByLabelText("Per-trade limit") as HTMLInputElement).value).toBe("1200");
    fireEvent.change(screen.getByLabelText("Per-trade limit"), { target: { value: "2000" } });
    expect(screen.getByRole("radio", { name: /^Custom/ })).toHaveProperty("checked", true);
  });
});
