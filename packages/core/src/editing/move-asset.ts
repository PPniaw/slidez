import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as t from '@babel/types';
import { GLOBAL_SCOPE, validateAssetName } from '../files/assets.ts';
import { parseSource } from './babel-walk.ts';
import { applySplices, type Splice } from './edit-ops.ts';
import { SLIDE_ID_RE } from './slide-ops.ts';

// Moving an asset between a deck's `assets/` and the shared folder rewrites
// the deck's imports with it. Only import declarations are rewritten: any
// other spelling (`new URL(...)`, CSS `url()`, a plain string) is reported
// and the move refused, since a guess there could break the deck unseen.

export type MentionLocation = { file: string; line: number; snippet: string };

export type MoveAssetResult =
  | {
      ok: true;
      name: string;
      to: string;
      importPath: string;
      deduped: boolean;
      rewritten: Array<{ file: string; count: number }>;
    }
  | { ok: false; status: 404 | 400; error: 'not-found' | 'invalid' }
  | { ok: false; status: 409; error: 'agent-running' }
  | { ok: false; status: 409; error: 'conflict'; existing: string; suggestedName: string }
  | {
      ok: false;
      status: 422;
      error: 'unsupported-reference' | 'used-elsewhere';
      locations: MentionLocation[];
    };

const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|css|mdx?|html)$/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripQuery(spec: string): { bare: string; query: string } {
  const at = spec.search(/[?#]/);
  return at < 0 ? { bare: spec, query: '' } : { bare: spec.slice(0, at), query: spec.slice(at) };
}

/**
 * Rewrites every import declaration (and re-export) whose specifier, query
 * left aside, `isTarget` accepts. The specifier's quote and query stay as
 * written, so `?url` keeps working and line numbers do not move.
 */
export function rewriteAssetImports(
  source: string,
  isTarget: (bareSpecifier: string) => boolean,
  replacement: string,
): { ok: true; source: string; count: number; ranges: Array<[number, number]> } | { ok: false } {
  const ast = parseSource(source);
  if (!ast) return { ok: false };
  const splices: Splice[] = [];
  const ranges: Array<[number, number]> = [];
  for (const node of ast.program.body) {
    const spec =
      t.isImportDeclaration(node) ||
      ((t.isExportNamedDeclaration(node) || t.isExportAllDeclaration(node)) && node.source)
        ? node.source
        : null;
    if (!spec || spec.start == null || spec.end == null) continue;
    const { bare, query } = stripQuery(spec.value);
    if (!isTarget(bare)) continue;
    const quote = source[spec.start] === '"' ? '"' : "'";
    splices.push({
      from: spec.start,
      to: spec.end,
      text: `${quote}${replacement}${query}${quote}`,
    });
    ranges.push([spec.start, spec.end]);
  }
  if (splices.length === 0) return { ok: true, source, count: 0, ranges };
  const applied = applySplices(source, splices);
  if (!applied.ok) return { ok: false };
  return { ok: true, source: applied.source, count: splices.length, ranges };
}

/** Every match of `pattern` in `source` outside `skip`, with its line. */
export function findMentions(
  source: string,
  pattern: RegExp,
  skip: Array<[number, number]> = [],
): Array<{ line: number; snippet: string }> {
  const out: Array<{ line: number; snippet: string }> = [];
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const at = m.index;
    if (skip.some(([from, to]) => at >= from && at < to)) continue;
    const lineStart = source.lastIndexOf('\n', at) + 1;
    const lineEnd = source.indexOf('\n', at);
    out.push({
      line: source.slice(0, at).split('\n').length,
      snippet: source
        .slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
        .trim()
        .slice(0, 160),
    });
  }
  return out;
}

/** `./assets/x` relative to a deck file, or `@assets/x` for the shared folder. */
function deckRelativeSpecifier(file: string, target: string): string {
  const rel = path.relative(path.dirname(file), target).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

async function listSourceFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { recursive: true })) as string[];
  } catch {
    return [];
  }
  return entries
    .filter((rel) => SOURCE_FILE_RE.test(rel))
    .filter(
      (rel) => !rel.split(path.sep).some((part) => part === 'node_modules' || part === 'assets'),
    )
    .map((rel) => path.join(dir, rel));
}

async function listDecks(slidesRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(slidesRoot, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && SLIDE_ID_RE.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

/** The existing entry whose name matches case-insensitively, as macOS would. */
async function findSameName(dir: string, name: string): Promise<string | null> {
  try {
    const lower = name.toLowerCase();
    return (await fs.readdir(dir)).find((entry) => entry.toLowerCase() === lower) ?? null;
  } catch {
    return null;
  }
}

async function freeName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!(await findSameName(dir, candidate))) return candidate;
  }
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
  return x.equals(y);
}

export type MoveAssetOptions = {
  slidesRoot: string;
  globalAssetsRoot: string;
  /** Where the file is now: a deck id or `@global`. */
  from: string;
  name: string;
  /** Where it goes: `@global`, or a deck id when it comes from `@global`. */
  to: string;
  /** The name to use at the destination, after a conflict. */
  targetName?: string;
  isAgentEditing: (slideId: string) => boolean;
};

