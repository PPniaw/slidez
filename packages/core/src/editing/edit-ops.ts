import * as t from '@babel/types';
import { textDiff } from '../app/lib/text-diff.ts';
import { findJsxAncestors, parseSource, walkAll, walkJsx } from './babel-walk.ts';

export type EditOp =
  | { kind: 'set-style'; key: string; value: string | null; prevText?: string }
  | { kind: 'set-text'; value: string; prevText?: string }
  | {
      kind: 'set-text-range-style';
      start: number;
      end: number;
      key: string;
      value: string | null;
      prevText?: string;
    }
  | { kind: 'set-attr-asset'; attr: string; assetPath: string }
  | { kind: 'replace-placeholder-with-image'; assetPath: string };

export type ApplyEditResult =
  | { ok: true; source: string }
  | { ok: false; status: number; error: string };

export type Splice = { from: number; to: number; text: string };

export function jsString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

export function spliceRange(node: t.Node, text: string): Splice {
  return { from: node.start ?? 0, to: node.end ?? 0, text };
}

// Splices are applied back-to-front so earlier offsets stay valid, then the
// result is re-parsed — a rewrite that cannot be parsed is rejected whole.
export function applySplices(source: string, splices: Splice[]): ApplyEditResult {
  const ordered = [...splices].sort((a, b) => b.from - a.from);
  let next = source;
  for (const sp of ordered) {
    next = next.slice(0, sp.from) + sp.text + next.slice(sp.to);
  }
  if (!parseSource(next)) {
    return { ok: false, status: 422, error: 'edit would produce invalid source' };
  }
  return { ok: true, source: next };
}

