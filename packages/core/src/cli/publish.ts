import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import fg from 'fast-glob';
import { mergeConfig, build as viteBuild } from 'vite';
import {
  type FoldersManifest,
  foldersManifestPath,
  readManifest,
  writeManifest,
} from '../files/folders.ts';
import { createViteConfig } from '../vite/config.ts';
import { stripNotes } from '../vite/notes-plugin.ts';
import { loadUserConfig } from '../vite/open-slide-plugin.ts';
import { PUBLISHED_LABEL, resolveProjectName } from './publish-names.ts';
import { createCliLogger, glyph, printHeader } from './ui.ts';

export { PUBLISHED_LABEL, resolveProjectName };

export interface PublishOptions {
  project?: string;
  deploy?: boolean;
  preview?: boolean;
  allowIndexing?: boolean;
  /** Live service and room id baked into the build for `@open-slide/core/live` blocks. */
  liveServer?: string;
  liveRoom?: string;
}

export async function listDecks(slidesAbs: string): Promise<string[]> {
  const hits = await fg('*/index.{tsx,jsx,ts,js}', { cwd: slidesAbs, onlyFiles: true });
  return [...new Set(hits.map((hit) => hit.split('/')[0]))].sort();
}

export function validateDeckIds(ids: string[], available: string[]): void {
  if (ids.length === 0) throw new Error('請至少指定一份簡報 id。');
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) throw new Error(`簡報 id 重複了：${[...new Set(dupes)].join(', ')}`);
  const missing = ids.filter((id) => !available.includes(id));
  if (missing.length > 0) {
    throw new Error(
      `找不到這些簡報：${missing.join(', ')}\n  可用的簡報 id：${available.join(', ') || '（沒有）'}`,
    );
  }
}

// Deck ids are kebab-case, so a match only counts when the characters around it
// can't continue an id; otherwise `pik-intro` would flag `pik-intro-public`.
export function findLeakedDecks(
  files: { name: string; text: string }[],
  excludedIds: string[],
): { id: string; file: string }[] {
  const leaks: { id: string; file: string }[] = [];
  for (const id of excludedIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`);
    const hit = files.find((f) => re.test(f.text));
    if (hit) leaks.push({ id, file: hit.name });
  }
  return leaks;
}

// Speaker notes are stripped from the staged decks before the build. Every
// module under a deck is checked, since a deck may keep its notes in a file of
// their own. A module that doesn't parse stops the publish rather than going
// up with its notes intact.
export async function stripStagedNotes(stagingSlides: string, ids: string[]): Promise<string[]> {
  const texts: string[] = [];
  for (const id of ids) {
    const files = await fg('**/*.{tsx,jsx,ts,js}', {
      cwd: path.join(stagingSlides, id),
      onlyFiles: true,
      absolute: true,
    });
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (!/\bnotes\b/.test(source)) continue;
      const stripped = stripNotes(source);
      if (!stripped) {
        throw new Error(
          `無法解析 ${path.relative(stagingSlides, file)}，沒辦法拿掉講稿，已中止發布。`,
        );
      }
      if (stripped.source !== source) await writeFile(file, stripped.source);
      texts.push(...stripped.texts);
    }
  }
  return texts;
}

// A note counts as leaked when a line of it shows up verbatim in the build.
// Short lines are skipped: a note that repeats a slide title would otherwise
// flag the slide itself. Lines with quotes or backslashes are escaped in the
// bundle, so they can't be matched as written.
export function findLeakedNotes(
  files: { name: string; text: string }[],
  notes: string[],
): { line: string; file: string }[] {
  const leaks: { line: string; file: string }[] = [];
  const lines = new Set(
    notes
      .flatMap((n) => n.split('\n'))
      .map((l) => l.trim())
      .filter((l) => l.length >= 20 && !/["'`\\]/.test(l)),
  );
  for (const line of lines) {
    const hit = files.find((f) => f.text.includes(line));
    if (hit) leaks.push({ line, file: hit.name });
  }
  return leaks;
}

