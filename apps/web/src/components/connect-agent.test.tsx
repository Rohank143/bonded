import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ApiError, api, type RunnerRecord, type SelfAgentRecord } from "../lib/api";
import { byoaApi } from "../lib/byoa-api";
import { saveSession } from "../lib/connect";
import { deployment } from "../config";
import { ConnectAgent, NewAgentConnection } from "./connect-agent";

const OWNER = "0x0000000000000000000000000000000000000001";
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: "0x0000000000000000000000000000000000000001", isConnected: true }),
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
const passed = {
  id: "chk-1",
  status: "passed" as const,
  createdAt: new Date().toISOString(),
  connection: "runner" as const,
};
beforeEach(() => {
  // The panel's other reads, none of them under test here unless a test says so.
  vi.spyOn(byoaApi, "notifications").mockResolvedValue({
    webhook: null,
    email: null,
    emailAvailable: false,
  });
  vi.spyOn(byoaApi, "estimate").mockRejectedValue(new ApiError(409, "no passing check"));
  vi.spyOn(byoaApi, "ratingProgress").mockReturnValue(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
const signedIn = () =>
  saveSession(deployment.chainId, {
    session: "bonded_ss_owner",
    wallet: OWNER,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
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
    fireEvent.click(await screen.findByRole("button", { name: "Create a runner token" }));
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

  it("rates the agent once its runner is connected and checked, and follows the rating", async () => {
    vi.spyOn(api, "runner").mockResolvedValue(
      runnerRecord({ token: { id: "t", createdAt: "" }, runner: connected, lastCheck: passed }),
    );
    vi.mocked(byoaApi.estimate).mockResolvedValue({
      episodes: 56,
      perEpisode: { toolCalls: 9, seconds: 20, costUsd: 0.01 },
      total: { seconds: 1120, costUsd: 0.56 },
      basis: "connection check chk-1",
    });
    signedIn();
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
    // The estimate came first, from the check; and no verdict shows while it runs.
    expect(screen.getByText(/About 19 min for 56 episodes/)).toBeTruthy();
    expect(screen.getByText(/about \$0.56 in all/)).toBeTruthy();
    expect(screen.getByText(/Results appear when it finishes/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("7");
  });

  it("won't rate a connected agent until a connection check passes", async () => {
    vi.spyOn(api, "runner").mockResolvedValue(
      runnerRecord({ token: { id: "t", createdAt: "" }, runner: connected }),
    );
    show();
    expect(await screen.findByText("Pass a connection check first.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rate my agent" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Run the connection check" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("doesn't count a check that passed over 24 hours ago", async () => {
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    vi.spyOn(api, "runner").mockResolvedValue(
      runnerRecord({
        token: { id: "t", createdAt: "" },
        runner: connected,
        lastCheck: { ...passed, createdAt: old },
      }),
    );
    show();
    expect(await screen.findByText(/passed over 24 hours ago/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rate my agent" })).toHaveProperty("disabled", true);
  });

  it("connects by URL: verifies it, shows the secret once and where the code hash came from", async () => {
    const runner = vi.spyOn(api, "runner").mockResolvedValue(runnerRecord());
    const register = vi.spyOn(byoaApi, "registerAgentUrl").mockResolvedValue({
      url: "https://agent.example/bonded",
      verifiedAt: new Date().toISOString(),
      version: "v1.4.2",
      secret: "bonded_as_secret",
      codeHash: { value: `0x${"a".repeat(64)}`, source: "url-version", detail: "v1.4.2" },
    });
    show();
    fireEvent.click(await screen.findByRole("radio", { name: /It's online/ }));
    const field = screen.getByLabelText("Your agent's URL");
    fireEvent.change(field, { target: { value: "http://agent.example" } });
    expect(screen.getByText("It must start with https://.")).toBeTruthy();
    fireEvent.change(field, { target: { value: "https://agent.example/bonded" } });
    runner.mockResolvedValue(
      runnerRecord({
        connection: "url",
        agentUrl: {
          url: "https://agent.example/bonded",
          verifiedAt: new Date().toISOString(),
          version: "v1.4.2",
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Verify it" }));
    await waitFor(() =>
      expect(register).toHaveBeenCalledWith(
        { kind: "agent", agentId: "12" },
        expect.anything(),
        "https://agent.example/bonded",
      ),
    );
    expect(await screen.findByText("bonded_as_secret")).toBeTruthy();
    expect(screen.getByText(/won't be shown again/)).toBeTruthy();
    expect(screen.getAllByText(/reporting version v1.4.2/).length).toBeGreaterThan(0);
    expect(await screen.findByText("URL verified")).toBeTruthy();
  });

  it("says plainly why a URL failed to verify, and what to do", async () => {
    vi.spyOn(api, "runner").mockResolvedValue(runnerRecord({ connection: "url" }));
    vi.spyOn(byoaApi, "registerAgentUrl").mockRejectedValue(
      new ApiError(422, "Your URL answered 404"),
    );
    show();
    const field = await screen.findByLabelText("Your agent's URL");
    fireEvent.change(field, { target: { value: "https://agent.example/bonded" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify it" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Your URL answered 404/);
    expect(alert.textContent).toMatch(/answer the episode POST with a 2xx within 10 seconds/);
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
      expect(await screen.findByText(/The command needs a runner token/)).toBeTruthy();
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
      expect(await screen.findByRole("button", { name: "Create a runner token" })).toHaveProperty(
        "disabled",
        false,
      );
    });
  });

  describe("right after onboarding", () => {
    function mountNew(props: Parameters<typeof NewAgentConnection>[0]) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <MemoryRouter>
          <QueryClientProvider client={client}>
            <NewAgentConnection {...props} />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    }
    it("starts with the URL carried over from onboarding, then the check", async () => {
      vi.spyOn(api, "runner").mockResolvedValue(runnerRecord());
      mountNew({
        agentId: "21",
        mode: "tools",
        initialConnection: "url",
        initialUrl: "https://agent.example/bonded",
      });
      const field = (await screen.findByLabelText("Your agent's URL")) as HTMLInputElement;
      expect(field.value).toBe("https://agent.example/bonded");
      expect(screen.getByRole("heading", { name: "3. Check the connection" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Run the connection check" })).toHaveProperty(
        "disabled",
        true,
      );
      expect(screen.getByText("Verify its URL first.")).toBeTruthy();
    });
    it("says when its connection can't be read, with a retry", async () => {
      vi.spyOn(api, "runner").mockRejectedValue(new ApiError(503, "down"));
      mountNew({ agentId: "21", mode: "tools" });
      expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    });
  });

  it("offers one sign-in, and sends the session where the API takes it", async () => {
    vi.spyOn(api, "runner").mockResolvedValue(
      runnerRecord({ token: { id: "t", createdAt: "" }, runner: connected, lastCheck: passed }),
    );
    const signIn = vi.spyOn(byoaApi, "signIn").mockResolvedValue({
      session: "bonded_ss_owner",
      wallet: OWNER,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const start = vi.spyOn(byoaApi, "startCheck").mockResolvedValue({ checkId: "c2" });
    vi.spyOn(byoaApi, "checkEvents").mockReturnValue(() => {});
    show();
    expect(await screen.findByText(/Sign in above to see the time and cost estimate/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith(expect.any(Function), OWNER, "/self/session"),
    );
    await waitFor(() =>
      expect(byoaApi.estimate).toHaveBeenCalledWith(expect.anything(), "bonded_ss_owner"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Run the check again" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(
        { kind: "agent", agentId: "12" },
        expect.objectContaining({ session: "bonded_ss_owner" }),
      ),
    );
  });

  it("goes back to the runner from a URL by stopping the URL first", async () => {
    vi.spyOn(api, "runner").mockResolvedValue(
      runnerRecord({
        connection: "url",
        agentUrl: {
          url: "https://agent.example/bonded",
          verifiedAt: new Date().toISOString(),
          version: null,
        },
      }),
    );
    const revoke = vi.spyOn(byoaApi, "revokeAgentUrl").mockResolvedValue({ revoked: 1 });
    signedIn();
    show();
    fireEvent.click(await screen.findByRole("radio", { name: /It runs on my machine/ }));
    expect(screen.getByText("Stop using the URL first.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop using the URL" }));
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith(
        { kind: "agent", agentId: "12" },
        expect.objectContaining({ session: "bonded_ss_owner" }),
      ),
    );
  });

  it("keeps a URL saved before its agent had the secret, and verifies it once it does", async () => {
    vi.spyOn(api, "runner").mockResolvedValue(runnerRecord({ connection: "url" }));
    vi.spyOn(byoaApi, "registerAgentUrl").mockResolvedValue({
      url: "https://agent.example/bonded",
      verified: false,
      verifiedAt: null,
      version: null,
      secret: "bonded_as_first",
      codeHash: null,
      problem: "Your URL answered 401: check your agent secret",
    });
    const again = vi
      .spyOn(byoaApi, "reverifyAgentUrl")
      .mockResolvedValue({ verified: true, version: "v2", codeHash: null });
    signedIn();
    show();
    fireEvent.change(await screen.findByLabelText("Your agent's URL"), {
      target: { value: "https://agent.example/bonded" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify it" }));
    expect(await screen.findByText("Saved, not verified yet")).toBeTruthy();
    expect(screen.getByText("bonded_as_first")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Verify it now" }));
    await waitFor(() =>
      expect(again).toHaveBeenCalledWith(
        { kind: "agent", agentId: "12" },
        expect.objectContaining({ session: "bonded_ss_owner" }),
        "https://agent.example/bonded",
      ),
    );
    expect(await screen.findByText(/reporting version v2/)).toBeTruthy();
    // The secret stays on screen until the page moves on.
    expect(screen.getByText("bonded_as_first")).toBeTruthy();
  });
});