// Emit a JSX attribute value: `"foo"` when the value is round-trip-safe
// inside double quotes; otherwise wrap in `{...}` so escapes work.
export function formatJsxAttrValue(value: string): string {
  if (/^[^"\\<>&{}\n\r]*$/.test(value)) return `"${value}"`;
  return `{${jsString(value)}}`;
}

function jsxAttrName(attr: t.JSXAttribute): string | null {
  return t.isJSXIdentifier(attr.name) ? attr.name.name : null;
}

export function findJsxAttr(opening: t.JSXOpeningElement, name: string): t.JSXAttribute | null {
  for (const attr of opening.attributes) {
    if (t.isJSXAttribute(attr) && jsxAttrName(attr) === name) return attr;
  }
  return null;
}

export function readJsxStringAttr(opening: t.JSXOpeningElement, name: string): string | null {
  const attr = findJsxAttr(opening, name);
  const v = attr?.value;
  if (!v) return null;
  if (t.isStringLiteral(v)) return v.value;
  if (t.isJSXExpressionContainer(v) && t.isStringLiteral(v.expression)) return v.expression.value;
  return null;
}

function readJsxNumberAttr(opening: t.JSXOpeningElement, name: string): number | null {
  const attr = findJsxAttr(opening, name);
  const v = attr?.value;
  if (!v || !t.isJSXExpressionContainer(v)) return null;
  if (!t.isNumericLiteral(v.expression)) return null;
  const n = v.expression.value;
  return Number.isFinite(n) ? n : null;
}

export type ImportInfo = {
  node: t.ImportDeclaration;
  source: string;
  defaultIdent: string | null;
};

export function findImports(ast: t.File): ImportInfo[] {
  const out: ImportInfo[] = [];
  for (const node of ast.program.body) {
    if (!t.isImportDeclaration(node)) continue;
    let def: string | null = null;
    for (const spec of node.specifiers) {
      if (t.isImportDefaultSpecifier(spec)) {
        def = spec.local.name;
        break;
      }
    }
    out.push({ node, source: node.source.value, defaultIdent: def });
  }
  return out;
}

function collectTopLevelIdentifiers(ast: t.File): Set<string> {
  // Only need to avoid colliding with anything resolvable by JSX —
  // import bindings cover the common case. Local consts/lets are
  // handled by source-level identifier scanning below.
  const names = new Set<string>();
  for (const imp of findImports(ast)) {
    if (imp.defaultIdent) names.add(imp.defaultIdent);
    for (const spec of imp.node.specifiers) {
      if (!t.isImportDefaultSpecifier(spec)) names.add(spec.local.name);
    }
  }
  return names;
}

export function safeAssetIdentifier(filename: string, taken: Set<string>): string {
  const stem = filename.replace(/\.[^.]+$/, '');
  let camel = '';
  let upper = false;
  for (const ch of stem) {
    if (/[A-Za-z0-9]/.test(ch)) {
      camel += upper ? ch.toUpperCase() : ch;
      upper = false;
    } else {
      upper = camel.length > 0;
    }
  }
  let base = camel;
  if (!base || !/^[A-Za-z_$]/.test(base)) {
    base = `asset${base.charAt(0).toUpperCase()}${base.slice(1)}` || 'asset';
  }
  base = base.charAt(0).toLowerCase() + base.slice(1);
  let candidate = base;
  let i = 2;
  while (taken.has(candidate)) {
    candidate = `${base}${i}`;
    i += 1;
  }
  return candidate;
}

function findJsxByStart(ast: t.Node, line: number, column: number): t.JSXElement | null {
  let hit: t.JSXElement | null = null;
  walkJsx(ast, (n) => {
    if (!t.isJSXElement(n) || !n.loc) return;
    const s = n.loc.start;
    if (s.line === line && s.column === column) {
      hit = n;
      return 'stop';
    }
  });
  return hit;
}

function findInnermostJsxElement(ast: t.Node, line: number, column: number): t.JSXElement | null {
  // Prefer exact `loc.start` match (what `data-slide-loc` sends) so
  // we don't accidentally hit an outer JSX whose range happens to
  // enclose the click point.
  const exact = findJsxByStart(ast, line, column);
  if (exact) return exact;

  // Fallback for fiber-walked clicks whose column may not align with
  // the opening `<`.
  for (const n of findJsxAncestors(ast, line, column)) {
    if (t.isJSXElement(n)) return n;
  }
  return null;
}

function findUniqueElementByText(ast: t.Node, prevText: string): t.JSXElement | null {
  const hits: Array<{ node: t.JSXElement; size: number }> = [];
  walkJsx(ast, (n) => {
    if (!t.isJSXElement(n)) return;
    if (textRangeContent(collectTextRangeParts(n)) !== prevText) return;
    hits.push({ node: n, size: (n.end ?? 0) - (n.start ?? 0) });
  });
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.size - b.size);
  const best = hits[0];
  const bestStart = best.node.start ?? 0;
  const bestEnd = best.node.end ?? 0;
  const hasSiblingMatch = hits
    .slice(1)
    .some(({ node }) => (node.start ?? 0) > bestStart || (node.end ?? 0) < bestEnd);
  return hasSiblingMatch ? null : best.node;
}

function fallbackTextForOps(ops: EditOp[]): string | null {
  for (const op of ops) {
    if (
      (op.kind === 'set-style' || op.kind === 'set-text' || op.kind === 'set-text-range-style') &&
      op.prevText !== undefined
    ) {
      return op.prevText;
    }
  }
  return null;
}

function hasOnlyTextOps(ops: EditOp[]): boolean {
  return ops.length > 0 && ops.every((op) => op.kind === 'set-text');
}

function elementTextMatches(element: t.JSXElement, prevText: string): boolean {
  return textRangeContent(collectTextRangeParts(element)) === prevText;
}

export function findElementForEdit(
  ast: t.File,
  line: number,
  column: number,
  ops: EditOp[],
): t.JSXElement | null {
  const element = findInnermostJsxElement(ast, line, column);
  const prevText = fallbackTextForOps(ops);
  if (prevText === null) return element;
  if (
    hasOnlyTextOps(ops) &&
    element &&
    (elementTextMatches(element, prevText) || elementTextCandidateMatches(ast, element, prevText))
  ) {
    return element;
  }
  return findUniqueElementByText(ast, prevText) ?? element;
}

function buildStyleSplice(
  source: string,
  element: t.JSXElement,
  ops: Array<{ key: string; value: string | null }>,
): Splice | { error: string } | null {
  const opening = element.openingElement;
  const existing = findJsxAttr(opening, 'style');
  type StyleEntry =
    | { kind: 'prop'; key: string; keyText: string; valueText: string }
    | { kind: 'raw'; text: string };
  const entries: StyleEntry[] = [];
  let hasRawEntry = false;

  if (existing) {
    const value = existing.value;
    if (!value || !t.isJSXExpressionContainer(value)) {
      return { error: 'style attribute has unsupported form' };
    }
    const expr = value.expression;
    if (!t.isObjectExpression(expr)) {
      if (typeof expr.start !== 'number' || typeof expr.end !== 'number') {
        return { error: 'style value missing source range' };
      }
      entries.push({ kind: 'raw', text: `...(${source.slice(expr.start, expr.end)})` });
      hasRawEntry = true;
    } else {
      for (const prop of expr.properties) {
        if (t.isObjectProperty(prop) && !prop.computed) {
          let keyName: string | null = null;
          if (t.isIdentifier(prop.key)) keyName = prop.key.name;
          else if (t.isStringLiteral(prop.key)) keyName = prop.key.value;
          if (!keyName) return { error: 'style has unsupported key' };
          const v = prop.value;
          if (
            typeof prop.key.start !== 'number' ||
            typeof prop.key.end !== 'number' ||
            typeof v.start !== 'number' ||
            typeof v.end !== 'number'
          ) {
            return { error: 'style value missing source range' };
          }
          entries.push({
            kind: 'prop',
            key: keyName,
            keyText: source.slice(prop.key.start, prop.key.end),
            valueText: source.slice(v.start, v.end),
          });
        } else {
          if (typeof prop.start !== 'number' || typeof prop.end !== 'number') {
            return { error: 'style value missing source range' };
          }
          entries.push({ kind: 'raw', text: source.slice(prop.start, prop.end) });
          hasRawEntry = true;
        }
      }
    }
  }

  for (const op of ops) {
    const matching = entries.filter(
      (entry): entry is Extract<StyleEntry, { kind: 'prop' }> =>
        entry.kind === 'prop' && entry.key === op.key,
    );
    if (op.value === null) {
      for (const entry of matching) entries.splice(entries.indexOf(entry), 1);
      if (hasRawEntry) {
        entries.push({ kind: 'prop', key: op.key, keyText: op.key, valueText: 'undefined' });
      }
    } else if (matching.length > 0) {
      matching[matching.length - 1].valueText = jsString(op.value);
    } else {
      entries.push({ kind: 'prop', key: op.key, keyText: op.key, valueText: jsString(op.value) });
    }
  }

  if (entries.length === 0) {
    if (!existing) return null;
    let from = existing.start ?? 0;
    if (from > 0 && source[from - 1] === ' ') from -= 1;
    return { from, to: existing.end ?? 0, text: '' };
  }

  const propsText = entries
    .map((entry) => (entry.kind === 'prop' ? `${entry.keyText}: ${entry.valueText}` : entry.text))
    .join(', ');
  const newAttr = `style={{ ${propsText} }}`;

  if (existing) {
    const lastAttr = opening.attributes[opening.attributes.length - 1];
    if (lastAttr && lastAttr !== existing && typeof lastAttr.end === 'number') {
      const attrsAfterStyle = source.slice(existing.end ?? 0, lastAttr.end).replace(/^[ \t]+/, '');
      return {
        from: existing.start ?? 0,
        to: lastAttr.end,
        text: `${attrsAfterStyle} ${newAttr}`,
      };
    }
    return { from: existing.start ?? 0, to: existing.end ?? 0, text: newAttr };
  }
  const lastAttr = opening.attributes[opening.attributes.length - 1];
  const at = lastAttr?.end ?? opening.name.end ?? 0;
  return { from: at, to: at, text: ` ${newAttr}` };
}

function formatJsxText(value: string): string {
  // JSXText can't hold `{}<>` and collapses leading/trailing whitespace,
  // so wrap the value in an expression container when it would lose info.
  if (/[{}<>]/.test(value) || /^\s|\s$/.test(value) || value === '') {
    return `{${jsString(value)}}`;
  }
  return value;
}

type TextCandidate = {
  // Normalized current text the candidate represents — what an
  // unambiguous DOM `textContent` would render here. Used to match
  // against the client-supplied `prevText` when there's more than one.
  current: string;
  splice: (value: string) => Splice;
};

type JsxParent = t.JSXElement | t.JSXFragment;
type TextRangeLeaf = {
  // A string literal is a prop value at a call site the text was forwarded from.
  node: t.JSXText | t.JSXExpressionContainer | t.StringLiteral;
  parent: JsxParent;
  current: string;
  raw: string;
  text: (value: string) => string;
  offsets: Array<number | null>;
};
type TextRangeBreak = { node: t.JSXElement; current: '\n' };
type TextRangePart = TextRangeLeaf | TextRangeBreak;

function meaningfulChildren(parent: JsxParent): t.Node[] {
  return parent.children.filter((c) => {
    if (t.isJSXText(c)) return c.value.trim() !== '';
    return true;
  });
}

function isOnlyMeaningfulChild(parent: JsxParent, child: t.Node): boolean {
  const meaningful = meaningfulChildren(parent);
  return meaningful.length === 1 && meaningful[0] === child;
}

// Wrap-style splice: rewrite the whole children span of `parent`. Used
// when the candidate is the parent's only meaningful child, so old
// surrounding whitespace nodes don't leak into the new value.
function wrapSplice(parent: JsxParent, text: string): Splice {
  const first = parent.children[0];
  const last = parent.children[parent.children.length - 1];
  return { from: first.start ?? 0, to: last.end ?? 0, text };
}

function splitLinesWithOffsets(value: string): Array<{ text: string; start: number }> {
  const lines: Array<{ text: string; start: number }> = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\n' && ch !== '\r') continue;
    lines.push({ text: value.slice(start, i), start });
    if (ch === '\r' && value[i + 1] === '\n') i += 1;
    start = i + 1;
  }
  lines.push({ text: value.slice(start), start });
  return lines;
}

