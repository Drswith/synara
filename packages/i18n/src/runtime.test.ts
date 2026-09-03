import { describe, expect, it } from "vitest";

import { localeDisplayName, matchLocale, parseLocalePreference, resolveLocale } from "./locales";
import { __setCatalogueForTesting, t } from "./runtime";

describe("t", () => {
  it("returns the English source when no catalogue is active", () => {
    __setCatalogueForTesting("en", null);
    expect(t("Save changes")).toBe("Save changes");
  });

  it("falls back to the source for strings the catalogue does not cover", () => {
    __setCatalogueForTesting("zh-Hans", { "Save changes": "保存更改" });
    expect(t("Save changes")).toBe("保存更改");
    // An upstream string added since the last extraction pass.
    expect(t("Brand new upstream label")).toBe("Brand new upstream label");
    __setCatalogueForTesting("en", null);
  });
});

describe("matchLocale", () => {
  it("routes every Simplified-script tag to the Simplified catalogue", () => {
    // Region-named, script-named, bare, and Simplified-outside-China tags all expand to
    // Hans, which is exactly why the catalogue is keyed on the script.
    for (const tag of ["zh-CN", "zh-Hans", "zh-Hans-CN", "zh", "zh-SG", "zh-MY"]) {
      expect(matchLocale([tag]), tag).toBe("zh-Hans");
    }
  });

  it("does not serve Simplified copy to a Traditional reader", () => {
    // Until a Hant catalogue ships, English is the honest answer: mismatched Chinese
    // script reads as a bug rather than as a fallback.
    for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW"]) {
      expect(matchLocale([tag]), tag).toBe("en");
    }
  });

  it("matches on language and script, with region as a tiebreaker only", () => {
    expect(matchLocale(["en-GB"])).toBe("en");
    expect(matchLocale(["en-AU", "zh-CN"])).toBe("en");
  });

  it("honours the order of the platform language list", () => {
    expect(matchLocale(["zh-CN", "en-US"])).toBe("zh-Hans");
    expect(matchLocale(["fr-FR", "zh-CN"])).toBe("zh-Hans");
  });

  it("falls back to English for unshipped and malformed tags", () => {
    expect(matchLocale(["fr-FR", "de"])).toBe("en");
    expect(matchLocale(["not a tag", "!!"])).toBe("en");
    expect(matchLocale([])).toBe("en");
  });
});

describe("parseLocalePreference", () => {
  it("keeps a shipped id and the system sentinel", () => {
    expect(parseLocalePreference("zh-Hans")).toBe("zh-Hans");
    expect(parseLocalePreference("en")).toBe("en");
    expect(parseLocalePreference("system")).toBe("system");
  });

  it("migrates a preference stored under an older id", () => {
    // Written before the catalogue moved from region-named to script-named ids.
    expect(parseLocalePreference("zh-CN")).toBe("zh-Hans");
  });

  it("treats unknown and non-string values as 'system'", () => {
    expect(parseLocalePreference("de-DE")).toBe("system");
    expect(parseLocalePreference("garbage value")).toBe("system");
    expect(parseLocalePreference(null)).toBe("system");
    expect(parseLocalePreference(42)).toBe("system");
  });
});

describe("resolveLocale", () => {
  it("pins an explicit preference and follows the platform otherwise", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("system", ["zh-CN"])).toBe("zh-Hans");
  });
});

describe("localeDisplayName", () => {
  it("names a locale in the language currently on screen", () => {
    expect(localeDisplayName("en", "zh-Hans")).toBe("英语");
    expect(localeDisplayName("zh-Hans", "en")).toBe("Simplified Chinese");
  });

  it("returns null rather than echoing the tag back", () => {
    expect(localeDisplayName("!!not a tag", "en")).toBeNull();
  });
});