export async function moveAsset(opts: MoveAssetOptions): Promise<MoveAssetResult> {
  const { slidesRoot, globalAssetsRoot, from, to } = opts;
  const toShared = to === GLOBAL_SCOPE;
  const deckId = toShared ? from : to;
  if (
    (from === GLOBAL_SCOPE) === toShared ||
    !SLIDE_ID_RE.test(deckId) ||
    !validateAssetName(opts.name)
  ) {
    return { ok: false, status: 400, error: 'invalid' };
  }
  const name = opts.name;
  const targetName = opts.targetName === undefined ? name : validateAssetName(opts.targetName);
  if (!targetName) return { ok: false, status: 400, error: 'invalid' };

  const deckDir = path.join(slidesRoot, deckId);
  const deckAssets = path.join(deckDir, 'assets');
  const srcDir = toShared ? deckAssets : globalAssetsRoot;
  const destDir = toShared ? globalAssetsRoot : deckAssets;
  const src = path.join(srcDir, name);
  const dest = path.join(destDir, targetName);
  try {
    if (!(await fs.stat(src)).isFile()) return { ok: false, status: 404, error: 'not-found' };
  } catch {
    return { ok: false, status: 404, error: 'not-found' };
  }

  if (opts.isAgentEditing(deckId)) return { ok: false, status: 409, error: 'agent-running' };

  // Another deck naming the file would break with the move: a deck asset
  // reached through `../<deck>/assets/`, or a shared one through `@assets/`.
  const elsewhere = toShared
    ? new RegExp(`${escapeRegExp(deckId)}/assets/${escapeRegExp(name)}(?![\\w.-])`)
    : new RegExp(`@assets/${escapeRegExp(name)}(?![\\w.-])`);
  const usedElsewhere: MentionLocation[] = [];
  for (const other of await listDecks(slidesRoot)) {
    if (other === deckId) continue;
    for (const file of await listSourceFiles(path.join(slidesRoot, other))) {
      const source = await fs.readFile(file, 'utf8');
      for (const hit of findMentions(source, elsewhere)) {
        usedElsewhere.push({ file: path.relative(slidesRoot, file), ...hit });
      }
    }
  }
  if (usedElsewhere.length > 0) {
    return { ok: false, status: 422, error: 'used-elsewhere', locations: usedElsewhere };
  }

  let deduped = false;
  const existing = await findSameName(destDir, targetName);
  if (existing) {
    if (existing !== targetName || !(await sameBytes(src, path.join(destDir, existing)))) {
      return {
        ok: false,
        status: 409,
        error: 'conflict',
        existing,
        suggestedName: await freeName(destDir, targetName),
      };
    }
    deduped = true;
  }

  // Plan every rewrite before touching a file, so a refusal leaves no trace.
  const mention = toShared
    ? new RegExp(`(?<!@)assets/${escapeRegExp(name)}(?![\\w.-])`)
    : new RegExp(`@assets/${escapeRegExp(name)}(?![\\w.-])`);
  const writes: Array<{ file: string; before: string; after: string; count: number }> = [];
  const unsupported: MentionLocation[] = [];
  for (const file of await listSourceFiles(deckDir)) {
    const before = await fs.readFile(file, 'utf8');
    if (!mention.test(before)) continue;
    const isCode = /\.[cm]?[jt]sx?$/.test(file);
    const replacement = toShared ? `@assets/${targetName}` : deckRelativeSpecifier(file, dest);
    const isTarget = (spec: string) =>
      toShared
        ? spec.startsWith('.') && path.resolve(path.dirname(file), spec) === src
        : spec === `@assets/${name}`;
    const rewritten = isCode ? rewriteAssetImports(before, isTarget, replacement) : null;
    const skip = rewritten?.ok ? rewritten.ranges : [];
    for (const hit of findMentions(before, mention, skip)) {
      unsupported.push({ file: path.relative(slidesRoot, file), ...hit });
    }
    if (rewritten?.ok && rewritten.count > 0) {
      writes.push({ file, before, after: rewritten.source, count: rewritten.count });
    }
  }
  if (unsupported.length > 0) {
    return { ok: false, status: 422, error: 'unsupported-reference', locations: unsupported };
  }

  // Copy, then rewrite, then remove: each step leaves every import pointing
  // at a file that exists, so the dev server never shows a broken deck.
  let copied = false;
  if (!deduped) {
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(src, dest, constants.COPYFILE_EXCL);
    copied = true;
  }
  const done: typeof writes = [];
  try {
    for (const w of writes) {
      await fs.writeFile(w.file, w.after);
      done.push(w);
    }
  } catch (err) {
    for (const w of done) await fs.writeFile(w.file, w.before).catch(() => {});
    if (copied) await fs.unlink(dest).catch(() => {});
    throw err;
  }
  // A copy left behind is harmless; nothing imports it any more.
  await fs.unlink(src).catch(() => {});

  return {
    ok: true,
    name: targetName,
    to,
    importPath: toShared ? `@assets/${targetName}` : `./assets/${targetName}`,
    deduped,
    rewritten: writes.map((w) => ({ file: path.relative(slidesRoot, w.file), count: w.count })),
  };
}