function cleanJsxTextWithOffsets(value: string): {
  text: string;
  offsets: Array<number | null>;
} {
  const lines = splitLinesWithOffsets(value);
  let lastNonEmptyLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].text.trim()) lastNonEmptyLine = i;
  }

  let text = '';
  const offsets: Array<number | null> = [];
  for (let i = 0; i < lines.length; i++) {
    const chars = Array.from(lines[i].text, (ch, j) => ({
      ch: ch === '\t' ? ' ' : ch,
      offset: lines[i].start + j,
    }));
    let from = 0;
    let to = chars.length;
    if (i !== 0) {
      while (from < to && chars[from].ch === ' ') from += 1;
    }
    if (i !== lines.length - 1) {
      while (to > from && chars[to - 1].ch === ' ') to -= 1;
    }
    if (from >= to) continue;
    for (const item of chars.slice(from, to)) {
      text += item.ch;
      offsets.push(item.offset);
    }
    if (i !== lastNonEmptyLine) {
      text += ' ';
      offsets.push(null);
    }
  }
  return { text, offsets };
}

function isJsxBrElement(node: t.Node): node is t.JSXElement {
  if (!t.isJSXElement(node)) return false;
  const name = node.openingElement.name;
  return t.isJSXIdentifier(name) && name.name.toLowerCase() === 'br';
}

function collectTextCandidates(element: JsxParent, out: TextCandidate[]): void {
  const meaningful = meaningfulChildren(element);
  const isSole = meaningful.length === 1;
  for (const child of meaningful) {
    if (t.isJSXText(child)) {
      const current = child.value.trim();
      if (!current) continue;
      out.push({
        current,
        splice: (v) =>
          isSole
            ? wrapSplice(element, formatJsxText(v))
            : { from: child.start ?? 0, to: child.end ?? 0, text: formatJsxText(v) },
      });
    } else if (t.isJSXExpressionContainer(child)) {
      const expr = child.expression;
      if (t.isStringLiteral(expr) || t.isNumericLiteral(expr)) {
        const current = String(expr.value);
        out.push({
          current,
          splice: (v) =>
            isSole
              ? wrapSplice(element, `{${jsString(v)}}`)
              : { from: child.start ?? 0, to: child.end ?? 0, text: `{${jsString(v)}}` },
        });
      }
    } else if (t.isJSXElement(child) || t.isJSXFragment(child)) {
      collectTextCandidates(child, out);
    }
  }
}

function collectTextRangeParts(element: JsxParent): TextRangePart[] {
  const parts: TextRangePart[] = [];
  collectTextRangePartsRaw(element, parts);
  return normalizeTextRangeParts(parts);
}

// The part a literal child renders: JSX text, or a string/number in braces.
// Undefined when the child is not a literal; null when it renders nothing.
function literalTextPart(child: t.Node, element: JsxParent): TextRangeLeaf | null | undefined {
  if (t.isJSXText(child)) {
    const { text: current, offsets } = cleanJsxTextWithOffsets(child.value);
    if (!current) return null;
    return {
      node: child,
      parent: element,
      current,
      raw: child.value,
      text: formatJsxText,
      offsets,
    };
  }
  if (!t.isJSXExpressionContainer(child)) return undefined;
  const expression = child.expression;
  if (!t.isStringLiteral(expression) && !t.isNumericLiteral(expression)) return undefined;
  const current = String(expression.value);
  if (!current) return null;
  return {
    node: child,
    parent: element,
    current,
    raw: current,
    text: (value) => `{${jsString(value)}}`,
    offsets: Array.from({ length: current.length }, (_, i) => i),
  };
}

function collectTextRangePartsRaw(element: JsxParent, out: TextRangePart[]): void {
  for (const child of element.children) {
    const literal = literalTextPart(child, element);
    if (literal !== undefined) {
      if (literal) out.push(literal);
    } else if (isJsxBrElement(child)) {
      out.push({ node: child, current: '\n' });
    } else if (t.isJSXElement(child) || t.isJSXFragment(child)) {
      collectTextRangePartsRaw(child, out);
    }
  }
}

function normalizeTextRangeParts(parts: TextRangePart[]): TextRangePart[] {
  return parts.flatMap((part, index): TextRangePart[] => {
    if (!('raw' in part)) return [part];
    let start = 0;
    let end = part.current.length;
    if (parts[index - 1]?.current === '\n') {
      while (start < end && /\s/.test(part.current[start] ?? '')) start++;
    }
    if (parts[index + 1]?.current === '\n') {
      while (end > start && /\s/.test(part.current[end - 1] ?? '')) end--;
    }
    if (start === 0 && end === part.current.length) return [part];
    if (start >= end) return [];
    return [
      {
        ...part,
        current: part.current.slice(start, end),
        offsets: part.offsets.slice(start, end),
      },
    ];
  });
}

function resetValueForRangeStyle(key: string): string | null {
  if (key === 'fontWeight') return '400';
  if (key === 'fontStyle') return 'normal';
  return null;
}

function styleSpanForText(text: string, key: string, value: string | null): string {
  const styleValue = value ?? resetValueForRangeStyle(key);
  if (styleValue === null) return formatJsxText(text);
  return `<span style={{ ${key}: ${jsString(styleValue)} }}>${formatJsxText(text)}</span>`;
}

function textRangeContent(parts: TextRangePart[]): string {
  return parts.map((part) => part.current).join('');
}

