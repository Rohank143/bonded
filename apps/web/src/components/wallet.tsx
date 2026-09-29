import { createContext, useContext, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useConnect, useDisconnect, useSwitchChain, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import type { Abi, Hex } from "viem";
import { robinhoodTestnet } from "../config";
import { short } from "../lib/format";
import { wagmiConfig } from "../wagmi";
import { Button, ErrorText, Input, TxLink } from "./ui";

export function ConnectButton() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  if (!isConnected)
    return (
      <div className="flex items-center gap-2">
        <Button
          disabled={isPending || !connectors[0]}
          onClick={() => connectors[0] && connect({ connector: connectors[0] })}
        >
          {isPending ? "Connecting…" : "Connect wallet"}
        </Button>
        <ErrorText error={error} />
      </div>
    );
  if (chainId !== robinhoodTestnet.id)
    return (
      <Button onClick={() => switchChain({ chainId: robinhoodTestnet.id })}>
        Switch to Robinhood testnet
      </Button>
    );
  return (
    <Button kind="secondary" onClick={() => disconnect()}>
      {short(address ?? "")}
    </Button>
  );
}

export interface Call {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  label: string;
}

/**
 * Send contract calls one after another from the connected wallet, waiting for each receipt,
 * then refresh every on-chain read on the page.
 */
export function useSend() {
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [hashes, setHashes] = useState<Hex[]>([]);
  const [busy, setBusy] = useState(false);
  async function send(calls: Call[]) {
    setBusy(true);
    setError(null);
    setHashes([]);
    try {
      for (const call of calls) {
        setStatus(`${call.label}: confirm in your wallet`);
        const hash = await writeContractAsync({
          address: call.address,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
          chainId: robinhoodTestnet.id,
        } as Parameters<typeof writeContractAsync>[0]);
        setHashes((h) => [...h, hash]);
        setStatus(`${call.label}: waiting for confirmation`);
        const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
        if (receipt.status !== "success") throw new Error(`${call.label} reverted`);
      }
      setStatus("Done");
      await queryClient.invalidateQueries();
      return true;
    } catch (e) {
      setError(e);
      setStatus(null);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const view = (
    <div className="flex flex-col gap-1 text-sm">
      {status && <span className="text-muted">{status}</span>}
      {hashes.length > 0 && (
        <span className="flex flex-wrap gap-2">
          {hashes.map((h) => (
            <TxLink key={h} hash={h} />
          ))}
        </span>
      )}
      <ErrorText error={error} />
    </div>
  );
  return { send, busy, view };
}

const TokenContext = createContext<{ token: string; setToken: (t: string) => void }>({
  token: "",
  setToken: () => {},
});

/** Holds the operator token in memory for this tab only; reloading the page forgets it. */
export function OperatorTokenProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState("");
  return <TokenContext.Provider value={{ token, setToken }}>{children}</TokenContext.Provider>;
}

export function useOperatorToken() {
  return useContext(TokenContext);
}

export function OperatorTokenField() {
  const { token, setToken } = useOperatorToken();
  return (
    <div className="flex flex-col gap-1">
      <Input
        label="Operator token (API_TOKEN)"
        type="password"
        value={token}
        onChange={setToken}
        placeholder="kept in memory only"
      />
      <span className="text-xs text-muted">
        Starting ratings and signing quotes are operator actions. The token stays in this tab and is
        never saved.
      </span>
    </div>
  );
}
