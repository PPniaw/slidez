import { spawn } from 'node:child_process';
import { type PackageManager, runCommand } from '../vite/routes/update.ts';
import { loginMethod } from './accounts.ts';
import { readAuth } from './auth.ts';
import { commandVersion, findOnPath, resolveWorkspacePackage } from './detect.ts';
import type { AgentProvider } from './provider.ts';
import type { AgentProviderId, AgentProviderStatus, AgentStatus } from './types.ts';

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

// Set by a host that ships its own runtime (the slidez desktop app): an
// executable that downloads one provider's CLI, run as `<installer> <id>`,
// printing `progress <0..1>` lines as it goes.
export function hostInstaller(): string | null {
  return process.env.OPEN_SLIDE_AGENT_INSTALLER || null;
}

async function providerStatus(
  userCwd: string,
  provider: AgentProvider,
  installProgress: number | null,
): Promise<AgentProviderStatus> {
  const sdk = resolveWorkspacePackage(userCwd, provider.sdkPackage);
  const cliPath = findOnPath(provider.cliCommand);
  const [cliVersion, models, auth] = await Promise.all([
    cliPath ? commandVersion(cliPath) : null,
    provider.models(),
    cliPath ? readAuth(cliPath, provider.id) : ('unknown' as const),
  ]);
  // The host app bundles the SDKs but downloads each CLI on first use.
  const ready = hostInstaller() ? sdk !== null && cliPath !== null : sdk !== null;
  return {
    id: provider.id,
    name: provider.name,
    sdkPackage: provider.sdkPackage,
    sdkVersion: sdk?.version ?? null,
    cliCommand: provider.cliCommand,
    cliFound: cliPath !== null,
    cliVersion,
    ready,
    auth,
    loginMethod: loginMethod(provider.id),
    installProgress,
    models,
  };
}

export async function agentStatus(
  userCwd: string,
  providers: Record<AgentProviderId, AgentProvider>,
  packageManager: PackageManager,
  progress: ReadonlyMap<AgentProviderId, number> = new Map(),
): Promise<AgentStatus> {
  const list = await Promise.all(
    Object.values(providers).map((provider) =>
      providerStatus(userCwd, provider, progress.get(provider.id) ?? null),
    ),
  );
  return {
    enabled: true,
    packageManager,
    installer: hostInstaller() ? 'host' : 'package-manager',
    providers: list,
  };
}

export function parseInstallProgress(line: string): number | null {
  const m = line.match(/^progress\s+([0-9.]+)\s*$/);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

export function installWithHost(
  installer: string,
  id: AgentProviderId,
  onProgress: (value: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(installer, [id], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let pending = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('下載超過時間仍未完成。'));
    }, INSTALL_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const value = parseInstallProgress(line);
        if (value !== null) onProgress(value);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `下載失敗（代碼 ${code}）。`));
    });
  });
}

function installCommandFor(
  packageManager: PackageManager,
  pkg: string,
): { cmd: string; args: string[] } {
  switch (packageManager) {
    case 'pnpm':
      return { cmd: 'pnpm', args: ['add', '-D', pkg] };
    case 'yarn':
      return { cmd: 'yarn', args: ['add', '-D', pkg] };
    case 'bun':
      return { cmd: 'bun', args: ['add', '-d', pkg] };
    case 'npm':
      return { cmd: 'npm', args: ['install', '-D', pkg] };
  }
}

export function installSdk(
  packageManager: PackageManager,
  pkg: string,
  cwd: string,
): Promise<void> {
  return runCommand(installCommandFor(packageManager, pkg), cwd, INSTALL_TIMEOUT_MS);
}
