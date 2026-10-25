import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Connect, ViteDevServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourceRev } from '../../editing/source-rev.ts';
import { makeContext } from './context.ts';
import { registerEditRoutes } from './edit.ts';

const SOURCE = [
  'export default [',
  '  () => (',
  '    <div>',
  '      <h1>Hello</h1>',
  '    </div>',
  '  ),',
  '];',
  '',
].join('\n');

const RENAME = { line: 4, column: 6, ops: [{ kind: 'set-text', value: 'Hi', prevText: 'Hello' }] };

describe('edit routes', () => {
  let root: string;
  let file: string;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'open-slide-edit-'));
    file = path.join(root, 'slides', 'deck', 'index.tsx');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, SOURCE);

    // Only the middleware mount is used: strip its prefix as connect would.
    let handler: Connect.NextHandleFunction | null = null;
    const vite = {
      middlewares: {
        use: (_prefix: string, fn: Connect.NextHandleFunction) => {
          handler = fn;
        },
      },
    } as unknown as ViteDevServer;
    registerEditRoutes(vite, makeContext({ userCwd: root, coreVersion: '0', agentEnabled: false }));
    server = http.createServer((req, res) => {
      req.url = (req.url ?? '/').replace(/^\/__edit/, '') || '/';
      handler?.(req as Connect.IncomingMessage, res, () => {
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__edit`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const batch = (body: object) =>
    fetch(`${base}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slideId: 'deck', ...body }),
    });

  it('reports the revision of the slide source', async () => {
    const res = await fetch(`${base}/rev?slideId=deck`);
    expect(await res.json()).toEqual({ rev: sourceRev(SOURCE) });
    expect((await fetch(`${base}/rev?slideId=missing`)).status).toBe(404);
  });

  it('saves against the revision it was given and returns the new one', async () => {
    const res = await batch({ edits: [RENAME], baseRev: sourceRev(SOURCE) });
    const body = await res.json();
    const after = await fs.readFile(file, 'utf8');
    expect(body).toMatchObject({ ok: true, changed: true, results: [{ ok: true }] });
    expect(after).toContain('<h1>Hi</h1>');
    expect(body.rev).toBe(sourceRev(after));
  });

  it('refuses edits made against a file that has changed since', async () => {
    const changed = SOURCE.replace('    <div>\n', '    <div>\n      <h2>New</h2>\n');
    await fs.writeFile(file, changed);
    const res = await batch({ edits: [RENAME], baseRev: sourceRev(SOURCE) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'stale', rev: sourceRev(changed) });
    expect(await fs.readFile(file, 'utf8')).toBe(changed);
  });

  it('still saves without a revision, as older clients send', async () => {
    const res = await batch({ edits: [RENAME] });
    expect(await res.json()).toMatchObject({ ok: true, results: [{ ok: true }] });
  });
});
