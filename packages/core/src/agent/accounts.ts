import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentLoginMethod, AgentProviderId } from './types.ts';

// Anthropic lets another app reach Claude only with an API key, never the Pro
// or Max plan the user's own Claude Code is signed in with. OpenAI allows a ChatGPT plan in local or open-source apps but not in
// paid ones. So the CLIs the panel runs keep their sign-in in folders of
// their own and never pick up the user's.
//
// Claude always signs in with a pasted API key. A paid host app (the slidez
// desktop app) sets OPEN_SLIDE_AGENT_API_ONLY=1, and Codex then gets its own
// folder and an API key too.
export function apiOnly(): boolean {
  return process.env.OPEN_SLIDE_AGENT_API_ONLY === '1';
}

export function loginMethod(id: AgentProviderId): AgentLoginMethod {
  return id === 'claude' || apiOnly() ? 'apiKey' : 'browser';
}

// The variables that point one CLI at the panel's own sign-in folder.
export function accountEnv(id: AgentProviderId): Record<string, string> {
  if (id === 'codex' && !apiOnly()) return {};
  const dir = path.join(os.homedir(), '.open-slide', 'accounts', id);
  fs.mkdirSync(dir, { recursive: true });
  return id === 'claude' ? { CLAUDE_CONFIG_DIR: dir } : { CODEX_HOME: dir };
}

export function cliEnv(id: AgentProviderId): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, ...accountEnv(id) };
}

export function claudeConfigDir(): string {
  return accountEnv('claude').CLAUDE_CONFIG_DIR as string;
}

export function codexHome(): string {
  return (
    accountEnv('codex').CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  );
}

// Whether a file named by `match` sits under `dir`, `depth` folders down at most.
export async function hasFile(
  dir: string,
  match: (name: string) => boolean,
  depth: number,
): Promise<boolean> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && match(entry.name)) return true;
  }
  if (depth === 0) return false;
  for (const entry of entries) {
    if (entry.isDirectory() && (await hasFile(path.join(dir, entry.name), match, depth - 1))) {
      return true;
    }
  }
  return false;
}
