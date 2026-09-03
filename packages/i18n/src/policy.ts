// FILE: policy.ts
// Purpose: Single source of truth for which source strings are user-facing, and how a
//          source string is normalized into a catalogue key.
// Layer: i18n compile/extract policy
// Exports: attribute + property allowlists, ignore markers, JSX text splitting, key checks.
//
// The Babel transform (babelPlugin.ts) and the catalogue extractor (extract.ts) MUST agree
// exactly on this policy: the extractor produces the keys the transform will look up at
// runtime. Any divergence shows up as a permanently untranslated string, so both sides
// import from here instead of re-implementing the rules.

/**
 * JSX attributes whose string literal value is rendered to the user (or read aloud by a
 * screen reader). Deliberately explicit: an attribute that also carries ids, CSS classes,
 * or route values must never be added here.
 */
export const TRANSLATABLE_JSX_ATTRIBUTES: ReadonlySet<string> = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "ariaLabel",
  "cancelLabel",
  "confirmLabel",
  "description",
  "emptyLabel",
  "emptyMessage",
  "heading",
  "hint",
  "label",
  "placeholder",
  "subtitle",
  "title",
  "tooltip",
]);

/**
 * Object literal property names whose string literal value is a display label. Most of
 * Synara's copy lives in `as const` option tables (`{ value: "compact", label: "Compact" }`)
 * rather than in JSX, so this list carries the bulk of the catalogue.
 *
 * `value`, `id`, `key`, `name`, and `icon` are intentionally absent: they address things.
 */
export const TRANSLATABLE_OBJECT_PROPERTIES: ReadonlySet<string> = new Set([
  "cancelLabel",
  "confirmLabel",
  "description",
  "emptyLabel",
  "emptyMessage",
  "eyebrow",
  "heading",
  "hint",
  "label",
  "placeholder",
  "subtitle",
  "summary",
  "title",
  "tooltip",
]);

/**
 * True for a binding that holds display copy, by the same names that mark an object
 * property as copy: `searchPlaceholder`, `emptyTriggerLabel`, `addProjectLabel`. A prop
 * default lands in a `const` as often as in an object, and the name is the only signal
 * either position gives.
 */
const COPY_NAME_SUFFIXES: ReadonlySet<string> = new Set([
  ...[...TRANSLATABLE_OBJECT_PROPERTIES].flatMap((property) => [
    property.toLowerCase(),
    `${property.toLowerCase()}s`,
  ]),
  // Not a property name, but the one every section-header helper here ends with.
  "header",
  "headers",
]);

