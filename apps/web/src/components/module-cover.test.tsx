import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { deployment } from "../config";
import { ModuleCover } from "./module-cover";

const state = vi.hoisted(() => ({ mode: 1, approved: false }));
const ACCOUNT = "0x00000000000000000000000000000000000000aa";
vi.mock("wagmi", async () => {
  const { deployment: d } = await import("../config");
  return {
    useAccount: () => ({ address: undefined }),
    useReadContracts: () => ({
      data: [
        { result: undefined },
        { result: 0n },
        { result: state.mode },
        { result: ACCOUNT },
        { result: [d.usdg, d.tsla] },
        { result: true },
      ],
    }),
    usePublicClient: () => ({
      readContract: async ({ address, functionName }: { address: string; functionName: string }) =>
        functionName === "allowance" && state.approved && address === d.amzn ? 10n : 0n,
    }),
  };
});
vi.mock("../pages/Vault", () => ({ BuyCover: () => <div>cover form</div> }));
afterEach(cleanup);

const module = "0x00000000000000000000000000000000000000bb" as const;
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<ModuleCover agentId={1n} module={module} />, { wrapper });
}

describe("ModuleCover", () => {
  it("offers cover on an Enforce-mode module, and says what it doesn't pay", () => {
    state.mode = 1;
    state.approved = false;
    show();
    expect(screen.getByText("cover form")).toBeTruthy();
    expect(screen.getByText(/blocked, so there is no loss to pay/)).toBeTruthy();
    expect(screen.getByText(/deferred breach\) is recorded but not paid/)).toBeTruthy();
    expect(screen.getByText(/needs a dispute the council approves/)).toBeTruthy();
  });

  it("refuses cover on a Monitor-mode module, saying why", () => {
    state.mode = 0;
    show();
    expect(screen.queryByText("cover form")).toBeNull();
    expect(screen.getByText(/runs in Monitor mode, so it can't hold cover/)).toBeTruthy();
  });

  it("warns about approvals of tokens outside the mandate to its targets", async () => {
    state.mode = 1;
    state.approved = true;
    show();
    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toBe(
      `These approvals let the agent's allowed contracts move tokens the mandate doesn't cover: tAMZN approved to ${deployment.router}. Revoke them or use a dedicated account.`,
    );
  });
});