// Folder names can be as private as deck names, so only keep the folders the
// published decks actually sit in.
export function filterFolders(manifest: FoldersManifest, ids: string[]): FoldersManifest {
  const assignments: Record<string, string> = {};
  for (const id of ids) {
    const folderId = manifest.assignments[id];
    if (folderId) assignments[id] = folderId;
  }
  const used = new Set(Object.values(assignments));
  return { folders: manifest.folders.filter((f) => used.has(f.id)), assignments };
}

// `entry` is the single published deck: the bare domain opens it directly,
// since audience builds have no deck list to land on.
export function vercelConfig(allowIndexing: boolean, entry?: string): Record<string, unknown> {
  return {
    ...(entry
      ? { redirects: [{ source: '/', destination: `/s/${entry}`, permanent: false }] }
      : {}),
    rewrites: [{ source: '/(.*)', destination: '/index.html' }],
    ...(allowIndexing
      ? {}
      : {
          headers: [
            { source: '/(.*)', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
          ],
        }),
  };
}

export function parseDeploymentUrl(output: string): string | null {
  return output.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/i)?.[0] ?? null;
}

// `vercel inspect` lists aliases under an "Aliases" heading; the first one is
// the production domain people should be given.
export function parseFirstAlias(output: string): string | null {
  const section = output.split(/\n\s*Aliases\s*\n/)[1];
  if (!section) return null;
  return section.match(/https:\/\/[a-z0-9.-]+/i)?.[0] ?? null;
}

function runVercel(
  args: string[],
  cwd: string,
  echo: boolean,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('vercel', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let output = '';
    const collect = (chunk: Buffer, sink: NodeJS.WriteStream) => {
      output += chunk.toString('utf8');
      if (echo) sink.write(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, process.stdout));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, process.stderr));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error('找不到 Vercel CLI。請先執行 `npm i -g vercel`，再執行 `vercel login` 登入。'),
        );
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

