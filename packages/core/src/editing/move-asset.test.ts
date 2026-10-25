import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findMentions, moveAsset, rewriteAssetImports } from './move-asset.ts';

describe('rewriteAssetImports', () => {
  it('rewrites the matching import and keeps its quote and query', () => {
    const src = [
      'import a from "./assets/a.png";',
      "import aUrl from './assets/a.png?url';",
      "import b from './assets/b.png';",
      "export { default as c } from './assets/a.png';",
      '',
    ].join('\n');
    const out = rewriteAssetImports(src, (s) => s === './assets/a.png', '@assets/a.png');
    expect(out.ok && out.count).toBe(3);
    expect(out.ok && out.source).toBe(
      [
        'import a from "@assets/a.png";',
        "import aUrl from '@assets/a.png?url';",
        "import b from './assets/b.png';",
        "export { default as c } from '@assets/a.png';",
        '',
      ].join('\n'),
    );
  });

  it('refuses source it cannot parse', () => {
    expect(rewriteAssetImports('import x from', () => true, 'y').ok).toBe(false);
  });
});

describe('findMentions', () => {
  it('reports lines outside the skipped ranges', () => {
    const src =
      "import a from './assets/a.png';\nconst u = new URL('./assets/a.png', import.meta.url);\n";
    const skip: Array<[number, number]> = [[14, 30]];
    expect(findMentions(src, /assets\/a\.png/, skip)).toEqual([
      { line: 2, snippet: "const u = new URL('./assets/a.png', import.meta.url);" },
    ]);
  });
});

describe('moveAsset', () => {
  let root: string;
  let slidesRoot: string;
  let globalAssetsRoot: string;
  let busy: Set<string>;

  const write = async (rel: string, text: string | Buffer) => {
    const file = path.join(root, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');
  const exists = (rel: string) =>
    fs.access(path.join(root, rel)).then(
      () => true,
      () => false,
    );
  const move = (from: string, name: string, to: string, targetName?: string) =>
    moveAsset({
      slidesRoot,
      globalAssetsRoot,
      from,
      name,
      to,
      targetName,
      isAgentEditing: (id) => busy.has(id),
    });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'move-asset-'));
    slidesRoot = path.join(root, 'slides');
    globalAssetsRoot = path.join(root, 'assets');
    busy = new Set();
    await write('slides/deck/assets/a.png', 'A');
    await write(
      'slides/deck/index.tsx',
      "import a from './assets/a.png';\nexport default [() => <img src={a} />];\n",
    );
    await write(
      'slides/deck/parts/hero.tsx',
      "import aUrl from '../assets/a.png?url';\nexport const hero = aUrl;\n",
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('moves a deck asset to the shared folder and rewrites every import', async () => {
    const result = await move('deck', 'a.png', '@global');
    expect(result).toMatchObject({
      ok: true,
      name: 'a.png',
      importPath: '@assets/a.png',
      deduped: false,
      rewritten: [
        { file: path.join('deck', 'index.tsx'), count: 1 },
        { file: path.join('deck', 'parts', 'hero.tsx'), count: 1 },
      ],
    });
    expect(await read('assets/a.png')).toBe('A');
    expect(await exists('slides/deck/assets/a.png')).toBe(false);
    expect(await read('slides/deck/index.tsx')).toContain("from '@assets/a.png'");
    expect(await read('slides/deck/parts/hero.tsx')).toContain("from '@assets/a.png?url'");
  });

  it('moves it back, with paths relative to each file', async () => {
    await move('deck', 'a.png', '@global');
    const back = await move('@global', 'a.png', 'deck');
    expect(back).toMatchObject({ ok: true, importPath: './assets/a.png' });
    expect(await read('slides/deck/assets/a.png')).toBe('A');
    expect(await exists('assets/a.png')).toBe(false);
    expect(await read('slides/deck/index.tsx')).toContain("from './assets/a.png'");
    expect(await read('slides/deck/parts/hero.tsx')).toContain("from '../assets/a.png?url'");
  });

  it('refuses a reference it cannot rewrite and changes nothing', async () => {
    await write(
      'slides/deck/index.tsx',
      "const a = new URL('./assets/a.png', import.meta.url).href;\nexport default [];\n",
    );
    const result = await move('deck', 'a.png', '@global');
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      error: 'unsupported-reference',
      locations: [{ file: path.join('deck', 'index.tsx'), line: 1 }],
    });
    expect(await exists('slides/deck/assets/a.png')).toBe(true);
    expect(await exists('assets/a.png')).toBe(false);
    expect(await read('slides/deck/parts/hero.tsx')).toContain("'../assets/a.png?url'");
  });

  it('offers a free name when the shared folder holds a different file of that name', async () => {
    await write('assets/A.PNG', 'other');
    const result = await move('deck', 'a.png', '@global');
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: 'conflict',
      existing: 'A.PNG',
      suggestedName: 'a-2.png',
    });
    expect(await exists('slides/deck/assets/a.png')).toBe(true);

    const renamed = await move('deck', 'a.png', '@global', 'a-2.png');
    expect(renamed).toMatchObject({ ok: true, name: 'a-2.png', importPath: '@assets/a-2.png' });
    expect(await read('assets/a-2.png')).toBe('A');
    expect(await read('assets/A.PNG')).toBe('other');
    expect(await read('slides/deck/index.tsx')).toContain("from '@assets/a-2.png'");
  });

  it('reuses an identical shared file instead of copying', async () => {
    await write('assets/a.png', 'A');
    const result = await move('deck', 'a.png', '@global');
    expect(result).toMatchObject({ ok: true, deduped: true });
    expect(await exists('slides/deck/assets/a.png')).toBe(false);
    expect(await read('slides/deck/index.tsx')).toContain("from '@assets/a.png'");
  });

  it('refuses while another deck reaches into this one for the file', async () => {
    await write(
      'slides/other/index.tsx',
      "import a from '../deck/assets/a.png';\nexport default [];\n",
    );
    const result = await move('deck', 'a.png', '@global');
    expect(result).toMatchObject({
      ok: false,
      error: 'used-elsewhere',
      locations: [{ file: path.join('other', 'index.tsx'), line: 1 }],
    });
  });

  it('will not move a shared file back while another deck uses it', async () => {
    await move('deck', 'a.png', '@global');
    await write('slides/other/index.tsx', "import a from '@assets/a.png';\nexport default [];\n");
    const result = await move('@global', 'a.png', 'deck');
    expect(result).toMatchObject({ ok: false, error: 'used-elsewhere' });
    expect(await exists('assets/a.png')).toBe(true);
  });

  it('waits for an agent editing the deck', async () => {
    busy.add('deck');
    expect(await move('deck', 'a.png', '@global')).toMatchObject({
      ok: false,
      status: 409,
      error: 'agent-running',
    });
    expect(await exists('slides/deck/assets/a.png')).toBe(true);
  });

  it('rejects moves that do not cross between a deck and the shared folder', async () => {
    expect(await move('deck', 'a.png', 'other')).toMatchObject({ ok: false, status: 400 });
    expect(await move('deck', '../a.png', '@global')).toMatchObject({ ok: false, status: 400 });
    expect(await move('deck', 'missing.png', '@global')).toMatchObject({ ok: false, status: 404 });
  });
});
