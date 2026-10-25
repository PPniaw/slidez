import os from 'node:os';
import type { ViteDevServer } from 'vite';
import { validateMutationRequest } from '../../http/request-guard.ts';
import {
  type ApiContext,
  json,
  readBody,
  readSlideSource,
  resolveSlideEntryPath,
} from './context.ts';
import { liveServer } from './publish-live.ts';

// POST /__report/preview   buildReport(body) → { summary, detail }
// POST /__report/send      buildReport(body), forwarded to the live service's /api/reports
//
// Error reports the user chose to send from a failed save. The browser only
// says what failed; the excerpts of the slide source around the failing lines
// are read here, so the preview the user confirms is exactly what is sent.

export type ReportFailure = {
  line?: number;
  column?: number;
  error?: string;
  ops?: unknown;
};

export type ReportInput = {
  kind?: string;
  /** The message the user saw. */
  summary?: string;
  slideId?: string;
  failures?: ReportFailure[];
};

export type Report = { kind: string; version: string; summary: string; detail: string };

const CONTEXT_LINES = 6;
const MAX_FAILURES = 20;
const MAX_OPS_CHARS = 1_000;
const MAX_DETAIL_CHARS = 40_000;
const SEND_TIMEOUT_MS = 15_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function excerpt(lines: string[], line: number): string {
  const from = Math.max(1, line - CONTEXT_LINES);
  const to = Math.min(lines.length, line + CONTEXT_LINES);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    out.push(`${n === line ? '>' : ' '} ${String(n).padStart(width)} | ${lines[n - 1]}`);
  }
  return out.join('\n');
}

export async function buildReport(ctx: ApiContext, input: ReportInput): Promise<Report> {
  const kind = typeof input.kind === 'string' && input.kind ? input.kind.slice(0, 40) : 'error';
  const summary = typeof input.summary === 'string' ? input.summary.trim().slice(0, 500) : '';
  const version = `core ${ctx.coreVersion}`;
  const slideId = typeof input.slideId === 'string' ? input.slideId : '';
  const failures = Array.isArray(input.failures) ? input.failures.slice(0, MAX_FAILURES) : [];

  const file = slideId ? resolveSlideEntryPath(ctx, slideId) : null;
  const source = file ? await readSlideSource(file).catch(() => null) : null;
  const lines = source?.split('\n') ?? [];

  const parts = [
    `${version} · ${process.platform} ${process.arch} · node ${process.version} · ${os.release()}`,
  ];
  if (slideId)
    parts.push(
      `slide: ${slideId}${source === null ? ' (source not found)' : ` (${lines.length} lines)`}`,
    );
  failures.forEach((f, i) => {
    const line = Number.isInteger(f.line) && (f.line as number) > 0 ? (f.line as number) : 0;
    const where = line ? `line ${line}${f.column ? `:${f.column}` : ''}` : 'no location';
    const block = [
      `[${i + 1}] ${where} — ${typeof f.error === 'string' ? f.error : 'unknown error'}`,
    ];
    if (f.ops !== undefined) block.push(`ops: ${clip(JSON.stringify(f.ops), MAX_OPS_CHARS)}`);
    if (line && line <= lines.length) block.push(excerpt(lines, line));
    parts.push(block.join('\n'));
  });
  return { kind, version, summary, detail: clip(parts.join('\n\n'), MAX_DETAIL_CHARS) };
}

export function registerReportRoutes(server: ViteDevServer, ctx: ApiContext): void {
  server.middlewares.use('/__report', async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (req.method !== 'POST') return next();
    if (url.pathname !== '/preview' && url.pathname !== '/send') return next();
    const requestCheck = validateMutationRequest(req, { requireJsonBody: true });
    if (!requestCheck.ok) return json(res, requestCheck.status, { error: requestCheck.error });

    try {
      const report = await buildReport(ctx, (await readBody(req, 256_000)) as ReportInput);
      if (!report.summary) return json(res, 400, { error: 'missing summary' });
      if (url.pathname === '/preview') return json(res, 200, report);

      const target = liveServer(ctx);
      if (!target) return json(res, 503, { error: 'no report server configured' });
      let sent: Response;
      try {
        sent = await fetch(`${target}/api/reports`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        return json(res, 502, { error: 'unreachable' });
      }
      const data = (await sent.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!sent.ok) return json(res, sent.status, { error: data.error ?? `HTTP ${sent.status}` });
      return json(res, 200, { ok: true, id: data.id });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