export async function publish(ids: string[], opts: PublishOptions = {}): Promise<void> {
  const userCwd = process.cwd();
  const config = await loadUserConfig(userCwd);
  const slidesAbs = path.resolve(userCwd, config.slidesDir ?? 'slides');
  const available = await listDecks(slidesAbs);
  validateDeckIds(ids, available);
  const project = resolveProjectName(ids, opts.project);
  if (Boolean(opts.liveRoom) !== Boolean(opts.liveServer)) {
    throw new Error('--live-room 和 --live-server 要一起指定。');
  }
  if (opts.liveRoom && ids.length !== 1) throw new Error('--live-room 一次只能用在一份簡報。');

  // Under node_modules so the staging copy never shows up as a workspace change.
  const workRoot = path.join(userCwd, 'node_modules', '.open-slide', 'publish');
  const stagingSlides = path.join(workRoot, `${project}.staging`, 'slides');
  const stagingThemes = path.join(workRoot, `${project}.staging`, 'themes');
  const buildDir = path.join(workRoot, `${project}.build`);
  // Vercel names a new project after the folder it deploys, and keeps the link
  // in its `.vercel/`, so this folder is reused across publishes.
  const deployDir = path.join(workRoot, project);

  await rm(path.dirname(stagingSlides), { recursive: true, force: true });
  await mkdir(stagingSlides, { recursive: true });
  await mkdir(stagingThemes, { recursive: true });
  for (const id of ids) {
    await cp(path.join(slidesAbs, id), path.join(stagingSlides, id), { recursive: true });
  }
  const notes = await stripStagedNotes(stagingSlides, ids);
  const manifest = await readManifest(foldersManifestPath(slidesAbs));
  await writeManifest(foldersManifestPath(stagingSlides), filterFolders(manifest, ids));

  printHeader(`publishing ${ids.join(', ')}`);
  // Vite builds in dev mode when NODE_ENV is already `development`, which would
  // put the editor UI on the public site. Publishing is always a production build.
  process.env.NODE_ENV = 'production';
  // Themes stay out: a brand theme can be as private as the decks left behind.
  const base = await createViteConfig({
    userCwd,
    mode: 'build',
    config: {
      ...config,
      slidesDir: stagingSlides,
      themesDir: stagingThemes,
      // The public link is for the audience: play only, no editor chrome or
      // downloads, and a deck list only when several decks go up together.
      build: { showSlideBrowser: ids.length > 1, showSlideUi: false, allowHtmlDownload: false },
      live:
        opts.liveRoom && opts.liveServer
          ? { server: opts.liveServer, rooms: { [ids[0]]: opts.liveRoom } }
          : undefined,
    },
  });
  await viteBuild(
    mergeConfig(base, {
      customLogger: createCliLogger(),
      build: { outDir: buildDir, emptyOutDir: true },
    }),
  );

  const excluded = available.filter((id) => !ids.includes(id));
  const outputs = await fg('**/*.{js,css,html}', { cwd: buildDir, onlyFiles: true });
  const files = await Promise.all(
    outputs.map(async (name) => ({
      name,
      text: await readFile(path.join(buildDir, name), 'utf8'),
    })),
  );
  const leaks = findLeakedDecks(files, excluded);
  if (leaks.length > 0) {
    const list = leaks.map((l) => `${l.id}（在 ${l.file}）`).join('\n    ');
    throw new Error(`打包結果裡出現了沒有指定的簡報，已中止發布：\n    ${list}`);
  }
  process.stdout.write(
    `  ${chalk.green('✔')} 打包結果只包含：${ids.join(', ')}（已檢查 ${excluded.length} 份未指定的簡報）\n`,
  );
  const leakedNotes = findLeakedNotes(files, notes);
  if (leakedNotes.length > 0) {
    const list = leakedNotes.map((l) => `「${l.line}」（在 ${l.file}）`).join('\n    ');
    throw new Error(`打包結果裡還有講稿，已中止發布：\n    ${list}`);
  }
  process.stdout.write(`  ${chalk.green('✔')} 已拿掉講稿，公開網址看不到\n`);

  await mkdir(deployDir, { recursive: true });
  for (const entry of await readdir(deployDir)) {
    if (entry !== '.vercel')
      await rm(path.join(deployDir, entry), { recursive: true, force: true });
  }
  await cp(buildDir, deployDir, { recursive: true });
  await writeFile(
    path.join(deployDir, 'vercel.json'),
    `${JSON.stringify(vercelConfig(opts.allowIndexing === true, ids.length === 1 ? ids[0] : undefined), null, 2)}\n`,
  );

  if (opts.deploy === false) {
    process.stdout.write(`  ${chalk.dim(glyph.bar)} 沒有部署。要上線的檔案在：${deployDir}\n\n`);
    return;
  }

  process.stdout.write(`  ${chalk.dim(glyph.bar)} 部署到 Vercel 專案：${chalk.bold(project)}\n\n`);
  const args = ['deploy', '--yes', ...(opts.preview ? [] : ['--prod'])];
  const deployed = await runVercel(args, deployDir, true);
  if (deployed.code !== 0) throw new Error(`vercel deploy 失敗（exit code ${deployed.code}）。`);
  const deploymentUrl = parseDeploymentUrl(deployed.output);
  let url = deploymentUrl;
  if (deploymentUrl && !opts.preview) {
    const inspected = await runVercel(['inspect', deploymentUrl], deployDir, false);
    url = parseFirstAlias(inspected.output) ?? deploymentUrl;
  }
  process.stdout.write(
    `\n  ${chalk.green('✔')} ${PUBLISHED_LABEL}${url ?? '（請到 Vercel 後台查看網址）'}\n\n`,
  );
}
