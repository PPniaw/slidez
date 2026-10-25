import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLocale } from '@/lib/use-locale';

// "Report this" on an error toast. The dev server builds the report (it adds
// the slide source around failing lines) and forwards it to the live service;
// nothing is sent until the user confirms in this dialog.

export type ErrorReportRequest = {
  kind: string;
  /** The message the user saw. */
  summary: string;
  slideId?: string;
  failures?: Array<{ line?: number; column?: number; error?: string; ops?: unknown }>;
};

let request: ErrorReportRequest | null = null;
const listeners = new Set<() => void>();

function setRequest(next: ErrorReportRequest | null): void {
  request = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => request;

export function openErrorReport(next: ErrorReportRequest): void {
  setRequest(next);
}

const post = (route: string, body: ErrorReportRequest) =>
  fetch(`/__report/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Mounted once next to the toaster; dev only, since the dev server sends it. */
export function ErrorReportDialog() {
  const t = useLocale();
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [detail, setDetail] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setDetail(null);
    if (!current) return;
    let cancelled = false;
    post('preview', current)
      .then((res) => (res.ok ? (res.json() as Promise<{ summary: string; detail: string }>) : null))
      .then((report) => {
        if (!cancelled) setDetail(report ? `${report.summary}\n\n${report.detail}` : '');
      })
      .catch(() => {
        if (!cancelled) setDetail('');
      });
    return () => {
      cancelled = true;
    };
  }, [current]);

  if (!current) return null;

  async function send() {
    if (!current) return;
    setSending(true);
    try {
      const res = await post('send', current);
      if (res.ok) {
        toast.success(t.report.sent);
        setRequest(null);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(
        res.status === 429
          ? t.report.tooMany
          : res.status === 502 || res.status === 503
            ? t.report.unreachable
            : `${t.report.failed} ${body.error ?? res.status}`,
      );
    } catch {
      toast.error(t.report.unreachable);
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !sending && setRequest(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.report.title}</DialogTitle>
          <DialogDescription>{t.report.description}</DialogDescription>
        </DialogHeader>
        <details className="min-w-0 text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t.report.showDetails}</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-2 font-mono text-xs">
            {detail === null ? t.common.loading : detail || t.report.previewFailed}
          </pre>
        </details>
        <DialogFooter>
          <Button variant="outline" disabled={sending} onClick={() => setRequest(null)}>
            {t.common.cancel}
          </Button>
          <Button disabled={sending} onClick={send}>
            {sending ? t.report.sending : t.report.send}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