function compactText(value: string): string {
  return value.replace(/\s+/g, '');
}

function textMatchesExpected(current: string, expected: string): boolean {
  return current === expected || compactText(current) === compactText(expected);
}

function formatRichText(value: string, formatText = formatJsxText): string {
  return value
    .split('\n')
    .map((part) => formatText(part))
    .join('<br />');
}

function formatOptionalText(value: string, formatText: (v: string) => string): string {
  return value ? formatText(value) : '';
}

function textLeafSplice(part: TextRangeLeaf, value: string): Splice {
  const rawRange = textLeafRawRange(part, 0, part.current.length);
  if (!rawRange) return spliceRange(part.node, part.text(value));
  const { rawStart, rawEnd } = rawRange;
  return {
    from: part.node.start ?? 0,
    to: part.node.end ?? 0,
    text: `${part.raw.slice(0, rawStart)}${formatRichText(value, part.text)}${part.raw.slice(rawEnd)}`,
  };
}

function textLeafRawRange(
  part: TextRangeLeaf,
  start: number,
  end: number,
): { rawStart: number; rawEnd: number } | null {
  if (start >= end) return null;
  let first: number | null = null;
  let last: number | null = null;
  for (let i = start; i < end; i++) {
    const offset = part.offsets[i];
    if (offset === undefined) return null;
    if (offset === null) continue;
    first ??= offset;
    last = offset;
  }
  if (first === null || last === null) return null;
  return { rawStart: first, rawEnd: last + 1 };
}

function buildTextRangeReplaceSplices(
  parts: TextRangePart[],
  start: number,
  end: number,
  value: string,
): Splice[] | { error: string } {
  const splices: Splice[] = [];
  let offset = 0;
  let inserted = false;

  for (const part of parts) {
    const partStart = offset;
    const partEnd = partStart + part.current.length;
    offset = partEnd;

    const overlaps = start < partEnd && end > partStart;
    const insertsHere = start === end && !inserted && start >= partStart && start <= partEnd;
    if (!overlaps && !insertsHere) continue;

    if ('raw' in part) {
      const localStart = Math.max(start, partStart) - partStart;
      const localEnd = overlaps ? Math.min(end, partEnd) - partStart : localStart;
      const nextText = `${part.current.slice(0, localStart)}${inserted ? '' : value}${part.current.slice(localEnd)}`;
      splices.push(textLeafSplice(part, nextText));
    } else if (overlaps) {
      splices.push(spliceRange(part.node, inserted ? '' : formatRichText(value)));
    } else if (insertsHere) {
      const at = start === partStart ? (part.node.start ?? 0) : (part.node.end ?? 0);
      splices.push({ from: at, to: at, text: formatRichText(value) });
    }

    inserted = true;
  }

  if (!inserted && start === end && start === offset) {
    const last = parts[parts.length - 1];
    if (!last) return { error: 'element has no editable text' };
    if ('raw' in last) {
      splices.push(textLeafSplice(last, `${last.current}${value}`));
    } else {
      splices.push({
        from: last.node.end ?? 0,
        to: last.node.end ?? 0,
        text: formatRichText(value),
      });
    }
  }

  return splices;
}

function buildTextContentSplices(
  element: t.JSXElement,
  value: string,
  prevText: string,
): Splice[] | { error: string } {
  const parts = collectTextRangeParts(element);
  const current = textRangeContent(parts);
  if (!textMatchesExpected(current, prevText)) {
    return { error: 'no text candidate matches the current value' };
  }
  const diff = textDiff(current, value);
  if (diff.start === diff.end && diff.value === '') return [];
  return buildTextRangeReplaceSplices(parts, diff.start, diff.end, diff.value);
}

function buildTextRangeStyleSplices(
  ast: t.File,
  source: string,
  element: t.JSXElement,
  start: number,
  end: number,
  op: { key: string; value: string | null },
  prevText?: string,
): Splice[] | { error: string } | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    return { error: 'invalid text range' };
  }

  const parts = collectTextRangeParts(element);
  const renderedText = textRangeContent(parts);
  const current = prevText ?? renderedText;
  if (!current) return { error: 'element has no editable text' };
  if (end > current.length) return { error: 'text range is out of bounds' };
  if (prevText !== undefined && renderedText !== prevText) {
    if (elementTextCandidateMatches(ast, element, prevText)) {
      const result = buildStyleSplice(source, element, [op]);
      if (result && 'error' in result) return result;
      return result ? [result] : [];
    }
    return { error: 'no text candidate matches the current value' };
  }

  const splices: Splice[] = [];
  let leafStart = 0;
  for (const leaf of parts) {
    const leafEnd = leafStart + leaf.current.length;
    if (!('raw' in leaf)) {
      leafStart = leafEnd;
      continue;
    }
    const selectedStart = Math.max(start, leafStart);
    const selectedEnd = Math.min(end, leafEnd);
    if (selectedStart >= selectedEnd) {
      leafStart = leafEnd;
      continue;
    }

    if (
      selectedStart === leafStart &&
      selectedEnd === leafEnd &&
      t.isJSXElement(leaf.parent) &&
      leaf.parent !== element &&
      isOnlyMeaningfulChild(leaf.parent, leaf.node)
    ) {
      const result = buildStyleSplice(source, leaf.parent, [op]);
      if (result && 'error' in result) return result;
      if (result) splices.push(result);
      leafStart = leafEnd;
      continue;
    }

    const localStart = selectedStart - leafStart;
    const localEnd = selectedEnd - leafStart;
    const rawRange = textLeafRawRange(leaf, localStart, localEnd);
    if (!rawRange) return { error: 'text range source mismatch' };
    const raw = leaf.raw;
    const { rawStart, rawEnd } = rawRange;
    const before = raw.slice(0, rawStart);
    const selected = leaf.current.slice(localStart, localEnd);
    const after = raw.slice(rawEnd);
    const beforeText = t.isJSXText(leaf.node) ? before : formatOptionalText(before, leaf.text);
    const afterText = t.isJSXText(leaf.node) ? after : formatOptionalText(after, leaf.text);
    splices.push(
      spliceRange(
        leaf.node,
        `${beforeText}${styleSpanForText(selected, op.key, op.value)}${afterText}`,
      ),
    );
    leafStart = leafEnd;
  }

  return splices.length > 0 ? splices : null;
}

