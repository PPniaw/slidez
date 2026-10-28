import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { claudeConfigDir, cliEnv } from './accounts.ts';
import type { AgentAuth, AgentProviderId } from './types.ts';

const STATUS_TIMEOUT_MS = 8000;
// Asking a CLI takes ~0.5–1.5 s, and the panel polls /status, so answers are
// reused for a while; a login in progress or a logout asks again.
const AUTH_TTL_MS = 30_000;
const authCache = new Map<string, { at: number; value: Promise<AgentAuth> }>();

export function forgetAuth(id: AgentProviderId): void {
  for (const key of authCache.keys()) if (key.startsWith(`${id}:`)) authCache.delete(key);
}

// How each CLI reports, starts and ends its own sign-in. The panel drives
// these so nobody needs a terminal to log in.
type AuthCommands = {
  status: string[];
  logout: string[];
  // The CLI's own sign-in page, for a provider that signs in in the browser.
  browserLogin?: {
    args: string[];
    // The address the CLI opens (or asks to be opened) to sign in.
    url(output: string): string | null;
  };
  // Signs in with an API key read on stdin, for a CLI that can.
  keyLogin?: string[];
  read(code: number, output: string): AgentAuth;
};

// `codex login status` exits 0 once signed in ("Logged in using ChatGPT").
export function readCodexAuth(code: number, output: string): AgentAuth {
  if (code === 0) return 'loggedIn';
  return /not logged in/i.test(output) ? 'loggedOut' : 'unknown';
}

// `claude auth status` prints JSON with a `loggedIn` flag. A Claude plan
// (`authMethod: "claude.ai"`) may not drive the panel, so it counts as signed
// out; even `claude auth login --console` can land on one when the Console
// account also has a plan.
export function readClaudeAuth(_code: number, output: string): AgentAuth {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) return 'unknown';
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as {
      loggedIn?: unknown;
      authMethod?: unknown;
    };
    if (typeof parsed.loggedIn !== 'boolean') return 'unknown';
    return parsed.loggedIn && parsed.authMethod !== 'claude.ai' ? 'loggedIn' : 'loggedOut';
  } catch {
    return 'unknown';
  }
}

export function firstHttpsUrl(output: string, host: RegExp): string | null {
  for (const match of output.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      if (host.test(new URL(match[0]).hostname)) return match[0];
    } catch {}
  }
  return null;
}

export const AUTH_COMMANDS: Record<AgentProviderId, AuthCommands> = {
  codex: {
    status: ['login', 'status'],
    logout: ['logout'],
    browserLogin: {
      args: ['login'],
      url: (output) => firstHttpsUrl(output, /(^|\.)openai\.com$/),
    },
    keyLogin: ['login', '--with-api-key'],
    read: readCodexAuth,
  },
  // Signs in with a pasted Anthropic API key only (see saveClaudeKey).
  claude: {
    status: ['auth', 'status'],
    logout: ['auth', 'logout'],
    read: readClaudeAuth,
  },
};

export function readAuth(cliPath: string, id: AgentProviderId): Promise<AgentAuth> {
  const key = `${id}:${cliPath}`;
  const cached = authCache.get(key);
  if (cached && Date.now() - cached.at < AUTH_TTL_MS) return cached.value;
  const value = askAuth(cliPath, id);
  authCache.set(key, { at: Date.now(), value });
  return value;
}

function askAuth(cliPath: string, id: AgentProviderId): Promise<AgentAuth> {
  const commands = AUTH_COMMANDS[id];
  return new Promise((resolve) => {
    let output = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cliPath, commands.status, {
        env: cliEnv(id),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    } catch {
      resolve('unknown');
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve('unknown');
    }, STATUS_TIMEOUT_MS);
    child.stdout?.on('data', (c: Buffer) => {
      output += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      output += c.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('unknown');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(commands.read(code ?? 1, output));
    });
  });
}

const KEY_LOGIN_TIMEOUT_MS = 30_000;

// Claude Code has no command that takes a key; it reads ANTHROPIC_API_KEY from
// the `env` block of the settings in its config folder, the panel's own one.
// `null` takes the key out again.
export async function saveClaudeKey(key: string | null): Promise<void> {
  const file = path.join(claudeConfigDir(), 'settings.json');
  let settings: { env?: Record<string, string> } = {};
  try {
    settings = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {}
  const env = { ...settings.env };
  if (key) env.ANTHROPIC_API_KEY = key;
  else delete env.ANTHROPIC_API_KEY;
  await fs.writeFile(file, `${JSON.stringify({ ...settings, env }, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies to a new file; the key must not sit in a readable one.
  await fs.chmod(file, 0o600);
  forgetAuth('claude');
}

// Codex takes the key on stdin and keeps it itself.
export async function loginWithKey(
  cliPath: string,
  id: AgentProviderId,
  key: string,
): Promise<{ ok: boolean; output: string }> {
  if (id === 'claude') {
    await saveClaudeKey(key);
    return { ok: true, output: '' };
  }
  const args = AUTH_COMMANDS[id].keyLogin;
  if (!args) return Promise.resolve({ ok: false, output: 'no API key sign-in' });
  return new Promise((resolve) => {
    let output = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cliPath, args, {
        env: cliEnv(id),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, output: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => child.kill(), KEY_LOGIN_TIMEOUT_MS);
    const onData = (c: Buffer) => {
      output += c.toString('utf8');
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.stdin?.on('error', () => {});
    child.stdin?.end(`${key}\n`);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      forgetAuth(id);
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}
