import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import { PUBLISHED_LABEL, resolveProjectName } from '../../cli/publish-names.ts';
import { isLoopbackRequest, validateMutationRequest } from '../../http/request-guard.ts';
import { type CliLoginJob, startCliLogin, tail } from '../cli-login.ts';
import { type ApiContext, json, readBody } from './context.ts';
import {
  currentLiveRoom,
  deckUsesLive,
  ensureLiveRoom,
  liveServer,
  setLiveEnabled,
  setLiveOpen,
} from './publish-live.ts';

// GET  /__publish/status?slideId=  → { vercel: { installed, loggedIn, user }, record }
// POST /__publish   { slideId, live?, owner? } → runs `open-slide publish <slideId>`, returns { record }
//                    `live` opens (or reuses) the deck's live room and bakes it into the build
// POST /__publish/unpublish  { slideId }  → deletes the Vercel project, returns { ok }
// GET  /__publish/live?slideId=           → { server, roomId } while live interaction is on
// GET  /__publish/live-admin?slideId=     → { server, roomId, adminKey } for the workspace panel
// GET  /__publish/list                    → { decks: { [slideId]: { url, publishedAt, live } } }
// POST /__publish/login  {}               → starts `vercel login`, returns { url, code } to confirm
//                    in the browser; the dialog then polls /status until the login lands
//
// The workshop fork's toolbar button drives these so nobody has to open a
// terminal. Deploys reuse the machine's Vercel CLI login.

const SLIDE_ID_RE = /^[a-z0-9_-]+$/i;
const PUBLISH_TIMEOUT_MS = 6 * 60 * 1000;
const STATUS_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_PROMPT_TIMEOUT_MS = 30_000;

export type PublishRecord = { project: string; url: string; publishedAt: string };
type Records = Record<string, PublishRecord>;
/** `output` is stdout and stderr as they arrived; `stdout` alone for parsing. */
type RunResult = { code: number; output: string; stdout: string };

// The dev server runs with NODE_ENV=development, and a child build that
// inherits it ships the editor UI (Agent, design, edit) to the public site.
function childEnv(): NodeJS.ProcessEnv {
  const { NODE_ENV: _devMode, ...env } = process.env;
  return env;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  input?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: childEnv(),
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    if (input !== undefined) child.stdin?.end(input);
    let output = '';
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} ${args[0] ?? ''} 超過時間仍未完成。`));
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      output += c.toString('utf8');
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      output += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, stdout });
    });
  });
}

export function parsePublishedUrl(output: string): string | null {
  const escaped = PUBLISHED_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return output.match(new RegExp(`${escaped}(https?://\\S+)`))?.[1] ?? null;
}

// `vercel whoami` prints the username on stdout; its banner, version line and
// update notice (a box of ─ that never wraps) go to stderr and must not be
// taken for the name.
export function parseVercelUser(stdout: string): string | null {
  const lines = stdout.split('\n').map((l) => l.trim());
  return lines.filter((l) => /^[\w.@-]{1,100}$/.test(l)).at(-1) ?? null;
}

// Without a terminal, newer Vercel CLIs (65.x) delete a project only with
// --yes and ignore an answer on stdin; older ones (54.x) have no --yes at all,
// refuse it as an unknown option, and take the answer on stdin instead.
export function rejectsYesFlag(output: string): boolean {
  return /unknown or unexpected option: --yes/.test(output);
}

async function removeProject(project: string, cwd: string): Promise<RunResult> {
  const timeoutMs = STATUS_TIMEOUT_MS * 3;
  const r = await run('vercel', ['project', 'rm', project, '--yes'], cwd, timeoutMs);
  if (!rejectsYesFlag(r.output)) return r;
  return run('vercel', ['project', 'rm', project], cwd, timeoutMs, 'y\n');
}

export type DeviceLogin = { url: string; code: string };

// `vercel login` without a terminal prints the device page and waits for it
// to be approved, e.g. "Visit https://vercel.com/oauth/device?user_code=ABCD-EFGH".
export function parseDeviceLogin(output: string): DeviceLogin | null {
  const m = output.match(/https:\/\/vercel\.com\/oauth\/device\?user_code=([A-Z0-9-]+)/);
  return m ? { url: m[0], code: m[1] } : null;
}

type LoginJob = CliLoginJob<DeviceLogin>;

