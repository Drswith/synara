// FILE: runtime.ts
// Purpose: Look up translated copy by its English source text, and own the active locale.
// Layer: i18n browser runtime
// Exports: t, getActiveLocale, getLocalePreference, setLocalePreference, initLocale, hasCatalogue.
//
// Every call site is generated: the Babel transform in babelPlugin.ts rewrites user-facing
// string literals into `t("<English source>")`. Keys ARE the English source text, so an
// upstream string that has no translation yet renders in English instead of leaking a key.
//
// Performance: `t` is one Map lookup on a module-level dictionary, and short-circuits to
// identity for English (the source language ships no catalogue). The catalogue is fetched
// as its own chunk and only for non-English locales, so an English session pays nothing
// beyond the identity call.

import {
  DEFAULT_LOCALE,
  LOCALE_PREFERENCE_STORAGE_KEY,
  parseLocalePreference,
  resolveLocale,
  type LocaleId,
  type LocalePreference,
} from "./locales";

type Catalogue = ReadonlyMap<string, string>;

/**
 * Catalogue loaders, one dynamic import per locale so the bundler emits a separate chunk
 * and a session downloads only the language it uses. English is absent on purpose.
 */
const CATALOGUE_LOADERS: Readonly<Record<string, () => Promise<{ default: unknown }>>> = {
  "zh-Hans": () => import("../locales/zh-Hans.json"),
};

let activeLocale: LocaleId = DEFAULT_LOCALE;
let catalogue: Catalogue | null = null;

/**
 * Translates one English source string.
 *
 * Falls back to the input for anything the active catalogue does not cover, which is what
 * makes this safe to apply to strings that arrive at runtime (server error text, provider
 * status copy) as well as to compile-time literals.
 */
export function t(source: string): string {
  if (catalogue === null) return source;
  return catalogue.get(source) ?? source;
}

export function getActiveLocale(): LocaleId {
  return activeLocale;
}

export function hasCatalogue(): boolean {
  return catalogue !== null;
}

function readStoredPreference(): LocalePreference {
  try {
    return parseLocalePreference(localStorage.getItem(LOCALE_PREFERENCE_STORAGE_KEY));
  } catch {
    // Private-mode / disabled storage: follow the platform languages instead of failing.
    return "system";
  }
}

export function getLocalePreference(): LocalePreference {
  return readStoredPreference();
}

function platformLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages ?? (navigator.language ? [navigator.language] : []);
}

async function loadCatalogue(locale: LocaleId): Promise<Catalogue | null> {
  const load = CATALOGUE_LOADERS[locale];
  if (!load) return null;
  try {
    const module = await load();
    const entries = module.default;
    if (typeof entries !== "object" || entries === null) return null;
    // Empty values mark "known string, not translated yet" in the catalogue files; dropping
    // them here is what makes `t` fall through to the English source instead of rendering
    // an empty label.
    const translated = new Map<string, string>();
    for (const [source, value] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) translated.set(source, value);
    }
    return translated;
  } catch (error) {
    // A missing or corrupt catalogue must never block startup — English is always correct.
    console.warn(`[i18n] failed to load the ${locale} catalogue; staying in English.`, error);
    return null;
  }
}

/**
 * Resolves the stored preference and loads its catalogue. Call once, and await it before
 * the first render so no English frame is painted before the translated one.
 */
export async function initLocale(): Promise<LocaleId> {
  const locale = resolveLocale(readStoredPreference(), platformLanguages());
  activeLocale = locale;
  catalogue = locale === DEFAULT_LOCALE ? null : await loadCatalogue(locale);
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
  return locale;
}

/**
 * Persists a language choice and reloads.
 *
 * A reload rather than a re-render is deliberate: translated literals are read during
 * render and are memoized by the React Compiler and by `useMemo` caches that a locale
 * change does not invalidate, so a live swap would leave stale copy on screen. Reloading
 * is the same contract desktop editors use for display language, and language changes are
 * rare enough that predictability beats smoothness here.
 */
export function setLocalePreference(preference: LocalePreference): void {
  try {
    localStorage.setItem(LOCALE_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // Nothing to persist to; the reload below would drop the choice, so skip it.
    return;
  }
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

/** Test seam: installs a catalogue without touching storage or the network. */
export function __setCatalogueForTesting(
  locale: LocaleId,
  entries: Readonly<Record<string, string>> | null,
): void {
  activeLocale = locale;
  catalogue = entries === null ? null : new Map(Object.entries(entries));
}
