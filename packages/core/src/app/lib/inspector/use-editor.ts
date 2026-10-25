import { useCallback } from 'react';

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
  | { kind: 'set-attr-asset'; attr: string; assetPath: string; previewUrl: string }
  | { kind: 'replace-placeholder-with-image'; assetPath: string };

export type Edit = { line: number; column: number; ops: EditOp[]; dependsOn?: number };

export type EditResult = { ok: boolean; error?: string };

export class NoOpEditError extends Error {
  constructor() {
    super(
      'Edit completed but the source file did not change — the target JSX may already match, or the target element may not be directly editable here.',
    );
    this.name = 'NoOpEditError';
  }
}

// The slide file changed after the edits were buffered (the agent, an
// editor, another tab), so their line/column targets no longer hold.
export class StaleSourceError extends Error {
  constructor(readonly rev: string | null) {
    super('the slide source changed since these edits were made');
    this.name = 'StaleSourceError';
  }
}

export async function fetchSourceRev(slideId: string): Promise<string | null> {
  const res = await fetch(`/__edit/rev?slideId=${encodeURIComponent(slideId)}`).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { rev?: string };
  return body.rev ?? null;
}

export function useEditor(slideId: string) {
  const applyEdit = useCallback(
    async (line: number, column: number, ops: EditOp[]) => {
      const res = await fetch('/__edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slideId, line, column, ops }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; changed?: boolean };
      if (!res.ok) {
        throw new Error(body.error ?? `POST /__edit → ${res.status}`);
      }
      if (body.changed === false) {
        throw new NoOpEditError();
      }
    },
    [slideId],
  );

  // Batch many element edits into one file write and one HMR tick.
  // Returns one result per input edit so callers can keep failed
  // edits buffered while clearing the ones that landed, plus the
  // revision the file is at afterwards. With `baseRev`, a file that
  // has changed since is refused with `StaleSourceError`.
  const applyEdits = useCallback(
    async (
      edits: Edit[],
      baseRev?: string | null,
    ): Promise<{ results: EditResult[]; rev: string | null }> => {
      if (edits.length === 0) return { results: [], rev: null };
      const res = await fetch('/__edit/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slideId, edits, baseRev: baseRev ?? undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        results?: EditResult[];
        rev?: string;
      };
      if (res.status === 409 && body.error === 'stale')
        throw new StaleSourceError(body.rev ?? null);
      if (!res.ok) {
        throw new Error(body.error ?? `POST /__edit/batch → ${res.status}`);
      }
      return { results: body.results ?? [], rev: body.rev ?? null };
    },
    [slideId],
  );

  return { applyEdit, applyEdits };
}
