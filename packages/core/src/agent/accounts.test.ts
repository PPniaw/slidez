import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountEnv, cliEnv, codexHome, hasFile, loginMethod } from './accounts.ts';
import { AUTH_COMMANDS, saveClaudeKey } from './auth.ts';

describe('agent accounts', () => {
  const saved = { HOME: process.env.HOME, API_ONLY: process.env.OPEN_SLIDE_AGENT_API_ONLY };
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'open-slide-accounts-'));
    process.env.HOME = home;
    delete process.env.OPEN_SLIDE_AGENT_API_ONLY;
  });

  afterEach(() => {
    process.env.HOME = saved.HOME;
    if (saved.API_ONLY === undefined) delete process.env.OPEN_SLIDE_AGENT_API_ONLY;
    else process.env.OPEN_SLIDE_AGENT_API_ONLY = saved.API_ONLY;
  });

  it("keeps Claude off the user's own sign-in", async () => {
    const dir = path.join(home, '.open-slide', 'accounts', 'claude');
    expect(accountEnv('claude')).toEqual({ CLAUDE_CONFIG_DIR: dir });
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    expect(cliEnv('claude').CLAUDE_CONFIG_DIR).toBe(dir);
    expect(loginMethod('claude')).toBe('apiKey');
    expect(AUTH_COMMANDS.claude.browserLogin).toBeUndefined();
  });

  it("leaves Codex on the user's home unless the host is API only", () => {
    expect(accountEnv('codex')).toEqual({});
    expect(loginMethod('codex')).toBe('browser');

    process.env.OPEN_SLIDE_AGENT_API_ONLY = '1';
    const dir = path.join(home, '.open-slide', 'accounts', 'codex');
    expect(accountEnv('codex')).toEqual({ CODEX_HOME: dir });
    expect(codexHome()).toBe(dir);
    expect(loginMethod('codex')).toBe('apiKey');
    expect(AUTH_COMMANDS.codex.keyLogin).toEqual(['login', '--with-api-key']);
  });

  it('keeps the Claude key in the panel settings and takes it out again', async () => {
    const file = path.join(home, '.open-slide', 'accounts', 'claude', 'settings.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ model: 'opus', env: { KEEP: '1' } }));
    await saveClaudeKey('sk-ant-test');
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      model: 'opus',
      env: { KEEP: '1', ANTHROPIC_API_KEY: 'sk-ant-test' },
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await saveClaudeKey(null);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).env).toEqual({ KEEP: '1' });
  });

  it('finds a conversation file only as deep as asked', async () => {
    const day = path.join(home, 'sessions', '2026', '10', '27');
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(path.join(day, 'rollout-2026-10-27T12-48-26-abc.jsonl'), '');
    const match = (name: string) => name.endsWith('-abc.jsonl');
    await expect(hasFile(path.join(home, 'sessions'), match, 3)).resolves.toBe(true);
    await expect(hasFile(path.join(home, 'sessions'), match, 2)).resolves.toBe(false);
    await expect(hasFile(path.join(home, 'missing'), match, 3)).resolves.toBe(false);
  });
});
