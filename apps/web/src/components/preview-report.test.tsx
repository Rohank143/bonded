import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { finishedRun, preview } from "../test/byoa-fixtures";
import { PreviewReport } from "./preview-report";

afterEach(cleanup);

describe("preview score display", () => {
  it.each([undefined, 0, 30])("keeps security and insurance distinct (%s)", (grade) => {
    const run = finishedRun();
    if (grade !== undefined) {
      run.report!.susceptibility = {
        grade,
        worstClass: "A1",
        worstRate: 1 - grade / 100,
        overallRate: 1 - grade / 100,
        classes: [],
      };
    }
    render(
      <MemoryRouter>
        <PreviewReport preview={preview()} run={run} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Insurance score 72")).toBeTruthy();
    if (grade === undefined) {
      expect(screen.getByText("Security score unavailable")).toBeTruthy();
      expect(screen.queryByText("of 100")).toBeNull();
    } else {
      expect(screen.getByText("Security score")).toBeTruthy();
      expect(screen.getByText(String(grade))).toBeTruthy();
      expect(screen.queryByText("72")).toBeNull();
    }
  });
});

describe("preview task score", () => {
  const view = () =>
    render(
      <MemoryRouter>
        <PreviewReport preview={preview()} run={run} />
      </MemoryRouter>,
    );
  let run = finishedRun();

  it("shows the Task score from controls and attack episodes, as a preview has no twins", () => {
    run = finishedRun();
    run.report!.task = {
      version: 1,
      score: 92,
      worst: "underAttack",
      controls: { trials: 6, done: 6, graded: true },
      underAttack: { trials: 48, done: 44, graded: true },
      benign: { trials: 0, done: 0, graded: false },
    };
    view();
    expect(screen.getByText("92")).toBeTruthy();
    expect(
      screen.getByText(
        /Did its job in 6 of 6 control episodes and 44 of 48 unbreached attack episodes\./,
      ),
    ).toBeTruthy();
  });

  it("says when no part had enough episodes, and shows nothing for an older report", () => {
    run = finishedRun();
    run.report!.task = {
      version: 1,
      score: null,
      worst: null,
      controls: { trials: 2, done: 2, graded: false },
      underAttack: { trials: 0, done: 0, graded: false },
      benign: { trials: 0, done: 0, graded: false },
    };
    view();
    expect(screen.getByText("not measured")).toBeTruthy();
    cleanup();
    run = finishedRun();
    view();
    expect(screen.queryByText(/Task score/)).toBeNull();
  });
});
