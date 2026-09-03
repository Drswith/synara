import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";

import synaraI18nBabelPlugin, { type SynaraI18nPluginOptions } from "./babelPlugin";

function compile(
  code: string,
  options: SynaraI18nPluginOptions = {},
  filename = "/repo/apps/web/src/Sample.tsx",
): { output: string; collected: string[] } {
  const collected: string[] = [];
  const result = transformSync(code, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: filename.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
    plugins: [
      [synaraI18nBabelPlugin, { ...options, onString: (source: string) => collected.push(source) }],
    ],
  });
  return { output: result?.code ?? "", collected };
}

describe("synaraI18nBabelPlugin", () => {
  it("rewrites JSX text and imports the helper once", () => {
    const { output, collected } = compile(
      `export const A = () => <p>Save changes</p>;\nexport const B = () => <p>Discard</p>;`,
    );
    expect(output).toContain(`import { t as _synaraT } from "@synara/i18n/runtime"`);
    expect(output.match(/@synara\/i18n\/runtime/g)).toHaveLength(1);
    expect(collected).toEqual(["Save changes", "Discard"]);
  });

  it("preserves whitespace that JSX would have rendered", () => {
    const { output } = compile(`export const A = ({ n }) => <span>Hello, {n} and welcome</span>;`);
    // The trailing space after "Hello," and the leading space before "and welcome" must stay
    // outside the catalogue key but inside the rendered output.
    expect(output).toContain(`{_synaraT("Hello,")} {n}`);
    expect(output).toContain(`{_synaraT("and welcome")}`);
  });

  it("translates allowlisted attributes and leaves addressing props alone", () => {
    const { output, collected } = compile(
      `export const A = () => <button aria-label="Close panel" className="flex gap-2" data-slot="x" title="Close" />;`,
    );
    expect(output).toContain(`aria-label={_synaraT("Close panel")}`);
    expect(output).toContain(`title={_synaraT("Close")}`);
    expect(output).toContain(`className="flex gap-2"`);
    expect(output).toContain(`data-slot="x"`);
    expect(collected).toEqual(["Close panel", "Close"]);
  });

  it("translates display-label object properties but not their values", () => {
    const { output } = compile(
      `const O = [{ value: "compact", label: "Compact", description: "Tighter spacing." }] as const;`,
      {},
      "/repo/apps/web/src/options.ts",
    );
    expect(output).toContain(`value: "compact"`);
    expect(output).toContain(`label: _synaraT("Compact")`);
    expect(output).toContain(`description: _synaraT("Tighter spacing.")`);
  });

  it("honours the ignore marker and the file-level opt out", () => {
    const { output: ignoredStatement } = compile(
      `// i18n-ignore\nconst O = { label: "Compact" };`,
      {},
      "/repo/apps/web/src/options.ts",
    );
    expect(ignoredStatement).toContain(`label: "Compact"`);

    const { output: ignoredFile } = compile(
      `// i18n-ignore-file\nexport const A = () => <p>Hi there</p>;`,
    );
    expect(ignoredFile).not.toContain("_synaraT");
  });

  it("collects hand-written t() calls so they reach the catalogue", () => {
    const { collected } = compile(
      `import { t } from "@synara/i18n/runtime";\nexport const label = () => t("System");`,
      {},
      "/repo/apps/web/src/label.ts",
    );
    expect(collected).toEqual(["System"]);
  });

  it("is a no-op when disabled, and never touches its own package", () => {
    const { output: disabled } = compile(`export const A = () => <p>Save changes</p>;`, {
      enabled: false,
    });
    expect(disabled).not.toContain("_synaraT");

    const { output: ownSource } = compile(
      `export const A = () => <p>Save changes</p>;`,
      {},
      "/repo/packages/i18n/src/Sample.tsx",
    );
    expect(ownSource).not.toContain("_synaraT");
  });

  it("refuses a string the same file also compares as an identifier", () => {
    // The real case this exists for: Sidebar.logic.ts both produces `label: "Completed"`
    // and asks `status.label === "Completed"`. Translating only the first inverts the
    // comparison — a behaviour change no English-language test would catch.
    const { output, collected } = compile(
      `const pill = { label: "Completed", description: "All done." };\n` +
        `export const isDone = (p: { label: string }) => p.label === "Completed";`,
      {},
      "/repo/apps/web/src/status.ts",
    );
    expect(output).toContain(`label: "Completed"`);
    expect(output).not.toContain(`_synaraT("Completed")`);
    // Copy that is not an identifier in this file is still translated.
    expect(output).toContain(`description: _synaraT("All done.")`);
    expect(collected).toEqual(["All done."]);
  });

  it("treats a string in a type position as a discriminant", () => {
    const { output } = compile(
      `type Pill = { label: "Working" | "Completed" };\n` +
        `export const pill: Pill = { label: "Working" };`,
      {},
      "/repo/apps/web/src/pill.ts",
    );
    expect(output).not.toContain("_synaraT");
  });

  it("reports which strings it skipped as identifiers", () => {
    const skipped: string[] = [];
    compile(
      `const o = { label: "Completed" };\nexport const f = (s: string) => s === "Completed";`,
      { onIdentifier: (source: string) => skipped.push(source) },
      "/repo/apps/web/src/status.ts",
    );
    expect(skipped).toEqual(["Completed"]);
  });

  it("skips test files so assertions keep matching English source text", () => {
    const { output } = compile(
      `export const A = () => <p>Save changes</p>;`,
      {},
      "/repo/apps/web/src/Sample.test.tsx",
    );
    expect(output).not.toContain("_synaraT");
  });
});
