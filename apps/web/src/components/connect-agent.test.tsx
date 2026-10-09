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
        "BONDED_RUNNER_TOKEN=bonded_rt_secret npx @bondedhq/runner --gateway https://gw.example -- <your agent command>",
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
  it("holds rating back after a stop the agent caused, and labels the runner's words", async () => {
    vi.spyOn(api, "runner").mockResolvedValue(
      runnerRecord({
        token: { id: "t", createdAt: "" },
        runner: connected,
        attempts: [
          {
            runId: "r1",
            status: "failed",
            error: "stopped: the agent failed in episode 3 of 160",
            agentCaused: true,
            agentReport: "Error: model quota exceeded",
            createdAt: "2026-10-07T00:00:00Z",
            score: null,
          },
        ],
      }),
    );
    show({
      record: {
        ...record,
        expectedRating: { maxEpisodes: 160, budgetSeconds: 6400 },
        standing: {
          failuresInRow: 2,
          superseded: {
            since: "2026-10-07T00:00:00Z",
            reason: "stopped: the agent failed in episode 3 of 160",
          },
          cooldownUntil: new Date(Date.now() + 2 * 3_600_000).toISOString(),
        },
      },
    });
    expect(await screen.findByText(/Reported by the runner:/)).toBeTruthy();
    expect(screen.getByText("Error: model quota exceeded")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/Its score is superseded/);
    expect(screen.getByText(/up to 160 episodes .*It may take up to 107 minutes/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rate my agent" })).toHaveProperty("disabled", true);
  });

  it("asks a new owner to register again before rating", async () => {
    vi.spyOn(api, "runner").mockResolvedValue(
      runnerRecord({ token: { id: "t", createdAt: "" }, runner: connected }),
    );
    show({ registryOwner: "0x00000000000000000000000000000000000000ff" });
    expect(await screen.findByText(/Re-register it to rate under your own config/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rate my agent" })).toHaveProperty("disabled", true);
  });

  describe("moving to another agent's page", () => {
    const tokenFor = (n: number) => ({
      token: `bonded_rt_secret_${n}`,
      tokenId: "t",
      createdAt: "2026-10-07T00:00:00Z",
      gatewayUrl: "https://gw.example",
    });
    // The same component instance reused for another agent (no key): its own state is scoped.
    function mount(agentId: string) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const view = (id: string) => (
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <ConnectAgent agentId={id} record={record} scoreExpired={false} />
          </QueryClientProvider>
        </MemoryRouter>
      );
      const { rerender } = render(view(agentId));
      return (id: string) => rerender(view(id));
    }

    it("doesn't show agent 12's token on agent 13", async () => {
      vi.spyOn(api, "runner").mockResolvedValue(runnerRecord());
      vi.spyOn(api, "createRunnerToken").mockResolvedValue(tokenFor(12));
      const show13 = mount("12");
      fireEvent.click(await screen.findByRole("button", { name: "Create a runner token" }));
      expect(await screen.findByText(/BONDED_RUNNER_TOKEN=bonded_rt_secret_12 npx/)).toBeTruthy();
      show13("13");
      await waitFor(() => expect(screen.queryByText(/bonded_rt_secret_12/)).toBeNull());
      expect(screen.getByText(/Create a token to get the command/)).toBeTruthy();
    });

    it("ignores agent 12's token when it arrives after the page moved to agent 13", async () => {
      vi.spyOn(api, "runner").mockResolvedValue(runnerRecord());
      let resolve!: (value: ReturnType<typeof tokenFor>) => void;
      const create = vi
        .spyOn(api, "createRunnerToken")
        .mockReturnValue(new Promise((r) => (resolve = r)));
      const show13 = mount("12");
      fireEvent.click(await screen.findByRole("button", { name: "Create a runner token" }));
      await waitFor(() => expect(create).toHaveBeenCalledWith("12", expect.anything()));
      show13("13");
      resolve(tokenFor(12));
      // Give the late result time to land, then check it didn't.
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText(/bonded_rt_secret_12/)).toBeNull();
      expect(screen.getByRole("button", { name: "Create a runner token" })).toHaveProperty(
        "disabled",
        false,
      );
    });
  });
});