// `<Wrap>{children}</Wrap>` and `<h2>{title}</h2>` — sole child is a
// JSXExpressionContainer wrapping a bare Identifier. Returns the identifier
// name; callers branch on `'children'` vs. a generic prop passthrough.
function propPassthroughName(element: t.JSXElement): string | null {
  const meaningful = meaningfulChildren(element);
  if (meaningful.length !== 1) return null;
  const child = meaningful[0];
  if (!t.isJSXExpressionContainer(child)) return null;
  return t.isIdentifier(child.expression) ? child.expression.name : null;
}

type EnclosingComponent = {
  name: string;
  fn: t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression;
};

// Smallest top-level capitalized function whose body covers `target`.
function findEnclosingComponent(ast: t.File, target: t.Node): EnclosingComponent | null {
  let best: EnclosingComponent | null = null;
  let bestSize = Number.POSITIVE_INFINITY;
  const targetStart = target.start ?? 0;
  const targetEnd = target.end ?? 0;
  const consider = (name: string, fn: EnclosingComponent['fn']) => {
    if (!/^[A-Z]/.test(name)) return;
    const fnStart = fn.start ?? 0;
    const fnEnd = fn.end ?? 0;
    if (fnStart > targetStart || fnEnd < targetEnd) return;
    const size = fnEnd - fnStart;
    if (size < bestSize) {
      best = { name, fn };
      bestSize = size;
    }
  };
  const visitDecl = (decl: t.Statement) => {
    if (t.isFunctionDeclaration(decl) && decl.id) {
      consider(decl.id.name, decl);
    } else if (t.isVariableDeclaration(decl)) {
      for (const d of decl.declarations) {
        if (!t.isVariableDeclarator(d) || !t.isIdentifier(d.id) || !d.init) continue;
        if (t.isArrowFunctionExpression(d.init) || t.isFunctionExpression(d.init)) {
          consider(d.id.name, d.init);
        }
      }
    }
  };
  for (const decl of ast.program.body) {
    visitDecl(decl);
    if (t.isExportNamedDeclaration(decl) || t.isExportDefaultDeclaration(decl)) {
      const inner = decl.declaration;
      if (inner && (t.isStatement(inner) || t.isFunctionDeclaration(inner))) {
        visitDecl(inner as t.Statement);
      }
    }
  }
  return best;
}

function componentDestructuresProp(fn: EnclosingComponent['fn'], propName: string): boolean {
  if (fn.params.length === 0) return false;
  let first: t.Node = fn.params[0];
  // Handle `({ title }: Props = defaults)` — strip the default-value wrapper.
  if (t.isAssignmentPattern(first)) first = first.left;
  if (!t.isObjectPattern(first)) return false;
  for (const prop of first.properties) {
    if (!t.isObjectProperty(prop)) continue;
    if (t.isIdentifier(prop.key) && prop.key.name === propName) return true;
    if (t.isStringLiteral(prop.key) && prop.key.value === propName) return true;
  }
  return false;
}

// A literal a call site hands a component, with the source it sits in.
type ForwardedLeaf = {
  current: string;
  node: t.JSXText | t.JSXExpressionContainer | t.StringLiteral;
  text: (value: string) => string;
};

// Deep enough for any real wrapper chain; stops a component that renders itself.
const MAX_FORWARD_DEPTH = 6;

function expressionLeaf(
  container: t.JSXExpressionContainer,
  text: (value: string) => string,
): ForwardedLeaf | { forward: string } | null {
  const expr = container.expression;
  if (t.isStringLiteral(expr) || t.isNumericLiteral(expr)) {
    return { current: String(expr.value), node: container, text };
  }
  return t.isIdentifier(expr) ? { forward: expr.name } : null;
}

// What a call site passes for `prop`: a literal, an identifier it forwards
// from its own component's props (`title={title}`), or null for anything else.
function callSiteProp(
  site: t.JSXElement,
  prop: string,
): ForwardedLeaf | { forward: string } | null {
  if (prop === 'children') {
    const meaningful = meaningfulChildren(site);
    if (meaningful.length !== 1) return null;
    const child = meaningful[0];
    if (t.isJSXText(child))
      return { current: child.value.trim(), node: child, text: formatJsxText };
    return t.isJSXExpressionContainer(child)
      ? expressionLeaf(child, (v) => `{${jsString(v)}}`)
      : null;
  }
  const value = findJsxAttr(site.openingElement, prop)?.value;
  if (!value) return null; // shorthand-true: not editable text.
  if (t.isStringLiteral(value)) {
    return { current: value.value, node: value, text: formatJsxAttrValue };
  }
  return t.isJSXExpressionContainer(value) ? expressionLeaf(value, formatJsxAttrValue) : null;
}

// One binding per way `props` reach `component`: each call site's literals,
// and where a call site forwards a prop of its own component
// (`<Title title={title} />` inside `Split`), each of that component's call
// sites in turn, up to the literal the deck actually writes.
function resolveForwardedProps(
  ast: t.File,
  component: string,
  props: string[],
  depth = 0,
): Array<Map<string, ForwardedLeaf>> {
  const out: Array<Map<string, ForwardedLeaf>> = [];
  if (depth > MAX_FORWARD_DEPTH) return out;
  walkJsx(ast, (site) => {
    if (!t.isJSXElement(site)) return;
    const name = site.openingElement.name;
    if (!t.isJSXIdentifier(name) || name.name !== component) return;
    const local = new Map<string, ForwardedLeaf>();
    const forwarded = new Map<string, string>();
    for (const prop of props) {
      const value = callSiteProp(site, prop);
      if (!value) return;
      if ('forward' in value) forwarded.set(prop, value.forward);
      else local.set(prop, value);
    }
    if (forwarded.size === 0) {
      out.push(local);
      return;
    }
    const outer = findEnclosingComponent(ast, site);
    const names = [...new Set(forwarded.values())];
    if (!outer || !names.every((n) => n === 'children' || componentDestructuresProp(outer.fn, n))) {
      return;
    }
    for (const binding of resolveForwardedProps(ast, outer.name, names, depth + 1)) {
      const merged = new Map(local);
      for (const [prop, from] of forwarded) {
        const leaf = binding.get(from);
        if (leaf) merged.set(prop, leaf);
      }
      if (merged.size === props.length) out.push(merged);
    }
  });
  return out;
}

function leafCandidate(leaf: ForwardedLeaf): TextCandidate {
  return { current: leaf.current, splice: (v) => spliceRange(leaf.node, leaf.text(v)) };
}

