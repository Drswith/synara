import { describe, expect, it } from "vitest";

import { isTranslatableText, splitJsxText } from "./policy";

describe("isTranslatableText", () => {
  it("keeps user-facing copy, including all-lowercase phrases", () => {
    for (const text of [
      "Save changes",
      "and welcome",
      "no results found",
      "Note:",
      "OK",
      "Read-only mode",
      "Top-level items",
      "Provider is offline. Retry?",
    ]) {
      expect(isTranslatableText(text), text).toBe(true);
    }
  });

  it("drops literals that address something instead of saying something", () => {
    for (const text of [
      "flex items-center gap-2",
      "text-muted-foreground hover:text-foreground",
      "px-2 py-1 rounded-lg",
      "settings-gear-4",
      "mailto:someone@example.com",
      "https://example.com/docs",
      "data:image/png",
      "sm:w-44",
      "1x",
      "—",
    ]) {
      expect(isTranslatableText(text), text).toBe(false);
    }
  });
});

describe("splitJsxText", () => {
  it("collapses JSX whitespace into the rendered text", () => {
    expect(
      splitJsxText("\n        A sentence that wraps\n        across two lines.\n      "),
    ).toEqual({ leading: "", core: "A sentence that wraps across two lines.", trailing: "" });
  });

  it("keeps significant edge spaces outside the key", () => {
    expect(splitJsxText("Hello, ")).toEqual({ leading: "", core: "Hello,", trailing: " " });
    expect(splitJsxText(" and welcome\n      ")).toEqual({
      leading: " ",
      core: "and welcome",
      trailing: "",
    });
  });

  it("ignores whitespace-only and non-copy nodes", () => {
    expect(splitJsxText("\n        ")).toBeNull();
    expect(splitJsxText(" · ")).toBeNull();
  });
});
