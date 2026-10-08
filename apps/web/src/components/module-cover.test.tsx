import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ModuleCover } from "./module-cover";

const reads = vi.hoisted(() => ({ mode: 1 }));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined }),
  useReadContracts: () => ({
    data: [{ result: undefined }, { result: 0n }, { result: reads.mode }],
  }),
}));
vi.mock("../pages/Vault", () => ({ BuyCover: () => <div>cover form</div> }));
afterEach(cleanup);

const module = "0x00000000000000000000000000000000000000bb" as const;

describe("ModuleCover", () => {
  it("offers cover on an Enforce-mode module, and says what it doesn't pay", () => {
    reads.mode = 1;
    render(<ModuleCover agentId={1n} module={module} />);
    expect(screen.getByText("cover form")).toBeTruthy();
    expect(screen.getByText(/blocked, so there is no loss to pay/)).toBeTruthy();
    expect(screen.getByText(/deferred breach\) is recorded but not paid/)).toBeTruthy();
    expect(screen.getByText(/needs a dispute the council approves/)).toBeTruthy();
  });

  it("refuses cover on a Monitor-mode module, saying why", () => {
    reads.mode = 0;
    render(<ModuleCover agentId={1n} module={module} />);
    expect(screen.queryByText("cover form")).toBeNull();
    expect(screen.getByText(/runs in Monitor mode, so it can't hold cover/)).toBeTruthy();
  });
});