function collectCallSiteCandidates(ast: t.File, componentName: string): TextCandidate[] {
  const out: TextCandidate[] = [];
  walkJsx(ast, (n) => {
    if (!t.isJSXElement(n)) return;
    const elName = n.openingElement.name;
    if (!t.isJSXIdentifier(elName) || elName.name !== componentName) return;
    const before = out.length;
    collectTextCandidates(n, out);
    if (out.length > before) return;
    // `<Wrap>{children}</Wrap>` inside another component: follow it up.
    const passed = callSiteProp(n, 'children');
    const outer = passed && 'forward' in passed ? findEnclosingComponent(ast, n) : null;
    if (!passed || !('forward' in passed) || !outer) return;
    const from = passed.forward;
    if (from !== 'children' && !componentDestructuresProp(outer.fn, from)) return;
    for (const binding of resolveForwardedProps(ast, outer.name, [from], 1)) {
      const leaf = binding.get(from);
      if (leaf) out.push(leafCandidate(leaf));
    }
  });
  return out;
}

function collectPropCallSiteCandidates(
  ast: t.File,
  componentName: string,
  propName: string,
): TextCandidate[] {
  return resolveForwardedProps(ast, componentName, [propName]).flatMap((binding) => {
    const leaf = binding.get(propName);
    return leaf ? [leafCandidate(leaf)] : [];
  });
}

// Smallest enclosing `arr.map((p) => …)` callback (or `.flatMap`) that
// covers `target`. Returns the callback fn plus the array argument node.
function findEnclosingMapCallback(
  ast: t.Node,
  target: t.Node,
): { fn: t.ArrowFunctionExpression | t.FunctionExpression; arrayArg: t.Expression } | null {
  type Best = {
    fn: t.ArrowFunctionExpression | t.FunctionExpression;
    arrayArg: t.Expression;
    size: number;
  };
  let best: Best | null = null;
  const targetStart = target.start ?? 0;
  const targetEnd = target.end ?? 0;
  walkAll(ast, (node) => {
    if (!t.isCallExpression(node)) return;
    const callee = node.callee;
    if (!t.isMemberExpression(callee) || callee.computed) return;
    if (!t.isIdentifier(callee.property)) return;
    if (callee.property.name !== 'map' && callee.property.name !== 'flatMap') return;
    const fn = node.arguments[0];
    if (!fn || (!t.isArrowFunctionExpression(fn) && !t.isFunctionExpression(fn))) return;
    const fnStart = fn.start ?? 0;
    const fnEnd = fn.end ?? 0;
    if (fnStart > targetStart || fnEnd < targetEnd) return;
    if (!t.isExpression(callee.object)) return;
    const size = fnEnd - fnStart;
    if (!best || size < best.size) best = { fn, arrayArg: callee.object, size };
  });
  if (!best) return null;
  const found: Best = best;
  return { fn: found.fn, arrayArg: found.arrayArg };
}

type ArrayElement = t.Expression | t.SpreadElement;

// `[ {...}, {...} ]` literal, either inline or via a `const x = [ ... ]`
// declaration the receiver resolves to. Returns the ArrayExpression's
// element list, or null if we can't resolve to a literal.
function resolveArrayLiteralElements(ast: t.Node, expr: t.Expression): ArrayElement[] | null {
  const dropHoles = (arr: t.ArrayExpression): ArrayElement[] =>
    arr.elements.filter((e): e is ArrayElement => e != null);
  if (t.isArrayExpression(expr)) return dropHoles(expr);
  if (!t.isIdentifier(expr)) return null;
  const name = expr.name;
  const useStart = expr.start ?? 0;
  let init: t.ArrayExpression | null = null;
  walkAll(ast, (node) => {
    if (!t.isVariableDeclarator(node)) return;
    if (!t.isIdentifier(node.id) || node.id.name !== name) return;
    if (!node.init || !t.isArrayExpression(node.init)) return;
    // Must be declared before the use site; pick the most local match.
    if ((node.init.start ?? 0) > useStart) return;
    init = node.init;
  });
  return init ? dropHoles(init) : null;
}

function findObjectProperty(obj: t.Node, name: string): t.ObjectProperty | null {
  if (!t.isObjectExpression(obj)) return null;
  for (const prop of obj.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) continue;
    if (t.isIdentifier(prop.key) && prop.key.name === name) return prop;
    if (t.isStringLiteral(prop.key) && prop.key.value === name) return prop;
  }
  return null;
}

// Decode `{p.field}` (MemberExpression) or `{field}` (Identifier
// destructured from the callback param) into a single field name.
function decodeMapPassthrough(
  element: t.JSXElement,
  callbackParam: t.Node | undefined,
): string | null {
  const meaningful = meaningfulChildren(element);
  if (meaningful.length !== 1) return null;
  const child = meaningful[0];
  if (!t.isJSXExpressionContainer(child)) return null;
  const expr = child.expression;

  if (t.isMemberExpression(expr)) {
    if (expr.computed) return null;
    if (!t.isIdentifier(expr.object) || !t.isIdentifier(expr.property)) return null;
    if (!callbackParam || !t.isIdentifier(callbackParam)) return null;
    if (callbackParam.name !== expr.object.name) return null;
    return expr.property.name;
  }

  if (t.isIdentifier(expr)) {
    const fieldName = expr.name;
    // Param is `{ field, ... }` destructuring — the identifier names the
    // destructured property. Skip alias/rename forms (`{ field: alias }`).
    if (!callbackParam || !t.isObjectPattern(callbackParam)) return null;
    for (const prop of callbackParam.properties) {
      if (!t.isObjectProperty(prop) || prop.computed) continue;
      if (!t.isIdentifier(prop.key) || prop.key.name !== fieldName) continue;
      // Shorthand `{ field }` → value is also an Identifier with same name.
      // Aliased `{ field: other }` → value is a different identifier; skip.
      return t.isIdentifier(prop.value) && prop.value.name === fieldName ? fieldName : null;
    }
  }

  return null;
}

function collectArrayMapCandidates(ast: t.Node, element: t.JSXElement): TextCandidate[] {
  const ctx = findEnclosingMapCallback(ast, element);
  if (!ctx) return [];
  const fieldName = decodeMapPassthrough(element, ctx.fn.params[0]);
  if (!fieldName) return [];
  const elements = resolveArrayLiteralElements(ast, ctx.arrayArg);
  if (!elements) return [];
  const out: TextCandidate[] = [];
  for (const obj of elements) {
    const prop = findObjectProperty(obj, fieldName);
    if (!prop) continue;
    const v = prop.value;
    if (t.isStringLiteral(v)) {
      out.push({ current: v.value, splice: (s) => spliceRange(v, jsString(s)) });
    } else if (t.isNumericLiteral(v)) {
      out.push({ current: String(v.value), splice: (s) => spliceRange(v, jsString(s)) });
    }
  }
  return out;
}

