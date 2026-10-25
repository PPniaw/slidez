import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filterFolders,
  findLeakedDecks,
  findLeakedNotes,
  listDecks,
  parseDeploymentUrl,
  parseFirstAlias,
  resolveProjectName,
  stripStagedNotes,
  validateDeckIds,
  vercelConfig,
} from './publish.ts';

describe('publish helpers', () => {
  it('lists decks that have an index entry', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'open-slide-publish-'));
    await fs.mkdir(path.join(root, 'alpha'));
    await fs.writeFile(path.join(root, 'alpha', 'index.tsx'), '');
    await fs.mkdir(path.join(root, 'beta'));
    await fs.writeFile(path.join(root, 'beta', 'index.jsx'), '');
    await fs.mkdir(path.join(root, 'no-entry'));

    await expect(listDecks(root)).resolves.toEqual(['alpha', 'beta']);
  });

  it('rejects unknown, duplicate or missing deck ids', () => {
    expect(() => validateDeckIds([], ['a'])).toThrow('至少指定一份');
    expect(() => validateDeckIds(['a', 'a'], ['a'])).toThrow('重複');
    expect(() => validateDeckIds(['ghost'], ['a', 'b'])).toThrow('ghost');
    expect(() => validateDeckIds(['a', 'b'], ['a', 'b'])).not.toThrow();
  });

  it('names the project after a single deck and requires --project for several', () => {
    expect(resolveProjectName(['Waist-Fat-Week0'])).toBe('waist-fat-week0');
    expect(resolveProjectName(['a', 'b'], 'course-site')).toBe('course-site');
    expect(() => resolveProjectName(['a', 'b'])).toThrow('--project');
    expect(() => resolveProjectName(['a'], 'Bad Name')).toThrow('不合法');
    expect(() => resolveProjectName(['a'], 'a---b')).toThrow('不合法');
  });

  it('flags an excluded deck id only when it appears as a whole id', () => {
    const files = [
      { name: 'assets/index.js', text: 'const slides = {"pik-intro-public": () => import("x")};' },
      { name: 'assets/other.js', text: 'load(`private-plan`)' },
    ];
    expect(findLeakedDecks(files, ['pik-intro', 'private-plan', 'absent'])).toEqual([
      { id: 'private-plan', file: 'assets/other.js' },
    ]);
  });

  it('keeps only the folders the published decks sit in', () => {
    const manifest = {
      folders: [
        { id: 'f-00000001', name: 'Public', icon: { type: 'emoji' as const, value: '🚀' } },
        { id: 'f-00000002', name: 'Secret', icon: { type: 'emoji' as const, value: '🔒' } },
      ],
      assignments: { keep: 'f-00000001', hidden: 'f-00000002' },
    };
    expect(filterFolders(manifest, ['keep', 'loose'])).toEqual({
      folders: [manifest.folders[0]],
      assignments: { keep: 'f-00000001' },
    });
  });

  it('adds a noindex header unless indexing is allowed', () => {
    expect(vercelConfig(false)).toMatchObject({
      headers: [{ headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }],
    });
    expect(vercelConfig(true)).not.toHaveProperty('headers');
    expect(vercelConfig(true)).toHaveProperty('rewrites');
  });

  it('sends the bare domain to the deck when only one is published', () => {
    expect(vercelConfig(false, 'deck-a')).toMatchObject({
      redirects: [{ source: '/', destination: '/s/deck-a', permanent: false }],
    });
    expect(vercelConfig(false)).not.toHaveProperty('redirects');
  });

  it('reads the deployment url and the first production alias from vercel output', () => {
    const deploy = `{
  "deployment": { "url": "https://deck-4yk-team.vercel.app", "inspectorUrl": "https://vercel.com/team/deck/x" }
}`;
    expect(parseDeploymentUrl(deploy)).toBe('https://deck-4yk-team.vercel.app');
    expect(parseDeploymentUrl('no url here')).toBeNull();

    const inspect = `  General
    url\t\thttps://deck-4yk-team.vercel.app
  Aliases
    ╶ https://deck.vercel.app
    ╶ https://deck-team.vercel.app
  Builds`;
    expect(parseFirstAlias(inspect)).toBe('https://deck.vercel.app');
    expect(parseFirstAlias('  General\n')).toBeNull();
  });

  it('strips notes from every module of the staged decks only', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'open-slide-notes-'));
    await fs.mkdir(path.join(root, 'alpha', 'parts'), { recursive: true });
    await fs.mkdir(path.join(root, 'beta'));
    await fs.writeFile(
      path.join(root, 'alpha', 'index.tsx'),
      'export const notes = ["Alpha secret note"];\n',
    );
    await fs.writeFile(
      path.join(root, 'alpha', 'parts', 'notes.ts'),
      'export const notes = ["Kept in its own file"];\n',
    );
    await fs.writeFile(
      path.join(root, 'beta', 'index.tsx'),
      'export const notes = ["Beta stays"];\n',
    );

    await expect(stripStagedNotes(root, ['alpha'])).resolves.toEqual([
      'Alpha secret note',
      'Kept in its own file',
    ]);
    expect(await fs.readFile(path.join(root, 'alpha', 'index.tsx'), 'utf8')).toBe(
      'export const notes = [];\n',
    );
    expect(await fs.readFile(path.join(root, 'alpha', 'parts', 'notes.ts'), 'utf8')).toBe(
      'export const notes = [];\n',
    );
    expect(await fs.readFile(path.join(root, 'beta', 'index.tsx'), 'utf8')).toContain('Beta stays');

    await fs.writeFile(path.join(root, 'alpha', 'index.tsx'), 'export const notes = [');
    await expect(stripStagedNotes(root, ['alpha'])).rejects.toThrow('沒辦法拿掉講稿');
  });

  it('flags a long note line that survived into the build', () => {
    const files = [{ name: 'assets/deck.js', text: 'const a="Remember to thank the venue team";' }];
    expect(findLeakedNotes(files, ['Remember to thank the venue team\nshort'])).toEqual([
      { line: 'Remember to thank the venue team', file: 'assets/deck.js' },
    ]);
    expect(findLeakedNotes(files, ['Agenda', 'Remember to thank the cast'])).toEqual([]);
  });
});
