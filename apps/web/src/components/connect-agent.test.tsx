import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { api, type RunnerRecord, type SelfAgentRecord } from "../lib/api";
import { ConnectAgent } from "./connect-agent";

vi.mock("wagmi", () => ({
  useSignMessage: () => ({ signMessageAsync: async () => "0x5151" }),
}));

const record: Extract<SelfAgentRecord, { registered: true }> = {
  registered: true,
  source: "user",
  kind: "remote",
  owner: "0x0000000000000000000000000000000000000001",
  lastRatingAt: null,
  nextRatingAt: null,
  codeHash: `0x${"c".repeat(64)}`,
  mode: "tools",
  tee: null,
  coverCaps: { declared: 5_000, tee: 20_000 },
};
const runnerRecord = (over: Partial<RunnerRecord> = {}): RunnerRecord => ({
  token: null,
  runner: null,
  lastSkip: null,
  gatewayUrl: "https://gw.example",
  ...over,
});
const connected = {
  connected: true,
  connectedAt: "2026-10-07T00:00:00Z",
  lastHeartbeatAt: "2026-10-07T00:00:00Z",
  disconnectedAt: null,
  runnerVersion: "0.1.0",
  mode: "tools",
  teeUrl: null,
};

function show(props: Partial<Parameters<typeof ConnectAgent>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ConnectAgent agentId="12" record={record} scoreExpired={false} {...props} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConnectAgent", () => {
  it("makes a token by signing and shows the commands with it, once", async () => {
    const runner = vi.spyOn(api, "runner").mockResolvedValue(runnerRecord());
    const create = vi.spyOn(api, "createRunnerToken").mockResolvedValue({
      token: "bonded_rt_secret",
      tokenId: "t",
      createdAt: "2026-10-07T00:00:00Z",
      gatewayUrl: "https://gw.example",
    });
    show();
    expect(await screen.findByText("Runner no token")).toBeTruthy();
    // No runner yet: rating waits for one.
    expect(screen.getByRole("button", { name: "Rate my agent" })).toHaveProperty("disabled", true);
    runner.mockResolvedValue(
      runnerRecord({ token: { id: "t", createdAt: "2026-10-07T00:00:00Z" } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create a runner token" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("12", expect.anything()));
    expect(
      await screen.findByText(
        "BONDED_RUNNER_TOKEN=bonded_rt_secret npx @bonded/runner --gateway https://gw.example -- <your agent command>",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/docker run --rm -e BONDED_RUNNER_TOKEN=bonded_rt_secret/),
    ).toBeTruthy();
    expect(await screen.findByText("Runner waiting")).toBeTruthy();
    expect(screen.getByText(/capped|Cover limit/)).toBeTruthy();
  });

  it("rates the agent once its runner is connected, and follows the rating", async () => {
    vi.spyOn(api, "runner").mockResolvedValue(
      runnerRecord({ token: { id: "t", createdAt: "" }, runner: connected }),
    );
    const rate = vi.spyOn(api, "rateSelfAgent").mockResolvedValue({ runId: "run-1" });
    vi.spyOn(api, "run").mockResolvedValue({
      id: "run-1",
      status: "running",
      error: null,
      created_at: "",
      report: null,
      progress: { done: 7, total: 20, etaSeconds: 300 },
    });
    show();
    expect(await screen.findByText("Runner connected")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Rate my agent" });
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await waitFor(() => expect(rate).toHaveBeenCalled());
    expect(await screen.findByText(/7 of 20 episodes, about 5 min left/)).toBeTruthy();
  });

  it("says why an expired score lapsed when the runner is away", async () => {
    vi.spyOn(api, "runner").mockResolvedValue(
      runnerRecord({
        token: { id: "t", createdAt: "" },
        runner: { ...connected, connected: false },
        attempts: [
          {
            runId: "r9",
            status: "failed",
            error: "stopped: the agent failed in episode 1 of 4",
            createdAt: "2026-10-07T00:00:00Z",
            score: null,
          },
        ],
        lastSkip: {
          cause: "bounty",
          reason: "bounty 5 was accepted while the agent's runner was offline",
          at: "2026-10-07T00:00:00Z",
        },
      }),
    );
    show({ scoreExpired: true });
    expect(await screen.findByText(/bounty 5 was accepted/)).toBeTruthy();
    expect(screen.getByText(/runner wasn't connected to renew it/)).toBeTruthy();
    expect(screen.getByText("stopped: the agent failed in episode 1 of 4")).toBeTruthy();
  });
  it("shows anyone the runner's state, read-only, without a wallet", async () => {
    vi.spyOn(api, "runner").mockResolvedValue(
      runnerRecord({ token: { id: "t", createdAt: "" }, runner: connected }),
    );
    show({ readOnly: true });
    expect(await screen.findByText("Runner connected")).toBeTruthy();
    expect(screen.getByText("Its runner")).toBeTruthy();
    expect(screen.getByText(/Only the agent's owner can make a runner token/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create a runner token" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rate my agent" })).toBeNull();
  });
});
