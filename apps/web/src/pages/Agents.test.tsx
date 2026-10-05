import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { Layout } from "../App";
import { Agents } from "./Agents";

const { readRegistry } = vi.hoisted(() => ({ readRegistry: vi.fn() }));
vi.mock("wagmi", () => ({ useReadContract: readRegistry }));
vi.mock("../components/wallet", () => ({ ConnectButton: () => null }));

const refetch = vi.fn();
const result = (data?: bigint) => ({
  data,
  isPending: data === undefined,
  isError: false,
  error: null,
  refetch,
});

function open(path = "/agents") {
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: "/", element: <h1>Home</h1> },
          { path: "/agents", element: <Agents /> },
          { path: "/agents/new", element: <h1>Onboard an agent</h1> },
          { path: "/agents/:id", element: <h1>Agent profile</h1> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return { router, view: render(<RouterProvider router={router} />) };
}

beforeEach(() => {
  vi.clearAllMocks();
  readRegistry.mockReturnValue(result(0n));
});
afterEach(cleanup);

describe("Agents navigation", () => {
  it("opens the directory from the global navigation without a wallet", async () => {
    open("/");
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("link", { name: "Agents" }));
    expect(await screen.findByRole("heading", { name: "Agents", level: 1 })).toBeTruthy();
  });

  it("opens onboarding from the directory and keeps Agents active on the subpage", async () => {
    open();
    fireEvent.click(screen.getByRole("link", { name: "Create agent" }));
    expect(await screen.findByRole("heading", { name: "Onboard an agent" })).toBeTruthy();
    expect(
      within(screen.getByRole("navigation"))
        .getByRole("link", { name: "Agents" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("lists unrated registered agents newest first and opens their profiles", async () => {
    readRegistry.mockReturnValue(result(3n));
    const { router } = open();
    expect(
      within(screen.getByRole("list"))
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual(["/agents/3", "/agents/2", "/agents/1"]);
    fireEvent.click(screen.getByRole("link", { name: "Agent 2 View agent →" }));
    expect(await screen.findByRole("heading", { name: "Agent profile" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/agents/2");
    expect(
      within(screen.getByRole("navigation"))
        .getByRole("link", { name: "Agents" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("offers creation while the registry loads without claiming it is empty", () => {
    readRegistry.mockReturnValue(result());
    open();
    expect(screen.getByText("Loading agents…")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create agent" })).toBeTruthy();
    expect(screen.queryByText(/No agents registered yet/)).toBeNull();
  });

  it("shows an empty state only after a successful registry read", () => {
    open();
    expect(screen.getByText(/No agents registered yet/)).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("link", { name: "Create agent" }).getAttribute("href")).toBe(
      "/agents/new",
    );
  });

  it("can retry a registry failure and still offers creation", () => {
    readRegistry.mockReturnValue({
      ...result(),
      isPending: false,
      isError: true,
      error: new Error("Registry unavailable"),
    });
    open();
    expect(screen.getByRole("alert").textContent).toBe("Registry unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Create agent" })).toBeTruthy();
    expect(screen.queryByText(/No agents registered yet/)).toBeNull();
  });

  it("bounds the list and reaches older agents without skipping IDs", () => {
    readRegistry.mockReturnValue(result(25n));
    open();
    const links = () => within(screen.getByRole("list")).getAllByRole("link");
    const newer = () => screen.getByRole("button", { name: "Newer agents" }) as HTMLButtonElement;
    const older = () => screen.getByRole("button", { name: "Older agents" }) as HTMLButtonElement;
    expect(links()).toHaveLength(12);
    expect(links()[0]!.getAttribute("href")).toBe("/agents/25");
    expect(links()[11]!.getAttribute("href")).toBe("/agents/14");
    expect(newer().disabled).toBe(true);
    fireEvent.click(older());
    expect(links()[0]!.getAttribute("href")).toBe("/agents/13");
    expect(links()[11]!.getAttribute("href")).toBe("/agents/2");
    fireEvent.click(older());
    expect(links()).toHaveLength(1);
    expect(links()[0]!.getAttribute("href")).toBe("/agents/1");
    expect(older().disabled).toBe(true);
    fireEvent.click(newer());
    expect(screen.getByText("Page 2 of 3")).toBeTruthy();
  });

  it("shows new registrations when the registry refreshes", () => {
    readRegistry.mockReturnValue(result(1n));
    const view = render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>,
    );
    readRegistry.mockReturnValue(result(2n));
    view.rerender(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Agent 2 View agent →" })).toBeTruthy();
  });

  it("preserves full on-chain ID precision while rendering a bounded page", () => {
    readRegistry.mockReturnValue(result(9_007_199_254_741_000n));
    open();
    const links = within(screen.getByRole("list")).getAllByRole("link");
    expect(links).toHaveLength(12);
    expect(links[0]!.getAttribute("href")).toBe("/agents/9007199254741000");
    expect(links[1]!.getAttribute("href")).toBe("/agents/9007199254740999");
  });
});
