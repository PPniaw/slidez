import fs from 'node:fs/promises';
import path from 'node:path';
import * as t from '@babel/types';
import type { Plugin, ViteDevServer } from 'vite';
import { parseSource } from '../editing/babel-walk.ts';
import { resolveSlideEntry } from '../editing/slide-ops.ts';
import { validateMutationRequest } from '../http/request-guard.ts';
import { hasRecentWrite, recordWrite } from './recent-writes.ts';
import { json, readBody, readSlideSource } from './routes/context.ts';

type NotesBody = {
  slideId?: string;
  index?: number;
  text?: string;
};

export type ApplyNotesEditResult =
  | { ok: true; source: string }
  | { ok: false; status: number; error: string };

type NotesExport = {
  declStart: number;
  declEnd: number;
  arrayStart: number;
  arrayEnd: number;
  elements: Array<t.Expression | t.SpreadElement | null>;
};

function findNotesExport(ast: t.File): NotesExport | { error: string } | null {
  for (const stmt of ast.program.body) {
    if (!t.isExportNamedDeclaration(stmt)) continue;
    const decl = stmt.declaration;
    if (!decl || !t.isVariableDeclaration(decl)) continue;
    for (const d of decl.declarations) {
      if (!t.isVariableDeclarator(d)) continue;
      if (!t.isIdentifier(d.id) || d.id.name !== 'notes') continue;
      if (!d.init) return { error: '`notes` export has no initializer' };
      if (!t.isArrayExpression(d.init)) {
        return { error: '`notes` export is not an array literal' };
      }
      const arr = d.init;
      if (typeof stmt.start !== 'number' || typeof stmt.end !== 'number') {
        return { error: '`notes` export missing source range' };
      }
      if (typeof arr.start !== 'number' || typeof arr.end !== 'number') {
        return { error: '`notes` array missing source range' };
      }
      return {
        declStart: stmt.start,
        declEnd: stmt.end,
        arrayStart: arr.start,
        arrayEnd: arr.end,
        elements: arr.elements,
      };
    }
  }
  return null;
}

// Render a string as a TS literal. Prefer template literals for multi-line
// strings so the source stays readable; otherwise a JSON-quoted single-line
// string keeps escapes minimal.
export function renderNoteLiteral(text: string): string {
  if (text === '') return 'undefined';
  const hasNewline = /\n/.test(text);
  if (hasNewline) {
    const escaped = text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    return `\`${escaped}\``;
  }
  return JSON.stringify(text);
}

function findInsertionOffset(ast: t.File, source: string): number {
  let lastImportEnd = -1;
  for (const stmt of ast.program.body) {
    if (t.isImportDeclaration(stmt) && typeof stmt.end === 'number') {
      lastImportEnd = Math.max(lastImportEnd, stmt.end);
    }
  }
  if (lastImportEnd >= 0) return lastImportEnd;
  return source.length;
}

export function applyNotesEdit(source: string, index: number, text: string): ApplyNotesEditResult {
  if (!Number.isInteger(index) || index < 0) {
    return { ok: false, status: 400, error: 'invalid index' };
  }

  // Notes are spliced in by AST offset, so a tree recovered from a syntax
  // error must not reach the write.
  const ast = parseSource(source);
  if (!ast) return { ok: false, status: 422, error: 'could not parse source' };

  const found = findNotesExport(ast);
  if (found && 'error' in found) {
    return { ok: false, status: 422, error: found.error };
  }

  const literal = renderNoteLiteral(text);

  if (!found) {
    if (text === '') return { ok: true, source };

    const padding = Array.from({ length: index }, () => 'undefined');
    const items = [...padding, literal];
    const block = [
      '',
      '',
      'export const notes: (string | undefined)[] = [',
      ...items.map((s) => `  ${s},`),
      '];',
      '',
    ].join('\n');

    const offset = findInsertionOffset(ast, source);
    const next = source.slice(0, offset) + block + source.slice(offset);
    return { ok: true, source: next };
  }

  const elementTexts: string[] = [];
  for (const el of found.elements) {
    if (el === null) {
      elementTexts.push('undefined');
      continue;
    }
    if (typeof el.start !== 'number' || typeof el.end !== 'number') {
      return { ok: false, status: 422, error: '`notes` element missing source range' };
    }
    elementTexts.push(source.slice(el.start, el.end));
  }

  while (elementTexts.length <= index) elementTexts.push('undefined');
  elementTexts[index] = literal;

  while (elementTexts.length > 0 && elementTexts[elementTexts.length - 1] === 'undefined') {
    elementTexts.pop();
  }

  const replacement =
    elementTexts.length === 0 ? '[]' : `[\n${elementTexts.map((s) => `  ${s},`).join('\n')}\n]`;

  const next = source.slice(0, found.arrayStart) + replacement + source.slice(found.arrayEnd);
  return { ok: true, source: next };
}

