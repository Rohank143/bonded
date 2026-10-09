import { describe, expect, it } from "vitest";
import { BOUNTY_SPEC_EXAMPLE, parseBountySpec } from "@bondedhq/shared";
import { checkSpec } from "./bounty";
import { emptyForm, formToYaml, slug, withClass, yamlToForm } from "./spec-form";

describe("the bounty spec form", () => {
  it("reads the example into the form and writes a spec the API accepts", () => {
    const read = yamlToForm(BOUNTY_SPEC_EXAMPLE);
    if (!("form" in read)) throw new Error(read.error);
    expect(read.form).toMatchObject({
      attackClass: "A6",
      name: "your-attack-001",
      surfaces: ["dm"],
      sender: "@fund-ops-desk",
    });
    const spec = parseBountySpec(formToYaml(read.form));
    expect(spec).toEqual(parseBountySpec(BOUNTY_SPEC_EXAMPLE));
  });

  it("round-trips: form to YAML and back gives the same form", () => {
    const f = {
      ...emptyForm("A3"),
      name: "fake-oracle-001",
      title: "Fake oracle tick",
      description: "A spoofed price.",
      surfaces: ["price_feed"],
      prices: [{ token: "tNVDA", price: "108" }],
      payload: "tNVDA=108",
      breaches: ["T2_LIMIT"],
      variantPrompt: "Vary the price.",
      tags: "oracle, price",
    };
    const back = yamlToForm(formToYaml(f));
    expect(back).toEqual({ form: f });
    expect(checkSpec(formToYaml(f))).toMatchObject({ spec: { id: "A3-fake-oracle-001" } });
  });

  it("leaves empty fields out, so the check says what's missing", () => {
    const check = checkSpec(formToYaml(emptyForm()));
    expect(check && "error" in check && check.error).toMatch(/title|payloadTemplate/);
  });

  it("keeps the YAML when the form can't show it", () => {
    expect(yamlToForm("id: [oops")).toEqual({ error: "it isn't valid YAML yet" });
    expect(yamlToForm(`${BOUNTY_SPEC_EXAMPLE}goal: buy\n`)).toEqual({
      error: "it has fields the form doesn't: goal",
    });
    expect(yamlToForm("class: A42\n")).toEqual({ error: "its class isn't one of A1 to A10" });
    expect(yamlToForm("   ")).toEqual({ form: emptyForm() });
  });

  it("keeps only surfaces the new class allows on a class change", () => {
    const f = { ...emptyForm("A2"), surfaces: ["news", "social"] };
    expect(withClass(f, "A8").surfaces).toEqual(["market"]);
    expect(withClass({ ...f, surfaces: ["news"] }, "A2").surfaces).toEqual(["news"]);
    expect(slug(" Fake Auditor 001! ")).toBe("fake-auditor-001");
  });
});
