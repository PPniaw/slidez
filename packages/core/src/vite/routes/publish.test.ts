import { describe, expect, it } from 'vitest';
import { parseDeviceLogin, parsePublishedUrl, parseVercelUser, rejectsYesFlag } from './publish.ts';

describe('publish route helpers', () => {
  it('reads the Vercel username without the CLI chatter around it', () => {
    expect(parseVercelUser('pikchen\n')).toBe('pikchen');
    expect(parseVercelUser('\n  pik-chen.dev  \n\n')).toBe('pik-chen.dev');
    // An update notice or banner that reached stdout is not a name.
    const notice = [
      'pikchen',
      '╭──────────────────────────╮',
      '│ Update available! v54 │',
      '╰──────────────────────────╯',
    ];
    expect(parseVercelUser(notice.join('\n'))).toBe('pikchen');
    expect(parseVercelUser('Vercel CLI 53.0.0 (node v24)\n')).toBeNull();
    expect(parseVercelUser('')).toBeNull();
  });

  it('reads the live url from the publish command output', () => {
    const output = '  ✔ 打包結果只包含：deck\n...\n  ✔ 已上線：https://deck.vercel.app\n';
    expect(parsePublishedUrl(output)).toBe('https://deck.vercel.app');
    expect(parsePublishedUrl('vercel deploy 失敗')).toBeNull();
  });

  it('reads the device login page and code from `vercel login`', () => {
    const output =
      'Vercel CLI 65.2.0\n  Visit https://vercel.com/oauth/device?user_code=MFHM-CZHQ\n\nWaiting for authentication...\n';
    expect(parseDeviceLogin(output)).toEqual({
      url: 'https://vercel.com/oauth/device?user_code=MFHM-CZHQ',
      code: 'MFHM-CZHQ',
    });
    expect(parseDeviceLogin('Vercel CLI 65.2.0\n')).toBeNull();
  });

  it('falls back to answering the prompt only when the CLI has no --yes', () => {
    expect(
      rejectsYesFlag(
        'Vercel CLI 54.9.1 (Node.js 20.20.2)\nError: unknown or unexpected option: --yes\n',
      ),
    ).toBe(true);
    expect(rejectsYesFlag('Vercel CLI 65.2.0\n\n✓ Deleted         deck\n')).toBe(false);
    expect(rejectsYesFlag('Vercel CLI 65.2.0\nError: Project not found. (404)\n')).toBe(false);
  });
});
