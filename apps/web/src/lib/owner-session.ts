import { useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { deployment } from "../config";
import { byoaApi, type PreviewSession } from "./byoa-api";
import { clearSession, loadSession, saveSession } from "./connect";

/**
 * The connected wallet's session (one signature, 12 hours), shared by the preview pages and the
 * owner's agent pages, so checks, Agent URLs and settings need no signature each time.
 */
export function useOwnerSession(path: "/previews/session" | "/self/session" = "/self/session") {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [session, setSession] = useState<PreviewSession | undefined>(() =>
    loadSession(deployment.chainId, address),
  );
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setSession(loadSession(deployment.chainId, address)), [address]);
  const signIn = async () => {
    if (!address) return;
    setSigningIn(true);
    setError(null);
    try {
      const s = await byoaApi.signIn(signMessageAsync, address, path);
      saveSession(deployment.chainId, s);
      setSession(s);
    } catch (e) {
      setError(e);
    } finally {
      setSigningIn(false);
    }
  };
  const forget = () => {
    if (address) clearSession(deployment.chainId, address);
    setSession(undefined);
  };
  return { session, signIn, signingIn, error, forget, sign: signMessageAsync };
}