// The child keeps running after the prompt is returned: it finishes the login
// itself once the code is approved, and /status picks that up.
function startLogin(cwd: string, onExit: () => void): LoginJob {
  const job = startCliLogin({
    cmd: 'vercel',
    args: ['login'],
    cwd,
    env: childEnv(),
    parse: parseDeviceLogin,
    timeoutMs: LOGIN_TIMEOUT_MS,
    promptTimeoutMs: LOGIN_PROMPT_TIMEOUT_MS,
    messages: {
      missing: '這台電腦還沒有安裝 Vercel CLI。',
      silent: 'Vercel 沒有回應登入要求。',
      ended: 'Vercel 登入沒有開始。',
    },
  });
  void job.done.then(onExit);
  return job;
}

function recordsPath(ctx: ApiContext): string {
  return path.join(ctx.slidesRoot, '.published.json');
}

async function readRecords(ctx: ApiContext): Promise<Records> {
  try {
    return JSON.parse(await readFile(recordsPath(ctx), 'utf8')) as Records;
  } catch {
    return {};
  }
}

async function writeRecords(ctx: ApiContext, records: Records): Promise<void> {
  await writeFile(recordsPath(ctx), `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

async function vercelStatus(cwd: string) {
  try {
    const r = await run('vercel', ['whoami'], cwd, STATUS_TIMEOUT_MS);
    const user = parseVercelUser(r.stdout);
    return { installed: true, loggedIn: r.code === 0, user: r.code === 0 ? user : null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { installed: false, loggedIn: false, user: null };
    }
    return { installed: true, loggedIn: false, user: null };
  }
}

// OPEN_SLIDE_BIN lets a host without a per-project install (the slidez
// desktop app) point at its own copy of the CLI.
function openSlideBin(cwd: string): string {
  if (process.env.OPEN_SLIDE_BIN) return process.env.OPEN_SLIDE_BIN;
  const bin = process.platform === 'win32' ? 'open-slide.cmd' : 'open-slide';
  return path.join(cwd, 'node_modules', '.bin', bin);
}

async function liveStatus(ctx: ApiContext, slideId: string) {
  const room = await currentLiveRoom(ctx, slideId);
  return {
    /** The deck has live blocks, so it can't be published without a room. */
    required: SLIDE_ID_RE.test(slideId) && (await deckUsesLive(ctx, slideId)),
    server: liveServer(ctx),
    enabled: Boolean(room?.enabled),
    joinUrl: room?.enabled ? room.joinUrl : null,
  };
}

// Closing is best-effort: the deck is already published or taken down, and a
// network hiccup shouldn't turn that into an error. The daily cleanup on the
// service removes forgotten rooms in the end.
async function closeRoomQuietly(ctx: ApiContext, slideId: string): Promise<void> {
  try {
    await setLiveOpen(ctx, slideId, false);
  } catch (err) {
    console.warn(`[open-slide] could not close the live room for ${slideId}:`, err);
  }
}

async function enabledRoom(ctx: ApiContext, slideId: string) {
  const room = await currentLiveRoom(ctx, slideId);
  return room?.enabled ? room : null;
}

export function registerPublishRoutes(server: ViteDevServer, ctx: ApiContext): void {
  let inFlight: Promise<unknown> | null = null;
  let login: LoginJob | null = null;
  server.httpServer?.on('close', () => login?.child.kill());

  server.middlewares.use('/__publish', async (req, res, next) => {
    if (!isLoopbackRequest(req)) return json(res, 403, { error: '只能在本機操作發布。' });
    const url = new URL(req.url ?? '/', 'http://local');
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && url.pathname === '/status') {
        const slideId = url.searchParams.get('slideId') ?? '';
        const records = await readRecords(ctx);
        res.setHeader('cache-control', 'no-store');
        return json(res, 200, {
          vercel: await vercelStatus(ctx.userCwd),
          record: records[slideId] ?? null,
          live: await liveStatus(ctx, slideId),
          busy: inFlight !== null,
        });
      }

      if (method === 'GET' && url.pathname === '/list') {
        const records = await readRecords(ctx);
        const decks: Record<string, { url: string; publishedAt: string; live: boolean }> = {};
        for (const [id, record] of Object.entries(records)) {
          decks[id] = {
            url: record.url,
            publishedAt: record.publishedAt,
            live: Boolean((await currentLiveRoom(ctx, id))?.enabled),
          };
        }
        res.setHeader('cache-control', 'no-store');
        return json(res, 200, { decks });
      }

      if (method === 'GET' && url.pathname === '/live') {
        const room = await enabledRoom(ctx, url.searchParams.get('slideId') ?? '');
        res.setHeader('cache-control', 'no-store');
        return json(res, 200, room ? { server: room.server, roomId: room.roomId } : {});
      }

      // Loopback-only like every route here, and without CORS headers, so only
      // the workspace itself can read the key.
      if (method === 'GET' && url.pathname === '/live-admin') {
        const room = await enabledRoom(ctx, url.searchParams.get('slideId') ?? '');
        res.setHeader('cache-control', 'no-store');
        if (!room) return json(res, 404, { error: '這份簡報沒有開啟現場互動。' });
        return json(res, 200, {
          server: room.server,
          roomId: room.roomId,
          adminKey: room.adminKey,
        });
      }

      if (method !== 'POST') return next();
      const guard = validateMutationRequest(req, { requireJsonBody: true });
      if (!guard.ok) return json(res, guard.status, { error: guard.error });

      if (url.pathname === '/login') {
        // Pressing the button again shows the same code while it is still valid.
        if (!login) {
          const job = startLogin(ctx.userCwd, () => {
            if (login === job) login = null;
          });
          login = job;
        }
        return json(res, 200, await login.prompt);
      }

      const body = (await readBody(req, 4096)) as {
        slideId?: unknown;
        live?: unknown;
        owner?: unknown;
      };
      const slideId = typeof body.slideId === 'string' ? body.slideId : '';
      if (!SLIDE_ID_RE.test(slideId)) return json(res, 400, { error: '簡報 id 不正確。' });
      if (inFlight) return json(res, 409, { error: '已經有一個發布或下架正在進行，請稍等。' });

      if (url.pathname === '/' || url.pathname === '') {
        const job = (async () => {
          const project = resolveProjectName([slideId]);
          const args = ['publish', slideId, '--project', project];
          const live = body.live === true || (await deckUsesLive(ctx, slideId));
          if (live) {
            const owner = typeof body.owner === 'string' ? body.owner.slice(0, 40) : '';
            const room = await ensureLiveRoom(ctx, slideId, owner);
            // Reopen before deploying, so the new site connects straight away.
            await setLiveOpen(ctx, slideId, true);
            args.push('--live-server', room.server, '--live-room', room.roomId);
          }
          const r = await run(openSlideBin(ctx.userCwd), args, ctx.userCwd, PUBLISH_TIMEOUT_MS);
          const published = parsePublishedUrl(r.output);
          if (r.code !== 0 || !published) {
            throw new Error(`發布失敗：\n${tail(r.output)}`);
          }
          const records = await readRecords(ctx);
          const record = { project, url: published, publishedAt: new Date().toISOString() };
          records[slideId] = record;
          await writeRecords(ctx, records);
          await setLiveEnabled(ctx, slideId, live);
          if (!live) await closeRoomQuietly(ctx, slideId);
          return record;
        })();
        inFlight = job.finally(() => {
          inFlight = null;
        });
        return json(res, 200, { record: await job });
      }

      if (url.pathname === '/unpublish') {
        const records = await readRecords(ctx);
        const record = records[slideId];
        if (!record) return json(res, 404, { error: '這份簡報目前沒有上線。' });
        const job = (async () => {
          // `project rm` can exit 0 and delete nothing, so confirm it is gone.
          const r = await removeProject(record.project, ctx.userCwd);
          const check = await run(
            'vercel',
            ['project', 'inspect', record.project],
            ctx.userCwd,
            STATUS_TIMEOUT_MS,
          );
          if (check.code === 0) {
            throw new Error(`下架失敗：Vercel 專案 ${record.project} 還在。\n${tail(r.output)}`);
          }
          delete records[slideId];
          await writeRecords(ctx, records);
          // The room is kept (closed) for a later publish with live interaction.
          await setLiveEnabled(ctx, slideId, false);
          await closeRoomQuietly(ctx, slideId);
          // Drop the old link too, so a later publish starts a fresh project.
          await rm(
            path.join(ctx.userCwd, 'node_modules', '.open-slide', 'publish', record.project),
            {
              recursive: true,
              force: true,
            },
          );
        })();
        inFlight = job.finally(() => {
          inFlight = null;
        });
        await job;
        return json(res, 200, { ok: true });
      }

      return next();
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
