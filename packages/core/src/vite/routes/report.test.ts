import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Connect, ViteDevServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeContext } from './context.ts';
import { registerReportRoutes } from './report.ts';

const SOURCE = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');

const FAILURE = {
  line: 15,
  column: 4,
  error: 'element has no editable text',
  ops: [{ kind: 'set-text', value: 'B', prevText: 'A' }],
};

function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

describe('report routes', () => {
  let root: string;
  let app: http.Server;
  let live: http.Server;
  let base: string;
  let received: Array<Record<string, unknown>>;
  let liveStatus: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'open-slide-report-'));
    const file = path.join(root, 'slides', 'deck', 'index.tsx');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, SOURCE);

    received = [];
    liveStatus = 200;
    const liveServer = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        received.push({ path: req.url, ...JSON.parse(body) });
        res.statusCode = liveStatus;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify(liveStatus === 200 ? { id: 'r1' } : { error: '今天送出的回報太多了' }),
        );
      });
    });
    live = liveServer.server;

    // Only the middleware mount is used: strip its prefix as connect would.
    let handler: Connect.NextHandleFunction | null = null;
    const vite = {
      middlewares: {
        use: (_prefix: string, fn: Connect.NextHandleFunction) => {
          handler = fn;
        },
      },
    } as unknown as ViteDevServer;
    registerReportRoutes(
      vite,
      makeContext({
        userCwd: root,
        coreVersion: '9.9.9',
        agentEnabled: false,
        liveServer: liveServer.url,
      }),
    );
    const appServer = await listen((req, res) => {
      req.url = (req.url ?? '/').replace(/^\/__report/, '') || '/';
      handler?.(req as Connect.IncomingMessage, res, () => {
        res.statusCode = 404;
        res.end();
      });
    });
    app = appServer.server;
    base = `${appServer.url}/__report`;
  });

  afterEach(async () => {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => live.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const post = (route: string, body: object) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('previews the report with the source around each failing line', async () => {
    const res = await post('/preview', {
      kind: 'save-failed',
      summary: '儲存失敗',
      slideId: 'deck',
      failures: [FAILURE],
    });
    const report = await res.json();
    expect(report).toMatchObject({
      kind: 'save-failed',
      version: 'core 9.9.9',
      summary: '儲存失敗',
    });
    expect(report.detail).toContain('slide: deck (30 lines)');
    expect(report.detail).toContain('[1] line 15:4 — element has no editable text');
    expect(report.detail).toContain('"prevText":"A"');
    expect(report.detail).toContain('> 15 | const line15 = 15;');
    expect(report.detail).toContain('   9 | const line9 = 9;');
    expect(report.detail).toContain('  21 | const line21 = 21;');
    expect(report.detail).not.toContain('line8 =');
    expect(report.detail).not.toContain('line22 =');
    expect(received).toEqual([]);
  });

  it('sends exactly what the preview showed to the live service', async () => {
    const body = { kind: 'save-failed', summary: '儲存失敗', slideId: 'deck', failures: [FAILURE] };
    const preview = await (await post('/preview', body)).json();
    const res = await post('/send', body);
    expect(await res.json()).toEqual({ ok: true, id: 'r1' });
    expect(received).toEqual([{ path: '/api/reports', ...preview }]);
  });

  it('passes the service refusal back', async () => {
    liveStatus = 429;
    const res = await post('/send', { summary: '儲存失敗' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: '今天送出的回報太多了' });
  });

  it('refuses a report with nothing to say', async () => {
    expect((await post('/preview', { summary: '  ' })).status).toBe(400);
  });
});
