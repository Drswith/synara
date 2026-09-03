import { describe, expect, it } from "vitest";

import { similarity } from "./extract";

describe("similarity", () => {
  it("scores a rewording high enough to pair it with the string it replaced", () => {
    // The case this exists for: upstream edits copy, and the old translation should be
    // offered for review rather than reported as an unrelated loss.
    expect(similarity("Save changes", "Save the changes")).toBeGreaterThan(0.6);
    expect(similarity("Display language", "Display languages")).toBeGreaterThan(0.6);
  });

  it("scores unrelated copy below the pairing threshold", () => {
    expect(similarity("Save changes", "Delete automation")).toBeLessThan(0.6);
    expect(similarity("Theme", "Provider usage")).toBeLessThan(0.6);
  });

  it("is exact and symmetric, and handles empty input", () => {
    expect(similarity("Save changes", "Save changes")).toBe(1);
    expect(similarity("", "")).toBe(1);
    expect(similarity("Retry", "Retries")).toBe(similarity("Retries", "Retry"));
  });

  it("short-circuits on a length gap no threshold could clear", () => {
    expect(similarity("OK", "A much longer sentence entirely")).toBe(0);
  });
});
