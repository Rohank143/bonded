import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WalletHelp } from "./wallet-help";

const wallet = vi.hoisted(() => ({
  request: vi.fn(async (args: unknown) => (args ? null : null)),
  balance: undefined as bigint | undefined,
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: "0x00000000000000000000000000000000000000a1",
    isConnected: true,
    chainId: 1,
    connector: { getProvider: async () => ({ request: wallet.request }) },
  }),
  useBalance: () => ({
    data: wallet.balance === undefined ? undefined : { value: wallet.balance },
  }),
}));
afterEach(() => {
  cleanup();
  wallet.request.mockClear();
  wallet.balance = undefined;
});

describe("wallet help", () => {
  it("adds the network in one click", async () => {
    render(<WalletHelp gasNeeded={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /to my wallet/ }));
    await waitFor(() => expect(wallet.request).toHaveBeenCalled());
    const call = wallet.request.mock.calls[0]![0] as {
      method: string;
      params: { chainId: string }[];
    };
    expect(call.method).toBe("wallet_addEthereumChain");
    expect(call.params[0]!.chainId).toBe("0xb626");
    expect(await screen.findByText(/Your wallet is on/)).toBeTruthy();
  });

  it("says how much gas it needs, and warns when the wallet has less", () => {
    wallet.balance = 10n ** 14n;
    render(<WalletHelp gasNeeded={10n ** 15n} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "You need about 0.001 ETH for gas, but you have 0.0001 ETH. Get test ETH from a faucet first.",
    );
    expect(screen.getByRole("link", { name: "faucet.testnet.chain.robinhood.com" })).toBeTruthy();
  });

  it("gives no number it didn't measure", () => {
    render(<WalletHelp gasNeeded={undefined} />);
    expect(screen.getByText(/You need a little test ETH for gas/)).toBeTruthy();
  });
});
