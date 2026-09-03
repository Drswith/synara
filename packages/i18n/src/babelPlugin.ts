// FILE: babelPlugin.ts
// Purpose: Rewrite user-facing string literals into `t("<English source>")` at build time,
//          so translating the UI needs no edits to component source.
// Layer: i18n build transform
// Exports: default Babel plugin factory, SynaraI18nPluginOptions.
//
// Why a transform instead of `t()` calls in components: Synara is maintained as a fork that
// keeps merging upstream. Threading translation calls through ~350 component files would
// collide with almost every upstream commit. Rewriting the same literals at compile time
// keeps the working tree byte-identical to upstream, so merges stay clean and a brand new
// upstream string simply renders in English until it is translated.
//
// The rules for what counts as user-facing live in policy.ts and are shared with the
// catalogue extractor, so the keys emitted here are exactly the keys extract.ts writes.

import type { NodePath, PluginObject, PluginPass, types as BabelTypes } from "@babel/core";

import {
  DEFAULT_TRANSLATION_ROOTS,
  IGNORE_FILE_MARKER,
  IGNORE_MARKER,
  isCopyBindingName,
  isExcludedFile,
  isOutsideRoots,
  isTranslatableText,
  splitJsxText,
  TRANSLATABLE_JSX_ATTRIBUTES,
  TRANSLATABLE_OBJECT_PROPERTIES,
} from "./policy.ts";

export type SynaraI18nPluginOptions = {
  /** Set false to compile a byte-for-byte untranslated build. */
  readonly enabled?: boolean;
  /** Module the `t` helper is imported from. */
  readonly importSource?: string;
  /** Source trees to rewrite; must match what `extract.ts` scans. */
  readonly roots?: readonly string[];
  /** Also translate display-label properties in object literals (option tables). */
  readonly objectProperties?: boolean;
  /** Receives every rewritten source string; used by tooling, not by the build. */
  readonly onString?: (source: string, filename: string) => void;
  /** Receives strings skipped because the same file also uses them as identifiers. */
  readonly onIdentifier?: (source: string, filename: string) => void;
};

const DEFAULT_IMPORT_SOURCE = "@synara/i18n/runtime";

type PluginState = PluginPass & {
  helperName?: string;
  disabled?: boolean;
  manualHelperNames?: Set<string>;
  identifierStrings?: Set<string>;
};

function hasIgnoreComment(path: NodePath, marker: string): boolean {
  let current: NodePath | null = path;
  while (current) {
    const node = current.node;
    const comments = [
      ...(node.leadingComments ?? []),
      ...(node.trailingComments ?? []),
      ...(node.innerComments ?? []),
    ];
    if (comments.some((comment) => comment.value.includes(marker))) return true;
    if (current.isStatement() || current.isProgram()) break;
    current = current.parentPath;
  }
  return false;
}

/**
 * Collects every string literal the file also uses as a *value to compare or look up*.
 *
 * This is the failure mode the object-property allowlist has: `Sidebar.logic.ts` both
 * produces `label: "Completed"` and later asks `status.label === "Completed"`. Translating
 * the first without the second silently inverts the comparison — a behaviour change that no
 * test written in English would ever catch.
 *
 * A string used this way is an identifier in this file, whatever it also looks like, so it
 * stays in the source language here. The same string in another file is unaffected: the
 * collision is per-file because that is where it actually arises.
 */
