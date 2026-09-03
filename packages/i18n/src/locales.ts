// FILE: locales.ts
// Purpose: Declare the shipped locales and resolve which one a session should start in.
// Layer: i18n configuration
// Exports: LocaleId, LOCALES, DEFAULT_LOCALE, LOCALE_PREFERENCE_STORAGE_KEY, resolvers,
//          localeDisplayName.
//
// Adding a language means adding one entry here plus its catalogue loader in runtime.ts.
// Nothing else in the codebase enumerates languages.
//
// Ids are script-based BCP 47 tags (`zh-Hans`, not `zh-CN`). `zh-CN` is a legal tag, but it
// names a *country* and only implies Simplified by convention: CLDR expands it to
// `zh-Hans-CN`, and Simplified is equally the script of `zh-SG` and `zh-MY` while `zh-HK`
// and `zh-MO` are Traditional. Keying the catalogue on the script says what the file
// actually is, and leaves room for `zh-Hant-TW` and `zh-Hant-HK` as separate entries
// without either of them colliding with a region-named id.

export const DEFAULT_LOCALE = "en";

export type LocaleDescriptor = {
  readonly id: string;
  /**
   * Endonym, hand-authored rather than taken from CLDR: `Intl.DisplayNames` renders
   * `zh-Hant-HK` as "中文（繁體字，中國香港特別行政區）", which no picker should show.
   */
  readonly nativeLabel: string;
};

export const LOCALES = [
  { id: "en", nativeLabel: "English" },
  { id: "zh-Hans", nativeLabel: "简体中文" },
] as const satisfies readonly LocaleDescriptor[];

export type LocaleId = (typeof LOCALES)[number]["id"];

/** `"system"` follows the browser/OS language list instead of pinning one locale. */
export const SYSTEM_LOCALE_PREFERENCE = "system";

export type LocalePreference = typeof SYSTEM_LOCALE_PREFERENCE | LocaleId;

export const LOCALE_PREFERENCE_STORAGE_KEY = "synara:locale";

const LOCALE_IDS: ReadonlySet<string> = new Set(LOCALES.map((locale) => locale.id));

export function isLocaleId(value: unknown): value is LocaleId {
  return typeof value === "string" && LOCALE_IDS.has(value);
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === SYSTEM_LOCALE_PREFERENCE || isLocaleId(value);
}

type ResolvedTag = {
  readonly language: string;
  readonly script: string;
  readonly region: string;
};

/**
 * Expands a tag to its full language-script-region form via CLDR's likely-subtags data, so
 * `zh`, `zh-CN`, `zh-SG` and `zh-Hans-CN` all resolve to Simplified while `zh-TW`, `zh-HK`
 * and `zh-MO` resolve to Traditional. Comparing expanded tags is what removes the need for
 * a hand-maintained table of "which prefixes count as this language".
 */
function expand(tag: string): ResolvedTag | null {
  try {
    const maximized = new Intl.Locale(tag).maximize();
    return {
      language: maximized.language,
      script: maximized.script ?? "",
      region: maximized.region ?? "",
    };
  } catch {
    // Not a well-formed tag: platform language lists occasionally carry junk.
    return null;
  }
}

const EXPANDED_LOCALES: readonly (ResolvedTag & { readonly id: LocaleId })[] = LOCALES.flatMap(
  (locale) => {
    const expanded = expand(locale.id);
    return expanded ? [{ ...expanded, id: locale.id }] : [];
  },
);

/**
 * How well a shipped locale serves a requested one. Script equality is required: showing a
 * Traditional reader Simplified copy reads as a bug, so English is the honest fallback
 * until a Traditional catalogue exists. Region is only a tiebreaker, which is what lets
 * `en-GB` match `en` and `zh-SG` match `zh-Hans`.
 */
function score(request: ResolvedTag, candidate: ResolvedTag): number {
  if (request.language !== candidate.language) return 0;
  if (request.script !== candidate.script) return 0;
  return request.region === candidate.region ? 2 : 1;
}

/** Picks the best shipped locale for an ordered list of BCP 47 tags (`navigator.languages`). */
export function matchLocale(languages: readonly string[]): LocaleId {
  for (const language of languages) {
    const request = expand(language);
    if (!request) continue;
    let bestId: LocaleId | null = null;
    let bestScore = 0;
    for (const candidate of EXPANDED_LOCALES) {
      const candidateScore = score(request, candidate);
      if (candidateScore > bestScore) {
        bestScore = candidateScore;
        bestId = candidate.id;
      }
    }
    // Earlier entries in the list win outright: a second-choice language should never
    // override a worse-but-present match for the first.
    if (bestId !== null) return bestId;
  }
  return DEFAULT_LOCALE;
}

/**
 * Normalizes a stored preference. A tag that is no longer a shipped id is re-resolved
 * rather than discarded, so a preference saved under an older id (`zh-CN`) keeps selecting
 * the same language after the id changes.
 */
export function parseLocalePreference(value: unknown): LocalePreference {
  if (isLocalePreference(value)) return value;
  if (typeof value !== "string") return SYSTEM_LOCALE_PREFERENCE;
  const matched = matchLocale([value]);
  // `matchLocale` returns English both for "English" and for "nothing matched", so only
  // trust it here when the tag actually resolves to a locale we ship.
  return expand(value) !== null && matched !== DEFAULT_LOCALE ? matched : SYSTEM_LOCALE_PREFERENCE;
}

/** Resolves a stored preference plus the platform languages into the locale to load. */
export function resolveLocale(
  preference: LocalePreference,
  languages: readonly string[],
): LocaleId {
  return preference === SYSTEM_LOCALE_PREFERENCE ? matchLocale(languages) : preference;
}

/**
 * The CLDR name for a locale rendered in `inLocale` — "English" shown as "英语" to a reader
 * whose interface is Chinese. Used as the secondary line in the language picker so an entry
 * is findable both by its endonym and by its name in the language currently on screen.
 * Returns null when it would just repeat the endonym, or when ICU data is unavailable.
 */
export function localeDisplayName(id: string, inLocale: string): string | null {
  try {
    const name = new Intl.DisplayNames([inLocale], { type: "language" }).of(id);
    return name === undefined || name === id ? null : name;
  } catch {
    return null;
  }
}