function collectElementTextCandidates(ast: t.File, element: t.JSXElement): TextCandidate[] {
  const candidates: TextCandidate[] = [];
  collectTextCandidates(element, candidates);
  if (candidates.length === 0) {
    const passthrough = propPassthroughName(element);
    const enclosing = passthrough ? findEnclosingComponent(ast, element) : null;
    if (passthrough === 'children' && enclosing) {
      candidates.push(...collectCallSiteCandidates(ast, enclosing.name));
    } else if (passthrough && enclosing && componentDestructuresProp(enclosing.fn, passthrough)) {
      candidates.push(...collectPropCallSiteCandidates(ast, enclosing.name, passthrough));
    }
  }
  if (candidates.length === 0) {
    candidates.push(...collectArrayMapCandidates(ast, element));
  }
  return candidates;
}

function elementTextCandidateMatches(
  ast: t.File,
  element: t.JSXElement,
  prevText: string,
): boolean {
  const norm = prevText.trim();
  return collectElementTextCandidates(ast, element).some((candidate) => candidate.current === norm);
}

function hasDynamicText(element: t.JSXElement): boolean {
  return element.children.some(
    (child) =>
      t.isJSXExpressionContainer(child) &&
      !t.isJSXEmptyExpression(child.expression) &&
      !t.isStringLiteral(child.expression) &&
      !t.isNumericLiteral(child.expression),
  );
}

// The element's text for one way its component is called: its own literals
// plus the props that call passes. Null when a child is neither.
function forwardedTextParts(
  element: t.JSXElement,
  binding: Map<string, ForwardedLeaf>,
): TextRangePart[] | null {
  const out: TextRangePart[] = [];
  for (const child of element.children) {
    const literal = literalTextPart(child, element);
    if (literal !== undefined) {
      if (literal) out.push(literal);
    } else if (isJsxBrElement(child)) {
      out.push({ node: child, current: '\n' });
    } else if (t.isJSXExpressionContainer(child) && t.isJSXEmptyExpression(child.expression)) {
      // `{/* comment */}` renders nothing.
    } else if (t.isJSXExpressionContainer(child) && t.isIdentifier(child.expression)) {
      const leaf = binding.get(child.expression.name);
      if (!leaf) return null;
      if (!leaf.current) continue;
      out.push({
        ...leaf,
        parent: element,
        raw: leaf.current,
        offsets: Array.from({ length: leaf.current.length }, (_, i) => i),
      });
    } else {
      return null;
    }
  }
  return normalizeTextRangeParts(out);
}

// `<p>{organ} {desc}</p>` inside a component: every call renders its own
// mix of the element's literals and the props it passes. Find the one call
// that renders `prevText` and rewrite what the edit touches there.
function buildForwardedTextSplices(
  ast: t.File,
  element: t.JSXElement,
  value: string,
  prevText: string,
): Splice[] | { error: string } | null {
  if (value.includes('\n')) return null;
  const names = new Set<string>();
  for (const child of element.children) {
    if (t.isJSXExpressionContainer(child) && t.isIdentifier(child.expression)) {
      names.add(child.expression.name);
    }
  }
  const enclosing = names.size > 0 ? findEnclosingComponent(ast, element) : null;
  const props = [...names];
  if (
    !enclosing ||
    !props.every((n) => n === 'children' || componentDestructuresProp(enclosing.fn, n))
  ) {
    return null;
  }
  const rendered = resolveForwardedProps(ast, enclosing.name, props).flatMap((binding) => {
    const parts = forwardedTextParts(element, binding);
    return parts ? [parts] : [];
  });
  if (rendered.length === 0) return null;
  const matches = rendered.filter((parts) =>
    textMatchesExpected(textRangeContent(parts), prevText),
  );
  if (matches.length === 0) return { error: 'no text candidate matches the current value' };
  if (matches.length > 1) {
    return { error: 'multiple text candidates share the same value; cannot disambiguate' };
  }
  const parts = matches[0];
  const diff = textDiff(textRangeContent(parts), value);
  if (diff.start === diff.end && diff.value === '') return [];
  const splices = buildTextRangeReplaceSplices(parts, diff.start, diff.end, diff.value);
  return 'error' in splices ? null : splices;
}

function buildTextSplice(
  ast: t.File,
  element: t.JSXElement,
  value: string,
  prevText?: string,
): Splice | { error: string } {
  const candidates = collectElementTextCandidates(ast, element);
  if (candidates.length === 0) {
    return { error: 'element has no editable text' };
  }
  if (candidates.length === 1) {
    // `<p>主治：{desc}</p>`: the one literal is not the whole text, so
    // writing the value over it would duplicate the dynamic part.
    if (
      prevText !== undefined &&
      hasDynamicText(element) &&
      candidates[0].current !== prevText.trim()
    ) {
      return { error: 'no text candidate matches the current value' };
    }
    return candidates[0].splice(value);
  }
  if (prevText === undefined) {
    return { error: 'element has multiple text candidates; missing prevText' };
  }
  // Trim: JSX collapses surrounding whitespace at render time, so the
  // DOM `prevText` won't have leading/trailing space the source might.
  const norm = prevText.trim();
  const matches = candidates.filter((c) => c.current === norm);
  if (matches.length === 0) {
    return { error: 'no text candidate matches the current value' };
  }
  if (matches.length > 1) {
    return { error: 'multiple text candidates share the same value; cannot disambiguate' };
  }
  return matches[0].splice(value);
}

type AssetEditPlan = {
  importSplice: Splice | null;
  attrSplice: Splice;
};

function planAssetImport(
  ast: t.File,
  assetPath: string,
): { identifier: string; importSplice: Splice | null } {
  const imports = findImports(ast);
  for (const imp of imports) {
    if (imp.source === assetPath && imp.defaultIdent) {
      return { identifier: imp.defaultIdent, importSplice: null };
    }
  }
  const filename = assetPath.slice(assetPath.lastIndexOf('/') + 1);
  const identifier = safeAssetIdentifier(filename, collectTopLevelIdentifiers(ast));
  const importStmt = `import ${identifier} from '${assetPath.replace(/'/g, "\\'")}';\n`;
  const last = imports[imports.length - 1];
  const insertAt = last ? (last.node.end ?? 0) : 0;
  const prefix = last ? '\n' : '';
  return { identifier, importSplice: { from: insertAt, to: insertAt, text: prefix + importStmt } };
}

