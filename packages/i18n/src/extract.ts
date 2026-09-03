// FILE: extract.ts
// Purpose: Build the translation catalogue by running the real Babel transform over the
//          app sources, then sync and audit the per-locale catalogue files.
// Layer: i18n tooling (CLI)
// Exports: none - run with `bun run i18n:extract`.
//
// Extraction reuses babelPlugin.ts rather than re-implementing its rules, so a key in the
// catalogue is by construction the key the compiled bundle will look up. The audit pass
// additionally reports copy the transform CANNOT reach (template literals and concatenated
// strings in JSX), which is the list of places that need a manual `t(...)` if they matter.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync, types as BabelTypes, type NodePath, type PluginObject } from "@babel/core";

import synaraI18nBabelPlugin from "./babelPlugin";
import { DEFAULT_LOCALE, LOCALES } from "./locales";
import { DEFAULT_TRANSLATION_ROOTS, isExcludedFile, isTranslatableText } from "./policy.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const LOCALES_DIR = path.join(PACKAGE_ROOT, "locales");
const CATALOGUE_PATH = path.join(LOCALES_DIR, "_catalogue.json");
const UNCOVERED_PATH = path.join(LOCALES_DIR, "_uncovered.json");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  ".turbo",
  "__mocks__",
]);

type Cli = {
  readonly roots: readonly string[];
  readonly sync: boolean;
  readonly check: boolean;
};

function parseCli(argv: readonly string[]): Cli {
  const roots: string[] = [];
  let sync = false;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sync") sync = true;
    else if (arg === "--check") check = true;
    else if (arg === "--root") {
      const value = argv[index + 1];
      if (value) {
        roots.push(value);
        index += 1;
      }
    }
  }
  return { roots: roots.length > 0 ? roots : [...DEFAULT_TRANSLATION_ROOTS], sync, check };
}

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (isExcludedFile(entryPath)) continue;
      files.push(entryPath);
    }
  };
  walk(root);
  return files.toSorted();
}

type Uncovered = {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
};

/**
 * Flags user-facing copy the transform cannot key on: interpolated template literals and
 * `+` concatenation inside JSX. These stay English until someone restructures them, so the
 * list is the honest coverage gap rather than a silent one.
 */
function auditPlugin(uncovered: Uncovered[], relativeFile: string): PluginObject {
  const record = (nodePath: NodePath, snippet: string) => {
    const line = nodePath.node.loc?.start.line ?? 0;
    uncovered.push({ file: relativeFile, line, snippet: snippet.slice(0, 120) });
  };
  return {
    name: "synara-i18n-audit",
    visitor: {
      TemplateLiteral(nodePath) {
        if (nodePath.node.expressions.length === 0) return;
        if (!nodePath.findParent((parent) => parent.isJSXElement() || parent.isJSXFragment())) {
          return;
        }
        const text = nodePath.node.quasis.map((quasi) => quasi.value.cooked ?? "").join("{}");
        if (!isTranslatableText(text)) return;
        record(nodePath, text);
      },
      BinaryExpression(nodePath) {
        if (nodePath.node.operator !== "+") return;
        if (!BabelTypes.isStringLiteral(nodePath.node.left)) return;
        if (!isTranslatableText(nodePath.node.left.value)) return;
        if (!nodePath.findParent((parent) => parent.isJSXElement() || parent.isJSXFragment())) {
          return;
        }
        record(nodePath, `${nodePath.node.left.value} + ...`);
      },
    },
  };
}

