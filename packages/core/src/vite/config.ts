import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { InlineConfig, Plugin } from 'vite';
import { apiPlugin } from './api-plugin.ts';
import { currentPlugin } from './current-plugin.ts';
import { designPlugin } from './design-plugin.ts';
import { locTagsPlugin } from './loc-tags-plugin.ts';
import { notesPlugin } from './notes-plugin.ts';
import { loadUserConfig, type OpenSlideConfig, openSlidePlugin } from './open-slide-plugin.ts';
import { serverInfoPlugin } from './server-info-plugin.ts';
import { themesPlugin } from './themes-plugin.ts';

function findPackageRoot(fromFile: string): string {
  let dir = path.dirname(fromFile);
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`Could not find package.json walking up from ${fromFile}`);
}

const PKG_ROOT = findPackageRoot(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(PKG_ROOT, 'src', 'app');

function readCoreVersion(): string {
  try {
    const raw = readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const CORE_VERSION = readCoreVersion();

// styles.css pulls webfonts from core's own dependencies. Their real paths sit
// outside the app root — and, under pnpm or in a workspace, outside the user's
// project too — so Vite's fs guard would refuse to serve them.
const RUNTIME_ASSET_ROOTS = resolveRuntimeAssetRoots();

function resolveRuntimeAssetRoots(): string[] {
  const require = createRequire(import.meta.url);
  const roots: string[] = [];
  for (const pkg of ['@fontsource-variable/geist']) {
    try {
      roots.push(path.dirname(require.resolve(`${pkg}/package.json`)));
    } catch {}
  }
  return roots;
}

// Decks normally resolve `react` and `@open-slide/core` from the workspace's
// own node_modules. A workspace without one (the slidez desktop app keeps one
// shared copy for every project) falls back to resolving them from core's own
// install. Workspaces that have the package never reach the fallback.
function resolveFromCorePlugin(): Plugin {
  const anchor = path.join(APP_ROOT, 'main.tsx');
  return {
    name: 'open-slide:resolve-from-core',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // Real packages resolve their own imports; skip them. The publish
      // staging copy lives under node_modules/.open-slide but is deck code.
      const inPackage =
        importer?.includes(`${path.sep}node_modules${path.sep}`) &&
        !importer.includes(`${path.sep}node_modules${path.sep}.open-slide${path.sep}`);
      if (!importer || importer === anchor || inPackage) return null;
      if (/^[./\\\0]/.test(source) || source.includes(':')) return null;
      const own = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (own) return own;
      return this.resolve(source, anchor, { ...options, skipSelf: true });
    },
  };
}

export type CreateViteConfigOptions = {
  userCwd: string;
  config?: OpenSlideConfig;
  mode?: 'serve' | 'build';
};

export async function createViteConfig(opts: CreateViteConfigOptions): Promise<InlineConfig> {
  const userCwd = path.resolve(opts.userCwd);
  const config = opts.config ?? (await loadUserConfig(userCwd));
  const slidesDir = config.slidesDir ?? 'slides';
  const themesDir = config.themesDir ?? 'themes';
  const assetsDir = config.assetsDir ?? 'assets';
  const slidesAbs = path.resolve(userCwd, slidesDir);
  const themesAbs = path.resolve(userCwd, themesDir);
  const assetsAbs = path.resolve(userCwd, assetsDir);

  return {
    base: config.base ?? '/',
    root: APP_ROOT,
    // Fork: keep Vite's dep cache in the workspace. Its default sits next to
    // APP_ROOT inside the installed package, which is read-only in a signed
    // desktop app or a root-owned global install, and the page stays blank.
    cacheDir: path.join(userCwd, 'node_modules', '.open-slide', 'vite'),
    configFile: false,
    envDir: userCwd,
    plugins: [
      resolveFromCorePlugin(),
      locTagsPlugin({ userCwd, slidesDir }),
      react(),
      tailwindcss(),
      openSlidePlugin({ userCwd, config, coreVersion: CORE_VERSION }),
      themesPlugin({ userCwd, config }),
      designPlugin({ userCwd }),
      apiPlugin({
        userCwd,
        slidesDir,
        assetsDir,
        coreVersion: CORE_VERSION,
        agentEnabled: config.agent?.enabled ?? true,
        liveServer: config.live?.server,
      }),
      notesPlugin({ userCwd, slidesDir }),
      currentPlugin({ userCwd, slidesDir }),
      serverInfoPlugin({ userCwd }),
    ],
    resolve: {
      alias: {
        '@': APP_ROOT,
        '@assets': assetsAbs,
      },
      // A workspace that still declares its own react (e.g. scaffolded before
      // v2) would otherwise load two copies — core's and the workspace's —
      // which crashes the production bundle with React error #525.
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      entries: [path.join(APP_ROOT, 'main.tsx')],
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'next-themes',
        'react-router-dom',
        '@base-ui/react',
        // @base-ui/utils reaches for the CommonJS use-sync-external-store shim
        // (React 17 fallback). Left un-optimized, its named `useSyncExternalStore`
        // export fails ESM interop in the browser — pre-bundle it to fix that.
        // (@base-ui/utils itself has no "." export, so we can't list it here.)
        'use-sync-external-store/shim',
        'use-sync-external-store/shim/with-selector',
        'lucide-react',
        'clsx',
        'tailwind-merge',
        'class-variance-authority',
        'emoji-picker-react',
      ],
      // The app source ships inside node_modules/@open-slide/core/src/app, so
      // Vite's dep scanner traverses it as if it were a third-party dep and
      // tries to bundle our virtual imports. Mark them external.
      rolldownOptions: {
        plugins: [
          {
            name: 'open-slide:virtual-externals',
            resolveId(id) {
              return id.startsWith('virtual:open-slide/') ? { id, external: true } : null;
            },
          },
        ],
      },
    },
    server: {
      port: config.port ?? 5173,
      ...(config.allowedHosts !== undefined ? { allowedHosts: config.allowedHosts } : {}),
      fs: { allow: [APP_ROOT, ...RUNTIME_ASSET_ROOTS, userCwd, slidesAbs, themesAbs, assetsAbs] },
    },
    build: {
      outDir: path.resolve(userCwd, 'dist'),
      emptyOutDir: true,
    },
  };
}