function planAssetAttr(
  ast: t.File,
  element: t.JSXElement,
  attr: string,
  assetPath: string,
): AssetEditPlan | { error: string } {
  if (!attr || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(attr)) return { error: 'invalid attribute name' };
  if (!assetPath.startsWith('./assets/') && !assetPath.startsWith('@assets/')) {
    return { error: 'asset path must start with ./assets/ or @assets/' };
  }

  const { identifier, importSplice } = planAssetImport(ast, assetPath);
  const opening = element.openingElement;
  const newAttr = `${attr}={${identifier}}`;
  const existing = findJsxAttr(opening, attr);
  const attrSplice: Splice = existing
    ? { from: existing.start ?? 0, to: existing.end ?? 0, text: newAttr }
    : { from: opening.name.end ?? 0, to: opening.name.end ?? 0, text: ` ${newAttr}` };
  return { importSplice, attrSplice };
}

type PlaceholderEditPlan = {
  importSplice: Splice | null;
  elementSplice: Splice;
};

function planReplacePlaceholder(
  ast: t.File,
  element: t.JSXElement,
  assetPath: string,
): PlaceholderEditPlan | { error: string } {
  const opening = element.openingElement;
  if (!t.isJSXIdentifier(opening.name) || opening.name.name !== 'ImagePlaceholder') {
    return { error: 'not a placeholder' };
  }
  if (!assetPath.startsWith('./assets/') && !assetPath.startsWith('@assets/')) {
    return { error: 'asset path must start with ./assets/ or @assets/' };
  }

  const hint = readJsxStringAttr(opening, 'hint') ?? '';
  const width = readJsxNumberAttr(opening, 'width');
  const height = readJsxNumberAttr(opening, 'height');

  const { identifier, importSplice } = planAssetImport(ast, assetPath);

  const styleParts: string[] = [];
  if (width != null) styleParts.push(`width: ${width}`);
  else if (height != null) styleParts.push(`width: '100%'`);
  if (height != null) styleParts.push(`height: ${height}`);
  else if (width != null) styleParts.push(`height: '100%'`);
  styleParts.push(`objectFit: 'cover'`);
  styleParts.push(`objectPosition: '50% 50%'`);
  const replacement =
    `<img src={${identifier}} alt=${jsString(hint)} ` + `style={{ ${styleParts.join(', ')} }} />`;

  return { importSplice, elementSplice: spliceRange(element, replacement) };
}

export function applyEdit(
  source: string,
  line: number,
  column: number,
  ops: EditOp[],
): ApplyEditResult {
  const plan = planEdit(source, line, column, ops);
  if (!plan.ok) return plan;
  return plan.splices.length ? applySplices(source, plan.splices) : { ok: true, source };
}

export function planEdit(
  source: string,
  line: number,
  column: number,
  ops: EditOp[],
  exactLocation = false,
): { ok: true; splices: Splice[] } | { ok: false; status: number; error: string } {
  if (ops.length === 0) return { ok: true, splices: [] };

  const ast = parseSource(source);
  if (!ast) return { ok: false, status: 422, error: 'could not parse source' };
  const element = exactLocation
    ? findJsxByStart(ast, line, column)
    : findElementForEdit(ast, line, column, ops);
  if (!element) return { ok: false, status: 422, error: 'no JSX element at location' };

  const splices: Splice[] = [];

  const styleOps = ops.flatMap((op) =>
    op.kind === 'set-style' ? [{ key: op.key, value: op.value }] : [],
  );
  if (styleOps.length > 0) {
    const result = buildStyleSplice(source, element, styleOps);
    if (result && 'error' in result) {
      return { ok: false, status: 422, error: result.error };
    }
    if (result) splices.push(result);
  }

  for (const op of ops) {
    if (op.kind !== 'set-text-range-style') continue;
    const result = buildTextRangeStyleSplices(
      ast,
      source,
      element,
      op.start,
      op.end,
      { key: op.key, value: op.value },
      op.prevText,
    );
    if (result && 'error' in result) return { ok: false, status: 422, error: result.error };
    if (result) splices.push(...result);
  }

  for (const op of ops) {
    if (op.kind !== 'set-text') continue;
    if (op.prevText !== undefined && (op.value.includes('\n') || op.prevText.includes('\n'))) {
      const richResult = buildTextContentSplices(element, op.value, op.prevText);
      if (!('error' in richResult)) {
        splices.push(...richResult);
        continue;
      }
    }
    const result = buildTextSplice(ast, element, op.value, op.prevText);
    if ('error' in result) {
      if (op.prevText === undefined) return { ok: false, status: 422, error: result.error };
      const richResult = buildTextContentSplices(element, op.value, op.prevText);
      if ('error' in richResult) {
        const forwarded = buildForwardedTextSplices(ast, element, op.value, op.prevText);
        if (!forwarded) return { ok: false, status: 422, error: result.error };
        if ('error' in forwarded) return { ok: false, status: 422, error: forwarded.error };
        splices.push(...forwarded);
        continue;
      }
      splices.push(...richResult);
    } else {
      splices.push(result);
    }
  }

  const assetOps = ops.flatMap((op) => (op.kind === 'set-attr-asset' ? [op] : []));
  const placeholderOps = ops.flatMap((op) =>
    op.kind === 'replace-placeholder-with-image' ? [op] : [],
  );
  if (assetOps.length > 0 || placeholderOps.length > 0) {
    const importSplices: Splice[] = [];
    for (const op of assetOps) {
      const plan = planAssetAttr(ast, element, op.attr, op.assetPath);
      if ('error' in plan) return { ok: false, status: 422, error: plan.error };
      splices.push(plan.attrSplice);
      if (plan.importSplice) importSplices.push(plan.importSplice);
    }
    for (const op of placeholderOps) {
      const plan = planReplacePlaceholder(ast, element, op.assetPath);
      if ('error' in plan) return { ok: false, status: 422, error: plan.error };
      splices.push(plan.elementSplice);
      if (plan.importSplice) importSplices.push(plan.importSplice);
    }
    // Multiple new imports for the same edit must not overlap, but they
    // all anchor to the same offset (end of last existing import). When
    // applied in reverse-`from` order they would land at the same point,
    // so concat their text into a single splice to keep ordering stable.
    if (importSplices.length > 0) {
      const from = importSplices[0].from;
      const to = importSplices[0].to;
      const text = importSplices.map((s) => s.text).join('');
      splices.push({ from, to, text });
    }
  }

  return { ok: true, splices };
}