export type StrippedNotes = { source: string; texts: string[] };

// Fork: published decks are public, and speaker notes are for the speaker.
// Empty every top-level binding the module exports as `notes` (directly or via
// `export { x as notes }`) so the build carries none of their text. The
// binding stays, as `[]`, in case the module reads it elsewhere. Returns the
// literal note texts too, so the caller can check the build for leftovers.
// Null when the source doesn't parse, so nothing half-edited gets built.
export function stripNotes(source: string): StrippedNotes | null {
  const ast = parseSource(source);
  if (!ast) return null;

  const exported = new Set<string>();
  for (const stmt of ast.program.body) {
    if (!t.isExportNamedDeclaration(stmt) || stmt.source) continue;
    if (t.isVariableDeclaration(stmt.declaration)) {
      for (const d of stmt.declaration.declarations) {
        if (t.isIdentifier(d.id) && d.id.name === 'notes') exported.add('notes');
      }
    }
    for (const spec of stmt.specifiers) {
      if (!t.isExportSpecifier(spec)) continue;
      const name = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
      if (name === 'notes') exported.add(spec.local.name);
    }
  }
  if (exported.size === 0) return { source, texts: [] };

  const ranges: { start: number; end: number }[] = [];
  const texts: string[] = [];
  for (const stmt of ast.program.body) {
    const decl = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
    if (!t.isVariableDeclaration(decl)) continue;
    for (const d of decl.declarations) {
      if (!t.isIdentifier(d.id) || !exported.has(d.id.name) || !d.init) continue;
      if (typeof d.init.start !== 'number' || typeof d.init.end !== 'number') continue;
      ranges.push({ start: d.init.start, end: d.init.end });
      if (!t.isArrayExpression(d.init)) continue;
      for (const el of d.init.elements) {
        if (t.isStringLiteral(el)) texts.push(el.value);
        else if (t.isTemplateLiteral(el) && el.expressions.length === 0) {
          texts.push(el.quasis.map((q) => q.value.cooked ?? q.value.raw).join(''));
        }
      }
    }
  }

  let next = source;
  for (const { start, end } of ranges.sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, start)}[]${next.slice(end)}`;
  }
  return { source: next, texts };
}

export type NotesPluginOptions = {
  userCwd: string;
  slidesDir?: string;
};

export function notesPlugin(opts: NotesPluginOptions): Plugin {
  const slidesRoot = path.resolve(opts.userCwd, opts.slidesDir ?? 'slides');

  return {
    name: 'open-slide:notes',
    apply: 'serve',
    handleHotUpdate(ctx) {
      // Suppress HMR for our own writes — RFR bails on the slide's mixed
      // exports and remounts the tree, stealing textarea focus mid-typing.
      if (hasRecentWrite(ctx.file)) return [];
      return undefined;
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/__notes', async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://local');
        const method = req.method ?? 'GET';
        if (method !== 'PUT' || url.pathname !== '/') return next();
        const requestCheck = validateMutationRequest(req, { requireJsonBody: true });
        if (!requestCheck.ok) return json(res, requestCheck.status, { error: requestCheck.error });

        try {
          const body = (await readBody(req)) as NotesBody;
          const slideId = body.slideId ?? '';
          const file = resolveSlideEntry(slidesRoot, slideId);
          if (!file) return json(res, 400, { error: 'invalid slideId' });
          if (typeof body.index !== 'number') return json(res, 400, { error: 'missing index' });
          if (typeof body.text !== 'string') return json(res, 400, { error: 'missing text' });

          const source = await readSlideSource(file);
          if (source === null) return json(res, 404, { error: 'slide not found' });

          const result = applyNotesEdit(source, body.index, body.text);
          if (!result.ok) return json(res, result.status, { error: result.error });
          const changed = result.source !== source;
          if (changed) {
            recordWrite(file);
            await fs.writeFile(file, result.source, 'utf8');
          }
          return json(res, 200, { ok: true, changed });
        } catch (err) {
          json(res, 500, { error: String((err as Error).message ?? err) });
        }
      });
    },
  };
}