function collectIdentifierStrings(
  program: NodePath<BabelTypes.Program>,
  t: typeof BabelTypes,
): Set<string> {
  const identifiers = new Set<string>();
  const EQUALITY = new Set(["===", "!==", "==", "!="]);
  const LOOKUP_METHODS = new Set(["has", "get", "includes", "indexOf", "lastIndexOf", "delete"]);

  program.traverse({
    BinaryExpression(path) {
      if (!EQUALITY.has(path.node.operator)) return;
      for (const side of [path.node.left, path.node.right]) {
        if (t.isStringLiteral(side)) identifiers.add(side.value);
      }
    },
    SwitchCase(path) {
      if (t.isStringLiteral(path.node.test)) identifiers.add(path.node.test.value);
    },
    MemberExpression(path) {
      // `record["Completed"]` addresses a slot; `record.completed` does not.
      if (path.node.computed && t.isStringLiteral(path.node.property)) {
        identifiers.add(path.node.property.value);
      }
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee) || callee.computed) return;
      if (!t.isIdentifier(callee.property) || !LOOKUP_METHODS.has(callee.property.name)) return;
      const [argument] = path.node.arguments;
      if (t.isStringLiteral(argument)) identifiers.add(argument.value);
    },
    TSLiteralType(path) {
      // A string in a type position is a discriminant, e.g.
      // `Extract<Pill["label"], "Pending Approval" | "Awaiting Input">`.
      if (t.isStringLiteral(path.node.literal)) identifiers.add(path.node.literal.value);
    },
  });

  return identifiers;
}

/** The name a function is known by, whether declared, assigned to a const, or a method. */
function functionName(path: NodePath, t: typeof BabelTypes): string | null {
  const node = path.node;
  if (t.isFunctionDeclaration(node) && node.id) return node.id.name;
  if (t.isObjectMethod(node) || t.isClassMethod(node)) {
    const key = node.key;
    return t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : null;
  }
  const parent = path.parentPath;
  if (parent?.isVariableDeclarator()) {
    const id = parent.node.id;
    return t.isIdentifier(id) ? id.name : null;
  }
  return null;
}

/** The i18n package must not translate itself — that would import the runtime into itself. */
function isOwnSource(filename: string): boolean {
  return /[\\/]packages[\\/]i18n[\\/]/.test(filename);
}

