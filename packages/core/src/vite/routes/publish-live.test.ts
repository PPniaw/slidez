import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiContext } from './context.ts';
import {
  currentLiveRoom,
  DEFAULT_LIVE_SERVER,
  deckTitle,
  deckUsesLive,
  ensureLiveRoom,
  liveServer,
  readLiveRooms,
  setLiveEnabled,
  setLiveOpen,
} from './publish-live.ts';

async function makeCtx(liveServerUrl?: string): Promise<ApiContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'open-slide-live-'));
  const slidesRoot = path.join(root, 'slides');
  await fs.mkdir(slidesRoot);
  // Keep the admin-key store out of the real home directory.
  process.env.OPEN_SLIDE_LIVE_HOME = path.join(root, 'home');
  return {
    userCwd: root,
    slidesDir: 'slides',
    slidesRoot,
    globalAssetsRoot: path.join(root, 'assets'),
    manifestPath: path.join(slidesRoot, '.folders.json'),
    coreVersion: '0.0.0',
    agentEnabled: false,
    liveServer: liveServerUrl,
    isAgentEditing: () => false,
  };
}

describe('publish live helpers', () => {
  const envBefore = process.env.OPEN_SLIDE_LIVE_SERVER;
  const homeBefore = process.env.OPEN_SLIDE_LIVE_HOME;
  afterEach(() => {
    if (envBefore === undefined) delete process.env.OPEN_SLIDE_LIVE_SERVER;
    else process.env.OPEN_SLIDE_LIVE_SERVER = envBefore;
    if (homeBefore === undefined) delete process.env.OPEN_SLIDE_LIVE_HOME;
    else process.env.OPEN_SLIDE_LIVE_HOME = homeBefore;
  });

  it('detects decks that import the live kit anywhere in their folder', async () => {
    const ctx = await makeCtx();
    await fs.mkdir(path.join(ctx.slidesRoot, 'plain'));
    await fs.writeFile(
      path.join(ctx.slidesRoot, 'plain', 'index.tsx'),
      "import '@open-slide/core';",
    );
    await fs.mkdir(path.join(ctx.slidesRoot, 'live', 'parts'), { recursive: true });
    await fs.writeFile(path.join(ctx.slidesRoot, 'live', 'index.tsx'), "import './parts/qa';");
    await fs.writeFile(
      path.join(ctx.slidesRoot, 'live', 'parts', 'qa.tsx'),
      "import { LiveQA } from '@open-slide/core/live';",
    );
    await expect(deckUsesLive(ctx, 'plain')).resolves.toBe(false);
    await expect(deckUsesLive(ctx, 'live')).resolves.toBe(true);
    await expect(deckUsesLive(ctx, 'missing')).resolves.toBe(false);
  });

  it('prefers the env override for the live server and trims slashes', async () => {
    const ctx = await makeCtx('https://live.example.com/');
    delete process.env.OPEN_SLIDE_LIVE_SERVER;
    expect(liveServer(ctx)).toBe('https://live.example.com');
    process.env.OPEN_SLIDE_LIVE_SERVER = 'http://127.0.0.1:8787';
    expect(liveServer(ctx)).toBe('http://127.0.0.1:8787');
  });

  it('falls back to the workshop service unless config turns it off', async () => {
    delete process.env.OPEN_SLIDE_LIVE_SERVER;
    expect(liveServer(await makeCtx())).toBe(DEFAULT_LIVE_SERVER);
    expect(liveServer(await makeCtx(''))).toBeNull();
  });

  it('ignores a stored room that belongs to another server', async () => {
    delete process.env.OPEN_SLIDE_LIVE_SERVER;
    const ctx = await makeCtx('https://live.example.com');
    await fs.writeFile(
      path.join(ctx.slidesRoot, '.live-rooms.json'),
      JSON.stringify({ deck: { server: 'http://127.0.0.1:8787', roomId: 'abc234' } }),
    );
    await expect(currentLiveRoom(ctx, 'deck')).resolves.toBeNull();
    process.env.OPEN_SLIDE_LIVE_SERVER = 'http://127.0.0.1:8787';
    await expect(currentLiveRoom(ctx, 'deck')).resolves.toMatchObject({ roomId: 'abc234' });
  });

  it('moves admin keys out of the project into the per-user store', async () => {
    delete process.env.OPEN_SLIDE_LIVE_SERVER;
    const ctx = await makeCtx('https://live.example.com');
    const legacy = path.join(ctx.slidesRoot, '.live-rooms.json');
    await fs.writeFile(
      legacy,
      JSON.stringify({
        deck: { server: 'https://live.example.com', roomId: 'abc234', adminKey: 'k' },
      }),
    );
    await expect(currentLiveRoom(ctx, 'deck')).resolves.toMatchObject({ adminKey: 'k' });
    await expect(fs.access(legacy)).rejects.toThrow();
    const store = JSON.parse(
      await fs.readFile(
        path.join(process.env.OPEN_SLIDE_LIVE_HOME ?? '', 'live-rooms.json'),
        'utf8',
      ),
    );
    expect(Object.values(store)).toEqual([{ deck: expect.objectContaining({ roomId: 'abc234' }) }]);
  });

  it('reads the deck title from meta, not from other title keys', async () => {
    const ctx = await makeCtx();
    await fs.mkdir(path.join(ctx.slidesRoot, 'deck'));
    await fs.writeFile(
      path.join(ctx.slidesRoot, 'deck', 'index.tsx'),
      "const STEPS = [{ title: '說出想法' }];\nexport const meta: SlideMeta = { title: '工作坊範例' };",
    );
    await expect(deckTitle(ctx, 'deck')).resolves.toBe('工作坊範例');
    await expect(deckTitle(ctx, 'missing')).resolves.toBe('missing');
  });

  it('needs a live server to open a room', async () => {
    delete process.env.OPEN_SLIDE_LIVE_SERVER;
    await expect(ensureLiveRoom(await makeCtx(''), 'deck', 'me')).rejects.toThrow('live.server');
  });

  it('opens a room without any code, reuses it, and tracks whether it is on', async () => {
    const bodies: unknown[] = [];
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        calls.push(`${req.url} ${req.headers.authorization ?? ''} ${raw}`);
        if (req.url?.endsWith('/open')) return res.end('{}');
        bodies.push(JSON.parse(raw));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ roomId: 'abc234', adminKey: 'k', joinUrl: 'http://x/j/abc234' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      delete process.env.OPEN_SLIDE_LIVE_SERVER;
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ctx = await makeCtx(url);
      await fs.mkdir(path.join(ctx.slidesRoot, 'deck'));
      await fs.writeFile(
        path.join(ctx.slidesRoot, 'deck', 'index.tsx'),
        "export const meta = { title: '我的簡報' };",
      );
      const room = await ensureLiveRoom(ctx, 'deck', '小明');
      expect(room).toMatchObject({ server: url, roomId: 'abc234', adminKey: 'k' });
      expect(bodies).toEqual([{ owner: '小明', title: '我的簡報', deck: 'deck' }]);
      await ensureLiveRoom(ctx, 'deck', '小明');
      expect(bodies).toHaveLength(1);

      expect((await readLiveRooms(ctx)).deck.enabled).toBeUndefined();
      await setLiveEnabled(ctx, 'deck', true);
      expect((await readLiveRooms(ctx)).deck.enabled).toBe(true);
      await setLiveEnabled(ctx, 'deck', false);
      expect((await readLiveRooms(ctx)).deck.enabled).toBe(false);

      await setLiveOpen(ctx, 'deck', false);
      expect(calls.at(-1)).toBe('/api/rooms/abc234/open Bearer k {"open":false}');
      await setLiveOpen(ctx, 'deck', true);
      expect(calls.at(-1)).toBe('/api/rooms/abc234/open Bearer k {"open":true,"title":"我的簡報"}');
    } finally {
      server.close();
    }
  });
});
