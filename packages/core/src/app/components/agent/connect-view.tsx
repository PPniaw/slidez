import { Check, Download, Loader2, LogIn, RotateCw, Terminal } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  cancelLogin,
  installProvider,
  type LoginPrompt,
  loginProvider,
  loginWithApiKey,
  logoutProvider,
  refreshStatus,
  selectProvider,
  submitLoginCode,
  useAgentState,
  useAgentStatus,
} from '@/lib/agent/use-agent';
import { format, useLocale } from '@/lib/use-locale';
import { cn } from '@/lib/utils';
import type { AgentProviderId, AgentProviderStatus } from '../../../agent/types';
import { useAgentForkStrings } from './fork-strings';
import { ProviderLogo } from './provider-logo';

const CLI_INSTALL: Record<AgentProviderId, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
};

// What the host app downloads on first use (the platform CLI package).
const DOWNLOAD_SIZE: Record<AgentProviderId, string> = {
  claude: '120 MB',
  codex: '140 MB',
};

// The free ChatGPT plan works, so it leads for people without a subscription.
const HOST_ORDER: AgentProviderId[] = ['codex', 'claude'];

function needsCli(p: AgentProviderStatus): boolean {
  return !p.cliFound && !p.ready;
}

export function ConnectView() {
  const t = useLocale();
  const s = useAgentForkStrings();
  const { status, loading, enabled, provider: current } = useAgentStatus();
  const { installing, connectErrors, logins } = useAgentState();
  const [checking, setChecking] = useState(false);
  const host = status?.installer === 'host';
  const providers = host
    ? [...(status?.providers ?? [])].sort(
        (a, b) => HOST_ORDER.indexOf(a.id) - HOST_ORDER.indexOf(b.id),
      )
    : (status?.providers ?? []);
  const needCli = !host && providers.length > 0 && providers.every(needsCli);
  const anyMissing = !host && providers.some(needsCli);

  const checkAgain = async () => {
    setChecking(true);
    try {
      await refreshStatus();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 px-4 py-5">
      <div>
        <span className="eyebrow">{t.agent.title}</span>
        <h2 className="mt-1.5 font-heading text-[15px] font-semibold tracking-tight">
          {host ? s.connectTitle : needCli ? t.agent.needCliTitle : t.agent.connectTitle}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
          {host
            ? s.connectDescription
            : needCli
              ? t.agent.needCliDescription
              : t.agent.connectDescription}
        </p>
      </div>

      {loading ? (
        <p className="text-[12px] text-muted-foreground">{t.agent.statusLoading}…</p>
      ) : !enabled ? (
        <p className="text-[12px] text-muted-foreground">{t.agent.disabled}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              host={host}
              current={current?.id === provider.id}
              packageManager={status?.packageManager ?? 'npm'}
              installing={installing === provider.id}
              busy={installing !== null}
              error={connectErrors[provider.id]}
              login={logins[provider.id]}
              onConnect={async () => {
                try {
                  await installProvider(provider.id);
                  if (!host) {
                    toast.success(format(t.agent.toastConnected, { name: provider.name }));
                  }
                } catch (err) {
                  if (host) return;
                  toast.error(format(t.agent.toastConnectFailed, { pkg: provider.sdkPackage }), {
                    description: err instanceof Error ? err.message : undefined,
                  });
                }
              }}
            />
          ))}
          {anyMissing && (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={checking}
              onClick={checkAgain}
            >
              <RotateCw
                className={cn('size-3.5', checking && 'animate-spin motion-reduce:animate-none')}
                aria-hidden
              />
              {t.agent.checkAgain}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  host,
  current,
  packageManager,
  installing,
  busy,
  error,
  login,
  onConnect,
}: {
  provider: AgentProviderStatus;
  host: boolean;
  current: boolean;
  packageManager: string;
  installing: boolean;
  busy: boolean;
  error: string | undefined;
  login: LoginPrompt | undefined;
  onConnect: () => void;
}) {
  const t = useLocale();
  const s = useAgentForkStrings();
  const missing = !host && needsCli(provider);
  const signedOut = provider.ready && provider.auth === 'loggedOut';
  const usable = provider.ready && !signedOut;
  const keyLogin = provider.loginMethod === 'apiKey';
  const cliLabel = provider.cliFound
    ? provider.cliVersion
      ? format(t.agent.cliFound, { version: provider.cliVersion })
      : t.agent.cliFoundNoVersion
    : t.agent.cliMissing;
  const codexName = keyLogin ? s.codexKeyName : s.codexName;
  const name = host ? (provider.id === 'codex' ? codexName : s.claudeName) : provider.name;
  const progress = provider.installProgress;

  let action: React.ReactNode = null;
  if (usable) {
    action = current ? (
      <span className="inline-flex items-center gap-1 rounded-[5px] bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
        <Check className="size-3" aria-hidden />
        {host ? s.inUse : t.agent.connected}
      </span>
    ) : (
      <Button size="sm" variant="outline" onClick={() => selectProvider(provider.id)}>
        {s.use}
      </Button>
    );
  } else if (signedOut) {
    action =
      login || keyLogin ? null : (
        <Button
          size="sm"
          variant={error ? 'outline' : 'default'}
          onClick={() => void loginProvider(provider.id)}
          data-agent-action="login"
        >
          <LogIn className="size-3.5" aria-hidden />
          {s.login}
        </Button>
      );
  } else if (installing) {
    action = host ? null : (
      <span className="inline-flex items-center gap-1.5 px-1 text-[11.5px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
        {t.agent.connecting}
      </span>
    );
  } else if (!missing) {
    action = (
      <Button
        size="sm"
        variant={error ? 'outline' : 'default'}
        disabled={busy}
        onClick={onConnect}
        data-agent-action={host ? 'download' : 'connect'}
      >
        {host && <Download className="size-3.5" aria-hidden />}
        {error
          ? t.agent.retry
          : host
            ? format(s.download, { size: DOWNLOAD_SIZE[provider.id] })
            : t.agent.connect}
      </Button>
    );
  }

  let detail: React.ReactNode;
  if (missing) {
    detail = (
      <div className="mt-2.5 flex flex-col gap-1.5">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {format(t.agent.cliHint, { name: provider.name })}
        </p>
        <code className="block overflow-x-auto rounded-[5px] bg-muted px-2 py-1.5 font-mono text-[11px] whitespace-nowrap select-all">
          {CLI_INSTALL[provider.id]}
        </code>
      </div>
    );
  } else if (host && installing) {
    const percent = Math.round((progress ?? 0) * 100);
    detail = (
      <div className="mt-2.5 flex flex-col gap-1.5" data-agent-progress={percent}>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {progress === null || progress === 0
            ? s.downloadPreparing
            : format(s.downloading, { percent })}
        </p>
      </div>
    );
  } else if (signedOut && keyLogin) {
    detail = <KeyLogin provider={provider.id} />;
  } else if (login) {
    detail = <LoginWaiting provider={provider.id} login={login} />;
  } else if (error && !installing) {
    detail = (
      <p className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-destructive">
        {host ? s.failed : ''}
        {error}
      </p>
    );
  } else if (host) {
    detail = (
      <p className="mt-2 flex items-center justify-between gap-2 text-[11px] leading-relaxed text-muted-foreground">
        <span>
          {signedOut
            ? s.loggedOutHint
            : provider.id === 'codex'
              ? keyLogin
                ? s.codexKeyNote
                : s.codexNote
              : s.claudeNote}
        </span>
        {usable && provider.auth === 'loggedIn' && (
          <LogoutButton provider={provider.id} label={s.logout} />
        )}
      </p>
    );
  } else {
    detail = (
      <p className="mt-2 flex items-center justify-between gap-2 text-[11px] leading-relaxed text-muted-foreground">
        <span>
          {provider.ready
            ? `${provider.sdkPackage} v${provider.sdkVersion}`
            : format(t.agent.connectInstallHint, { pkg: provider.sdkPackage, pm: packageManager })}
        </span>
        {usable && provider.auth === 'loggedIn' && (
          <LogoutButton provider={provider.id} label={s.logout} />
        )}
      </p>
    );
  }

  return (
    <div
      className="rounded-[8px] border border-border bg-card p-3 shadow-edge"
      data-agent-card={provider.id}
      data-agent-auth={provider.auth}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 font-heading text-[13px] font-semibold tracking-tight">
            <ProviderLogo provider={provider.id} className="size-3.5 shrink-0" />
            {name}
          </h3>
          {!host && (
            <p
              className={cn(
                'mt-0.5 flex items-center gap-1 text-[11px]',
                provider.cliFound ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400',
              )}
            >
              <Terminal className="size-3" aria-hidden />
              {cliLabel}
            </p>
          )}
        </div>
        {action}
      </div>
      {detail}
    </div>
  );
}

function LoginWaiting({ provider, login }: { provider: AgentProviderId; login: LoginPrompt }) {
  const s = useAgentForkStrings();
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  if (!login.url) {
    return (
      <p className="mt-2.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
        {s.loginStarting}
      </p>
    );
  }
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-agent-login={provider}>
      <p className="flex gap-1.5 text-[11.5px] leading-relaxed text-foreground/85">
        <Loader2
          className="mt-0.5 size-3 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
        {s.loginWaiting}
      </p>
      <div className="flex items-center justify-between gap-2">
        <a
          href={login.url}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {s.loginFallback}
        </a>
        <Button size="xs" variant="ghost" onClick={() => cancelLogin(provider)}>
          {s.loginCancel}
        </Button>
      </div>
      {provider === 'claude' && (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!code.trim()) return;
            setSending(true);
            try {
              await submitLoginCode(provider, code);
              setCode('');
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            } finally {
              setSending(false);
            }
          }}
        >
          <label className="text-[11px] text-muted-foreground" htmlFor="agent-login-code">
            {s.loginCodeLabel}
          </label>
          <div className="flex gap-1.5">
            <input
              id="agent-login-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-[5px] border border-border bg-background px-2 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <Button size="xs" type="submit" disabled={sending || !code.trim()}>
              {s.loginCodeSubmit}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

const KEY_PAGE: Record<AgentProviderId, string> = {
  claude: 'https://console.anthropic.com/settings/keys',
  codex: 'https://platform.openai.com/api-keys',
};

function KeyLogin({ provider }: { provider: AgentProviderId }) {
  const s = useAgentForkStrings();
  const [key, setKey] = useState('');
  const [sending, setSending] = useState(false);
  const claude = provider === 'claude';
  return (
    <form
      className="mt-2.5 flex flex-col gap-1.5"
      data-agent-key-login={provider}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!key.trim()) return;
        setSending(true);
        try {
          await loginWithApiKey(provider, key);
          setKey('');
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
        } finally {
          setSending(false);
        }
      }}
    >
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {claude ? s.claudeNote : s.codexKeyNote}
      </p>
      <label className="text-[11px] text-muted-foreground" htmlFor={`agent-key-${provider}`}>
        {claude ? s.claudeKeyLabel : s.codexKeyLabel}
      </label>
      <div className="flex gap-1.5">
        <input
          id={`agent-key-${provider}`}
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded-[5px] border border-border bg-background px-2 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        <Button size="xs" type="submit" disabled={sending || !key.trim()}>
          {sending && (
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
          )}
          {s.keySubmit}
        </Button>
      </div>
      <a
        href={KEY_PAGE[provider]}
        target="_blank"
        rel="noreferrer"
        className="self-start text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {claude ? s.claudeKeyCreate : s.codexKeyCreate}
      </a>
    </form>
  );
}

function LogoutButton({ provider, label }: { provider: AgentProviderId; label: string }) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
      onClick={async () => {
        setPending(true);
        try {
          await logoutProvider(provider);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
        } finally {
          setPending(false);
        }
      }}
      data-agent-action="logout"
    >
      {label}
    </button>
  );
}