function collect(files: readonly string[]): {
  /** Each extracted string mapped to the source files it appears in. */
  sources: Map<string, Set<string>>;
  uncovered: Uncovered[];
  failures: string[];
} {
  const sources = new Map<string, Set<string>>();
  const uncovered: Uncovered[] = [];
  const failures: string[] = [];

  for (const file of files) {
    const relativeFile = path.relative(REPO_ROOT, file);
    const code = readFileSync(file, "utf8");
    try {
      transformSync(code, {
        filename: file,
        configFile: false,
        babelrc: false,
        code: false,
        ast: false,
        // `jsx` must stay off for .ts: `const f = <T>(x: T) => x` parses as a JSX element
        // when both plugins are on.
        parserOpts: {
          plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
        },
        plugins: [
          [
            synaraI18nBabelPlugin,
            {
              onString: (source: string) => {
                const seenIn = sources.get(source);
                if (seenIn) seenIn.add(relativeFile);
                else sources.set(source, new Set([relativeFile]));
              },
            },
          ],
          () => auditPlugin(uncovered, relativeFile),
        ],
      });
    } catch (error) {
      failures.push(`${relativeFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { sources, uncovered, failures };
}

function readJsonRecord(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") record[key] = value;
    }
    return record;
  } catch {
    return {};
  }
}

/** Reads the catalogue's `string -> source files` map, tolerating an absent or older file. */
function readJsonRecordOfLists(file: string): Record<string, readonly string[]> {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record: Record<string, readonly string[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      record[key] = Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
    }
    return record;
  } catch {
    return {};
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Both arrays are sorted, so equality is element-wise. */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Levenshtein similarity in 0..1, used only to suggest that a new string is a reworded
 * version of one that just left the catalogue. This is `msgmerge`'s fuzzy matching, minus
 * the auto-apply: a reworded string usually needs a reworded translation, so the old value
 * is printed for a human to judge rather than silently reused.
 */
export function similarity(left: string, right: string): number {
  if (left === right) return 1;
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 1;
  // A large length gap cannot clear any useful threshold, so skip the O(n*m) fill.
  if (Math.abs(left.length - right.length) / longest > 1 - FUZZY_THRESHOLD) return 0;

  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1);
    }
    previous = current;
  }
  return 1 - (previous[right.length] ?? longest) / longest;
}

/** Below this, two strings are different copy rather than a rewording of the same copy. */
const FUZZY_THRESHOLD = 0.6;

/** Caps the O(added x removed) sweep so a huge upstream merge cannot stall the CLI. */
const FUZZY_PAIR_BUDGET = 200_000;

function sortedRecord(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).toSorted()) sorted[key] = record[key] ?? "";
  return sorted;
}

/**
 * Pairs each newly extracted string with the departed string it most resembles, so a
 * reworded sentence reads as "this replaced that" instead of as an unrelated loss plus an
 * unrelated addition. Reporting only: see `similarity`.
 */
function reportRewordings(added: readonly string[], removed: readonly string[]): void {
  if (added.length === 0 || removed.length === 0) return;
  if (added.length * removed.length > FUZZY_PAIR_BUDGET) {
    console.info("[i18n]   (too many changes to look for rewordings)");
    return;
  }
  const pairs: { added: string; removed: string; score: number }[] = [];
  for (const candidate of added) {
    let best: { removed: string; score: number } | null = null;
    for (const gone of removed) {
      const score = similarity(candidate, gone);
      if (score >= FUZZY_THRESHOLD && (best === null || score > best.score)) {
        best = { removed: gone, score };
      }
    }
    if (best) pairs.push({ added: candidate, removed: best.removed, score: best.score });
  }
  if (pairs.length === 0) return;
  console.info(`[i18n]   ${pairs.length} of the new strings look like rewordings:`);
  for (const pair of pairs.slice(0, 10)) {
    console.info(`[i18n]     was: ${JSON.stringify(pair.removed.slice(0, 60))}`);
    console.info(`[i18n]     now: ${JSON.stringify(pair.added.slice(0, 60))}`);
  }
  if (pairs.length > 10) console.info(`[i18n]     ...and ${pairs.length - 10} more`);
  console.info("[i18n]   their old translations are parked in <locale>.retired.json");
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const files = cli.roots.flatMap((root) => listSourceFiles(path.resolve(REPO_ROOT, root)));
  const { sources, uncovered, failures } = collect(files);
  const catalogue = [...sources.keys()].toSorted();

  console.info(`[i18n] scanned ${files.length} files in ${cli.roots.join(", ")}`);
  console.info(`[i18n] catalogue: ${catalogue.length} strings`);
  if (failures.length > 0) {
    console.warn(`[i18n] ${failures.length} file(s) failed to parse:`);
    for (const failure of failures.slice(0, 10)) console.warn(`  ${failure}`);
  }

  // The committed catalogue records provenance, not positions: each string maps to the
  // files it came from, never to a line or an offset. Line-anchored records are what a
  // patch series carries, and they are exactly what breaks when upstream edits *near* the
  // string rather than the string itself. File paths survive that, and they are what makes
  // a departure diagnosable ("this file stopped yielding copy") rather than merely visible.
  const previousSources = readJsonRecordOfLists(CATALOGUE_PATH);
  const previousCatalogue = Object.keys(previousSources).toSorted();
  let stale = !sameStrings(previousCatalogue, catalogue);

  // A string that stops being extracted is the one failure mode a source scan has and a
  // hand-written `t(...)` call does not: upstream moves copy into a shape the policy does
  // not cover, and coverage drops with nothing failing. Naming the departures, and the file
  // each came from, makes that loud rather than silent - read it after every upstream merge.
  const current = new Set(catalogue);
  const previous = new Set(previousCatalogue);
  const added = catalogue.filter((source) => !previous.has(source));
  const removed = previousCatalogue.filter((source) => !current.has(source));

  if (previousCatalogue.length > 0 && (added.length > 0 || removed.length > 0)) {
    console.info(
      `[i18n] since last sync: +${added.length} new, -${removed.length} no longer extracted`,
    );
    for (const source of removed.slice(0, 10)) {
      const from = previousSources[source]?.join(", ") ?? "unknown file";
      console.warn(`[i18n]   gone from ${from}: ${JSON.stringify(source.slice(0, 60))}`);
    }
    if (removed.length > 10) console.warn(`[i18n]   ...and ${removed.length - 10} more`);
    reportRewordings(added, removed);
  }

  for (const locale of LOCALES) {
    if (locale.id === DEFAULT_LOCALE) continue;
    // Three files per locale, split by what each is for. The shipped catalogue holds only
    // real translations so the downloaded chunk carries no dead weight (empty placeholders
    // for every untranslated key cost ~5x its gzipped size); `.todo` is the translator's
    // work list; `.retired` parks translations for strings upstream has removed.
    const file = path.join(LOCALES_DIR, `${locale.id}.json`);
    const todoFile = path.join(LOCALES_DIR, `${locale.id}.todo.json`);
    const retiredFile = path.join(LOCALES_DIR, `${locale.id}.retired.json`);
    const existing = readJsonRecord(file);
    const todo = readJsonRecord(todoFile);
    const retired = readJsonRecord(retiredFile);

    const nextTranslated: Record<string, string> = {};
    const nextTodo: Record<string, string> = {};
    for (const source of catalogue) {
      // Filled-in `.todo` entries graduate into the shipped catalogue on the next sync.
      const value = existing[source] || todo[source] || retired[source] || "";
      if (value.length > 0) nextTranslated[source] = value;
      else nextTodo[source] = "";
    }
    // Catalogue churn must never destroy work: a reverted upstream change brings the
    // translation straight back out of `.retired`.
    const nextRetired = { ...retired };
    for (const [source, value] of Object.entries(existing)) {
      if (!(source in nextTranslated) && value.length > 0) nextRetired[source] = value;
    }

    const translated = Object.keys(nextTranslated).length;
    const missing = Object.keys(nextTodo).length;
    const percent =
      catalogue.length === 0 ? 100 : Math.round((translated / catalogue.length) * 100);
    console.info(
      `[i18n]   ${locale.id}: ${translated} translated, ${missing} missing (${percent}%)`,
    );

    if (cli.sync) {
      writeJson(file, sortedRecord(nextTranslated));
      writeJson(todoFile, sortedRecord(nextTodo));
      if (Object.keys(nextRetired).length > 0) writeJson(retiredFile, sortedRecord(nextRetired));
    } else if (Object.keys(existing).length + Object.keys(todo).length !== catalogue.length) {
      stale = true;
    }
  }

  console.info(`[i18n] uncovered interpolated sites: ${uncovered.length}`);

  if (cli.sync) {
    const catalogueWithSources: Record<string, string[]> = {};
    for (const source of catalogue) {
      catalogueWithSources[source] = [...(sources.get(source) ?? [])].toSorted();
    }
    writeJson(CATALOGUE_PATH, catalogueWithSources);
    writeJson(UNCOVERED_PATH, uncovered);
    console.info(`[i18n] wrote ${path.relative(REPO_ROOT, LOCALES_DIR)}`);
    return;
  }

  if (cli.check && stale) {
    console.error("[i18n] catalogue is out of date - run `bun run i18n:extract --sync`.");
    process.exitCode = 1;
  }
}

// Only run when invoked as the CLI: the module is also imported by its tests.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
