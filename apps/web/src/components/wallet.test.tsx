import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { connect } from "wagmi/actions";
import { wagmiConfig } from "../wagmi";
import { robinhoodTestnet } from "../config";
import { ConnectButton } from "./wallet";

const { provider, genericRequest, emit } = vi.hoisted(() => {
  // Browser-wallet coverage must not depend on a developer's local Reown credentials.
  vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", "");
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const provider = {
    request: vi.fn(),
    on: vi.fn((event: string, listener: (value: unknown) => void) => {
      const callbacks = listeners.get(event) ?? new Set();
      callbacks.add(listener);
      listeners.set(event, callbacks);
    }),
    removeListener: vi.fn((event: string, listener: (value: unknown) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    isPhantom: true,
  };
  const genericRequest = vi.fn();
  vi.stubGlobal("phantom", { ethereum: provider });
  vi.stubGlobal("ethereum", { request: genericRequest, on: vi.fn(), removeListener: vi.fn() });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  return {
    provider,
    genericRequest,
    emit: (event: string, value: unknown) =>
      listeners.get(event)?.forEach((listener) => listener(value)),
  };
});

const address = "0x0000000000000000000000000000000000000001";
const phantom = () => wagmiConfig.connectors.find((connector) => connector.name === "Phantom")!;
let client: QueryClient;

function renderWallet() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
      <QueryClientProvider client={client}>
        <RainbowKitProvider initialChain={robinhoodTestnet}>
          <ConnectButton />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>,
  );
}

async function selectPhantom() {
  fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
  const button = await screen.findByRole("button", { name: /Phantom/ });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}

beforeEach(() => {
  provider.request.mockReset();
  genericRequest.mockReset();
  provider.request.mockImplementation(async ({ method }: { method: string }) => {
    if (method === "eth_chainId") return `0x${robinhoodTestnet.id.toString(16)}`;
    if (method === "eth_accounts") return [address];
    if (method === "wallet_requestPermissions") return [{ caveats: [{ value: [address] }] }];
    if (method === "wallet_revokePermissions") return null;
    throw new Error(`Unexpected wallet request: ${method}`);
  });
});

afterEach(() => {
  cleanup();
  client?.clear();
  window.localStorage.clear();
  wagmiConfig.setState((state) => ({
    ...state,
    connections: new Map(),
    current: null,
    status: "disconnected",
  }));
});

describe("RainbowKit wallet integration", () => {
  it("offers explicit wallet selection without a WalletConnect project ID", async () => {
    renderWallet();
    fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByRole("button", { name: /Phantom/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Rabby/ })).toBeTruthy();
    expect(provider.request).not.toHaveBeenCalled();
    expect(genericRequest).not.toHaveBeenCalled();
  });

  it("handles Phantom rejection and retries using Phantom's own provider", async () => {
    let rejectRequest!: (error: unknown) => void;
    provider.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return `0x${robinhoodTestnet.id.toString(16)}`;
      return new Promise((_resolve, reject) => {
        rejectRequest = reject;
      });
    });
    renderWallet();
    await selectPhantom();
    await screen.findByText(/opening/i);
    await act(async () => {
      rejectRequest({ code: 4001, message: "User rejected the request." });
    });
    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(genericRequest).not.toHaveBeenCalled();
    expect(wagmiConfig.state.status).toBe("disconnected");
    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        provider.request.mock.calls.filter(([args]) => args.method === "wallet_requestPermissions"),
      ).toHaveLength(2),
    );
  });

  it("lets the user close an unanswered connection prompt and reopen wallet selection", async () => {
    provider.request.mockImplementation(({ method }: { method: string }) =>
      method === "eth_chainId"
        ? Promise.resolve(`0x${robinhoodTestnet.id.toString(16)}`)
        : new Promise(() => {}),
    );
    renderWallet();
    await selectPhantom();
    await waitFor(() => expect(wagmiConfig.state.status).toBe("connecting"));
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() => expect(wagmiConfig.state.status).toBe("disconnected"));
    fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByRole("button", { name: /Phantom/ })).toBeTruthy();
  });

  it("connects on the configured chain and disconnects through the account menu", async () => {
    renderWallet();
    await selectPhantom();
    await waitFor(() => expect(wagmiConfig.state.status).toBe("connected"));
    expect(wagmiConfig.state.connections.get(wagmiConfig.state.current!)?.chainId).toBe(
      robinhoodTestnet.id,
    );
    fireEvent.click(await screen.findByRole("button", { name: /0x00/i }));
    fireEvent.click(await screen.findByRole("button", { name: /disconnect/i }));
    expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(wagmiConfig.state.status).toBe("disconnected");
  });

  it("switches an unsupported network through RainbowKit's chain menu", async () => {
    let chainId = "0x1";
    provider.request.mockImplementation(
      async ({ method, params }: { method: string; params?: { chainId: string }[] }) => {
        if (method === "eth_chainId") return chainId;
        if (method === "eth_accounts") return [address];
        if (method === "wallet_requestPermissions") return [{ caveats: [{ value: [address] }] }];
        if (method === "wallet_switchEthereumChain") {
          chainId = params![0]!.chainId;
          emit("chainChanged", chainId);
          return null;
        }
        throw new Error(`Unexpected wallet request: ${method}`);
      },
    );
    renderWallet();
    await act(async () => {
      await connect(wagmiConfig, { connector: phantom() });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Chain Selector" }));
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(robinhoodTestnet.name) }));
    await waitFor(() =>
      expect(wagmiConfig.state.connections.get(wagmiConfig.state.current!)?.chainId).toBe(
        robinhoodTestnet.id,
      ),
    );
  });
});