export default function synaraI18nBabelPlugin(
  { types: t }: { types: typeof BabelTypes },
  options: SynaraI18nPluginOptions = {},
): PluginObject<PluginState> {
  const enabled = options.enabled ?? true;
  const importSource = options.importSource ?? DEFAULT_IMPORT_SOURCE;
  const roots = options.roots ?? DEFAULT_TRANSLATION_ROOTS;
  const translateObjectProperties = options.objectProperties ?? true;
  const onString = options.onString;

  /** Lazily adds `import { t as _t } from "@synara/i18n/runtime"` to the file. */
  function helper(path: NodePath, state: PluginState): BabelTypes.Identifier {
    const program = path.findParent((parent) =>
      parent.isProgram(),
    ) as NodePath<BabelTypes.Program> | null;
    if (!program) throw path.buildCodeFrameError("[synara-i18n] no Program node in scope.");
    if (!state.helperName) {
      const uid = program.scope.generateUid("synaraT");
      state.helperName = uid;
      const declaration = t.importDeclaration(
        [t.importSpecifier(t.identifier(uid), t.identifier("t"))],
        t.stringLiteral(importSource),
      );
      program.unshiftContainer("body", declaration);
    }
    return t.identifier(state.helperName);
  }

  /** True when this file also treats `source` as an identifier, so it must stay English. */
  function isIdentifierHere(state: PluginState, source: string): boolean {
    if (state.identifierStrings?.has(source) !== true) return false;
    options.onIdentifier?.(source, state.filename ?? "");
    return true;
  }

  function call(path: NodePath, state: PluginState, source: string): BabelTypes.CallExpression {
    onString?.(source, state.filename ?? "");
    return t.callExpression(helper(path, state), [t.stringLiteral(source)]);
  }

  /**
   * Rewrites every string literal an expression can still evaluate to, following `?:`, `??`
   * and `||`.
   *
   * Copy is selected as often as it is written out — a placeholder picked from a chain of
   * conditions is still that placeholder — so a position that accepts a literal has to
   * accept a choice between literals too, or the transform reads the shape and misses the
   * words.
   */
  function translateChoice(
    path: NodePath,
    state: PluginState,
    node: BabelTypes.Expression,
  ): BabelTypes.Expression | null {
    if (t.isStringLiteral(node)) {
      if (!isTranslatableText(node.value)) return null;
      if (isIdentifierHere(state, node.value)) return null;
      return call(path, state, node.value);
    }
    if (t.isConditionalExpression(node)) {
      const consequent = translateChoice(path, state, node.consequent);
      const alternate = translateChoice(path, state, node.alternate);
      if (consequent === null && alternate === null) return null;
      if (consequent) node.consequent = consequent;
      if (alternate) node.alternate = alternate;
      return node;
    }
    if (t.isLogicalExpression(node) && (node.operator === "??" || node.operator === "||")) {
      const right = translateChoice(path, state, node.right);
      if (right === null) return null;
      node.right = right;
      return node;
    }
    return null;
  }

  const rewriteVisitor: NonNullable<PluginObject<PluginState>["visitor"]> = {
    CallExpression(path, state) {
      if (state.disabled) return;
      const callee = path.node.callee;
      if (!t.isIdentifier(callee)) return;

      const names = state.manualHelperNames;
      if (names !== undefined && names.size > 0 && names.has(callee.name)) {
        const [argument] = path.node.arguments;
        if (onString && t.isStringLiteral(argument)) onString(argument.value, state.filename ?? "");
        return;
      }

      // `renderListSectionHeader("Projects", …)` — a helper named for the copy it renders
      // takes that copy as its first argument, the way a `label` property holds it.
      if (!isCopyBindingName(callee.name)) return;
      if (hasIgnoreComment(path, IGNORE_MARKER)) return;
      const [first] = path.node.arguments;
      if (first === undefined || !t.isExpression(first)) return;
      const replacement = translateChoice(path, state, first);
      if (replacement !== null) path.node.arguments[0] = replacement;
    },

    /** `function getLocalFoldersGroupLabel() { return "Folders on this Mac"; }` */
    ReturnStatement(path, state) {
      if (state.disabled) return;
      const fn = path.getFunctionParent();
      if (fn === null) return;
      const name = functionName(fn, t);
      if (name === null || !isCopyBindingName(name)) return;
      if (hasIgnoreComment(path, IGNORE_MARKER)) return;
      const argument = path.node.argument;
      if (!argument || !t.isExpression(argument)) return;
      const replacement = translateChoice(path, state, argument);
      if (replacement !== null) path.node.argument = replacement;
    },

    JSXText(path, state) {
      if (state.disabled) return;
      const split = splitJsxText(path.node.value);
      if (!split) return;
      if (isIdentifierHere(state, split.core)) return;
      if (hasIgnoreComment(path, IGNORE_MARKER)) return;

      const nodes: Array<BabelTypes.JSXText | BabelTypes.JSXExpressionContainer> = [];
      if (split.leading) nodes.push(t.jsxText(split.leading));
      nodes.push(t.jsxExpressionContainer(call(path, state, split.core)));
      if (split.trailing) nodes.push(t.jsxText(split.trailing));
      path.replaceWithMultiple(nodes);
    },

    JSXAttribute(path, state) {
      if (state.disabled) return;
      const name = path.node.name;
      const attributeName = t.isJSXNamespacedName(name)
        ? `${name.namespace.name}:${name.name.name}`
        : name.name;
      if (!TRANSLATABLE_JSX_ATTRIBUTES.has(attributeName)) return;

      if (hasIgnoreComment(path, IGNORE_MARKER)) return;

      const value = path.node.value;
      const expression = t.isStringLiteral(value)
        ? value
        : t.isJSXExpressionContainer(value) && t.isExpression(value.expression)
          ? value.expression
          : null;
      if (!expression) return;

      const replacement = translateChoice(path, state, expression);
      if (replacement === null) return;
      path.node.value = t.jsxExpressionContainer(replacement);
    },

    /** `{cond ? "…" : "…"}` as an element child — the attribute case's sibling. */
    JSXExpressionContainer(path, state) {
      if (state.disabled) return;
      const parent = path.parentPath;
      if (!parent.isJSXElement() && !parent.isJSXFragment()) return;
      if (hasIgnoreComment(path, IGNORE_MARKER)) return;

      const expression = path.node.expression;
      if (!t.isExpression(expression)) return;
      const replacement = translateChoice(path, state, expression);
      if (replacement !== null) path.node.expression = replacement;
    },

    /** `const searchPlaceholder = fromProps ?? "Search projects"` — a prop default. */
    VariableDeclarator(path, state) {
      if (state.disabled) return;
      const id = path.node.id;
      if (!t.isIdentifier(id) || !isCopyBindingName(id.name)) return;
      const init = path.node.init;
      if (!init || !t.isExpression(init)) return;
      if (hasIgnoreComment(path, IGNORE_MARKER)) return;

      const replacement = translateChoice(path, state, init);
      if (replacement !== null) path.node.init = replacement;
    },

    ObjectProperty(path, state) {
      if (state.disabled || !translateObjectProperties) return;
      if (path.node.computed) return;
      const key = path.node.key;
      const keyName = t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : null;
      if (!keyName) return;
      if (!TRANSLATABLE_OBJECT_PROPERTIES.has(keyName)) {
        // `const SIDEBAR_VIEW_LABELS = { threads: "Projects" }` — the table is named for
        // what it holds, so its keys are free to name the thing rather than the copy.
        //
        // The object has to BE the binding's value, not merely sit somewhere inside its
        // initialiser: `const dayLabel = format({ month: "short" })` names a label but
        // that object is Intl's options, and translating "short" breaks the formatter.
        const table = path.parentPath;
        const declarator = table.parentPath;
        if (
          !table.isObjectExpression() ||
          declarator === null ||
          !declarator.isVariableDeclarator() ||
          declarator.node.init !== table.node
        ) {
          return;
        }
        const id = declarator.node.id;
        if (!t.isIdentifier(id) || !isCopyBindingName(id.name)) return;
      }

      const value = path.node.value;
      if (!t.isStringLiteral(value) || !isTranslatableText(value.value)) return;
      if (isIdentifierHere(state, value.value)) return;
      if (hasIgnoreComment(path, IGNORE_MARKER)) return;

      path.node.value = call(path, state, value.value);
    },
  };

  return {
    name: "synara-i18n",
    visitor: {
      Program(path, state) {
        const filename = state.filename ?? "";
        state.disabled =
          !enabled ||
          isOwnSource(filename) ||
          isOutsideRoots(filename, roots) ||
          isExcludedFile(filename) ||
          (path.node.body[0] !== undefined &&
            (path.node.body[0].leadingComments ?? []).some((comment) =>
              comment.value.includes(IGNORE_FILE_MARKER),
            ));

        state.identifierStrings = state.disabled
          ? new Set<string>()
          : collectIdentifierStrings(path, t);

        // Hand-written `t("…")` calls (for strings the transform cannot reach, such as
        // server-supplied text rendered through a variable) must land in the catalogue
        // too, so record which local names are bound to the runtime helper.
        state.manualHelperNames = new Set<string>();
        for (const statement of path.node.body) {
          if (!t.isImportDeclaration(statement)) continue;
          if (statement.source.value !== importSource) continue;
          for (const specifier of statement.specifiers) {
            if (!t.isImportSpecifier(specifier)) continue;
            const imported = specifier.imported;
            const importedName = t.isIdentifier(imported) ? imported.name : imported.value;
            if (importedName === "t") state.manualHelperNames.add(specifier.local.name);
          }
        }

        // Run the whole rewrite here rather than as sibling visitors. Babel merges every
        // plugin and preset into one traversal, and the React Compiler preset hoists JSX
        // expressions into locals before a JSXExpressionContainer visitor would reach them
        // — which silently cost `ComboboxEmpty`'s ternaries their translation while the
        // extractor, running this plugin alone, still listed them. Program enter is the one
        // point that is guaranteed to precede that rewriting.
        path.traverse(rewriteVisitor, state);
      },
    },
  };
}
