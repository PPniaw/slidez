import { createHash } from 'node:crypto';

// A short content hash of a slide source. The inspector holds buffered edits
// against the revision it rendered; when the file has moved on (the agent,
// an editor, another tab), their line/column targets point at other code, so
// the save is refused instead of landing on the wrong element.
export function sourceRev(source: string): string {
  return createHash('sha1').update(source).digest('hex').slice(0, 16);
}