export function isCopyBindingName(name: string): boolean {
  const lowered = name.toLowerCase();
  for (const suffix of COPY_NAME_SUFFIXES) {
    if (lowered === suffix || lowered.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * A comment anywhere on the enclosing statement opts that statement out of extraction and
 * transformation. Use it for strings that look like copy but address something.
 */
export const IGNORE_MARKER = "i18n-ignore";

/** A comment on a file's first statement opts the whole file out. */
export const IGNORE_FILE_MARKER = "i18n-ignore-file";

/** Source files that never contain shippable UI copy. */
export const EXCLUDED_FILE_PATTERN =
  /(\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|\.browser\.[cm]?[jt]sx?|\.stories\.[cm]?[jt]sx?)$/;

/**
 * Files holding *content* rather than interface copy.
 *
 * `whatsNew/entries.ts` is the curated release history shown once after an update. It is
 * 841 of the catalogue's strings and ~70% of its characters, it is append-only, it grows by
 * a dozen marketing paragraphs every release, and nobody re-reads an old entry. Extracting
 * it buries the genuinely reusable interface copy under changelog prose and makes the
 * post-merge drift report unreadable. The surrounding chrome (`WhatsNewPopoutCard`,
 * `ChangelogAccordion`) is ordinary UI and stays in.
 *
 * Excluding by path rather than with an `i18n-ignore-file` comment keeps the upstream file
 * untouched, which is the whole point of this package.
 */
export const EXCLUDED_CONTENT_PATTERN = /[\\/]whatsNew[\\/]entries\.ts$/;

/** The single predicate both the transform and the extractor consult, so they cannot drift. */
export function isExcludedFile(filename: string): boolean {
  return EXCLUDED_FILE_PATTERN.test(filename) || EXCLUDED_CONTENT_PATTERN.test(filename);
}

/**
 * Source trees the transform rewrites. The extractor scans exactly these, so a file outside them
 * would get a catalogue lookup the catalogue never learns about — and, in a workspace package that
 * does not depend on this one, an `@synara/i18n/runtime` import that cannot resolve.
 */
export const DEFAULT_TRANSLATION_ROOTS: readonly string[] = ["apps/web/src"];

/** The other predicate both sides consult, for the same reason. */
export function isOutsideRoots(
  filename: string,
  roots: readonly string[] = DEFAULT_TRANSLATION_ROOTS,
): boolean {
  const normalized = filename.replace(/\\/g, "/");
  return !roots.some((root) => normalized.includes(`/${root.replace(/\\/g, "/")}/`));
}

/** Minimum length for a literal to be considered copy rather than a token. */
const MIN_TRANSLATABLE_LENGTH = 2;

const LETTER_PATTERN = /\p{L}/u;
const WORD_PATTERN = /\p{L}{2,}/u;

/** `mailto:`, `data:`, `vscode:` and friends — a scheme, not a sentence ending in a colon. */
const URI_SCHEME_PATTERN = /^(https?|mailto|tel|data|blob|file|ws|wss|vscode|cursor|zed):/i;

/** One Tailwind-style utility token: a lowercase stem plus a `-`, `:`, `/` or `[` modifier. */
const UTILITY_TOKEN_PATTERN = /^[a-z0-9]+[-:/[][a-z0-9./[\]%_-]*$/;

/** Share of utility-looking tokens above which a phrase reads as a class list, not copy. */
const UTILITY_TOKEN_RATIO = 2 / 3;

/**
 * Rejects the many string literals that address something rather than say something:
 * Tailwind class lists, CSS values, kebab/snake/dot identifiers, URIs, and lone glyphs.
 *
 * Tuned to under-reject rather than over-reject: a literal wrongly kept costs a translator
 * one confusing catalogue entry, while a literal wrongly dropped is copy that can never be
 * translated and gives no signal that it is missing.
 */
export function isTranslatableText(raw: string): boolean {
  const text = raw.trim();
  if (text.length < MIN_TRANSLATABLE_LENGTH) return false;
  // Needs at least one real word; "1x", "—", "%s" are not copy.
  if (!WORD_PATTERN.test(text)) return false;
  if (!LETTER_PATTERN.test(text)) return false;
  // Addresses and machine tokens.
  if (/^[a-z0-9]+([-_.:/][a-z0-9]+)+$/.test(text)) return false;
  if (URI_SCHEME_PATTERN.test(text) && !text.includes(" ")) return false;
  if (/^[.#$@~/\\]/.test(text)) return false;
  if (/^\{.*\}$/.test(text) || /^\[.*\]$/.test(text)) return false;
  // CSS/SVG function forms: url(#gradient), var(--fg), calc(100% - 1rem), translateX(2px).
  if (/^[a-z-]+\(.*\)$/.test(text)) return false;

  // Tailwind-ish utility soup. Counting utility tokens rather than requiring all of them to
  // look like utilities keeps all-lowercase English ("and welcome", "no results") in, while
  // still dropping "flex items-center gap-2".
  const tokens = text.split(/\s+/);
  if (tokens.length > 1) {
    const utilityTokens = tokens.filter((token) => UTILITY_TOKEN_PATTERN.test(token)).length;
    if (utilityTokens >= 2 && utilityTokens / tokens.length >= UTILITY_TOKEN_RATIO) return false;
  }
  return true;
}

export type JsxTextSplit = {
  /** Whitespace that must stay outside the translated span to preserve JSX spacing. */
  readonly leading: string;
  /** The catalogue key: the visible text with JSX whitespace collapsed. */
  readonly core: string;
  readonly trailing: string;
};

const JSX_TRIMMED_EDGE = /^[ \t]*[\r\n]\s*|\s*[\r\n][ \t]*$/;

/**
 * Splits a raw JSXText node the way React renders it.
 *
 * JSX drops whitespace runs that contain a newline at the edges of a text node and
 * collapses interior newline runs to a single space, so `"\n  Save changes\n"` renders as
 * `Save changes`. Edge whitespace WITHOUT a newline (`<b>Hello</b> world`) is significant
 * and is returned separately so the transform can re-emit it verbatim instead of baking a
 * stray space into the catalogue key.
 *
 * Returns `null` when the node holds no translatable copy.
 */
export function splitJsxText(raw: string): JsxTextSplit | null {
  if (!LETTER_PATTERN.test(raw)) return null;

  const startsSignificant = /^[ \t]+[^\s]/.test(raw);
  const endsSignificant = /[^\s][ \t]+$/.test(raw);

  const collapsed = raw.replace(JSX_TRIMMED_EDGE, "").replace(/\s*[\r\n]\s*/g, " ");
  const core = collapsed.trim();
  if (!isTranslatableText(core)) return null;

  return {
    leading: startsSignificant ? " " : "",
    core,
    trailing: endsSignificant ? " " : "",
  };
}
