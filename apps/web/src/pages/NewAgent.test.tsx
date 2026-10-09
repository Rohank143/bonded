import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { OfficialPrefill } from "../components/preview-report";
import { NewAgent } from "./NewAgent";

vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: "0x00000000000000000000000000000000000000a1",
    isConnected: true,
  }),
  useSignMessage: () => ({ signMessageAsync: async () => "0x5151" }),
  useWriteContract: () => ({ writeContractAsync: async () => "0x1" }),
}));
vi.mock("wagmi/actions", () => ({
  getPublicClient: () => undefined,
  readContract: async () => undefined,
  waitForTransactionReceipt: async () => ({ status: "success", logs: [] }),
}));
vi.mock("../wagmi", () => ({ wagmiConfig: {} }));

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
});

describe("Onboarding your own agent", () => {
  it("offers the two ways to connect, with the code hash optional under Advanced", () => {
    show();
    fireEvent.click(screen.getByRole("radio", { name: /My own agent/ }));
    expect(screen.getByRole("link", { name: "Test your agent first" }).getAttribute("href")).toBe(
      "/agents/test",
    );
    expect(screen.getByRole("radio", { name: /It's online \(paste its URL\)/ })).toHaveProperty(
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
    fireEvent.click(screen.getByRole("radio", { name: /It runs on my machine/ }));
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
    expect(screen.getByRole("radio", { name: /It runs on my machine/ })).toHaveProperty(
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
      codeHash: { value: `0x${"c".repeat(64)}`, source: "url-version", detail: "v1.4.2" },
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
