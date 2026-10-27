import { Check, Copy, ExternalLink, Globe, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LIVE_CHANGED_EVENT } from '@/lib/live/room';
import { PUBLISHED_CHANGED_EVENT, usePublishedDecks } from '@/lib/publish/published';
import { useLocale } from '@/lib/use-locale';

type PublishRecord = { project: string; url: string; publishedAt: string };
type LiveStatus = {
  /** The deck has live blocks, so live interaction can't be turned off. */
  required: boolean;
  server: string | null;
  /** Published with live interaction on. */
  enabled: boolean;
  joinUrl: string | null;
};
type Status = {
  vercel: { installed: boolean; loggedIn: boolean; user: string | null };
  record: PublishRecord | null;
  live: LiveStatus;
  busy: boolean;
};
type Phase = 'idle' | 'publishing' | 'confirm-unpublish' | 'unpublishing';
type DeviceLogin = { url: string; code: string };

const LOGIN_POLL_MS = 2000;

// Kept here instead of the shared locale files so this fork-only feature
// doesn't touch files upstream edits every release.
const ZH = {
  button: '發布',
  title: '發布這份簡報',
  checking: '正在檢查 Vercel 連線…',
  notConnected: '這台電腦還沒連上 Vercel。',
  notConnectedHint: '打開 Claude App，跟它說：「幫我安裝並登入 Vercel」。完成後按「重新檢查」。',
  loginHint:
    '發布要用 Vercel（免費）放上網。按「登入 Vercel」後瀏覽器會打開 Vercel 的英文頁面，有帳號就登入。',
  loginSignup:
    '還沒有帳號？在那頁最下面按「Sign Up」，選 Google、Apple、email 或 ChatGPT 帳號註冊；註冊完會回到確認代碼的畫面。如果問方案，選免費的 Hobby。',
  login: '登入 Vercel',
  loginStarting: '正在向 Vercel 要登入代碼…',
  loginCode: '瀏覽器已打開 Vercel，確認頁面上的代碼和這裡一樣：',
  loginGo: '瀏覽器沒有打開？點這裡',
  loginWaiting: '在瀏覽器登入並按下確認後，這裡會自動接上。',
  recheck: '重新檢查',
  account: 'Vercel 帳號',
  intro:
    '上線後，任何拿到網址的人都能看到這份簡報；搜尋引擎不會收錄。只會上傳這一份，其他簡報不會跟著上去。',
  urlAfterPublish: '網址會在發布完成後顯示。',
  publish: '發布上線',
  republish: '更新上線內容',
  publishing: '正在打包、檢查並部署，大約需要 1 分鐘…',
  live: '已上線',
  updatedAt: '最後更新',
  open: '開啟',
  openLive: '打開線上的簡報',
  copy: '複製網址',
  copied: '已複製',
  unpublish: '下架',
  confirmTitle: '確定要下架嗎？',
  confirmBody: '網址會在幾秒內失效，這個動作無法復原。之後重新發布可以再上線，但網址可能會不一樣。',
  cancel: '取消',
  confirmUnpublish: '確定下架',
  unpublishing: '正在下架…',
  failed: '沒有成功',
  liveToggle: '開啟現場互動（發問、回饋）',
  liveToggleHint: '簡報右下角會出現 QR code，觀眾掃了就能發問、評分、送表情。',
  liveRequired: '這份簡報有互動區塊，一定要開啟。',
  liveJoin: '觀眾加入網址',
  livePanelHint: '在工作台工具列的「互動」查看發問和回饋。',
  liveNeedsRepublish: '按「更新上線內容」後才會套用。',
};
const EN: typeof ZH = {
  button: 'Publish',
  title: 'Publish this deck',
  checking: 'Checking the Vercel connection…',
  notConnected: 'This computer is not connected to Vercel yet.',
  notConnectedHint:
    'Open the Claude app and say "install and log in to Vercel for me", then press Check again.',
  loginHint:
    'Publishing puts the deck online with Vercel (free). Press Log in to Vercel and the browser opens Vercel; sign in if you have an account.',
  loginSignup:
    'No account yet? Press Sign Up at the bottom of that page and use Google, Apple, email or ChatGPT; afterwards it returns to the code confirmation. If asked for a plan, pick the free Hobby plan.',
  login: 'Log in to Vercel',
  loginStarting: 'Asking Vercel for a login code…',
  loginCode: 'Vercel is open in your browser; check that it shows the same code:',
  loginGo: "Browser didn't open? Click here",
  loginWaiting: 'Once you sign in and confirm in the browser, this connects by itself.',
  recheck: 'Check again',
  account: 'Vercel account',
  intro:
    'Anyone with the link can view the deck once it is live; search engines will not index it. Only this deck is uploaded.',
  urlAfterPublish: 'The address appears once publishing finishes.',
  publish: 'Publish',
  republish: 'Update the live deck',
  publishing: 'Building, checking and deploying — about a minute…',
  live: 'Live',
  updatedAt: 'Last updated',
  open: 'Open',
  openLive: 'Open the live deck',
  copy: 'Copy link',
  copied: 'Copied',
  unpublish: 'Unpublish',
  confirmTitle: 'Unpublish this deck?',
  confirmBody:
    'The link stops working within seconds and this cannot be undone. Publishing again brings it back, possibly at a different address.',
  cancel: 'Cancel',
  confirmUnpublish: 'Unpublish',
  unpublishing: 'Unpublishing…',
  failed: 'Something went wrong',
  liveToggle: 'Turn on live interaction (Q&A, feedback)',
  liveToggleHint:
    'A QR code appears in the corner of the slides; the audience scans it to ask, rate and react.',
  liveRequired: 'This deck has live blocks, so live interaction stays on.',
  liveJoin: 'Audience link',
  livePanelHint: 'Follow questions and feedback under "Live" in the workspace toolbar.',
  liveNeedsRepublish: 'Applies after you update the live deck.',
};

async function post(
  path: string,
  slideId: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slideId, ...extra }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
  return body;
}

export function PublishButton({ slideId }: { slideId: string }) {
  const s = useLocale().id.startsWith('zh') ? ZH : EN;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [liveOn, setLiveOn] = useState(false);
  const [login, setLogin] = useState<DeviceLogin | 'starting' | null>(null);
  const published = usePublishedDecks()[slideId] ?? null;

  const refresh = useCallback(async () => {
    setStatus(null);
    const res = await fetch(`/__publish/status?slideId=${encodeURIComponent(slideId)}`);
    const next = (await res.json()) as Status;
    setStatus(next);
    setLiveOn(next.live.required || next.live.enabled);
  }, [slideId]);

  useEffect(() => {
    if (open) void refresh().catch((err: unknown) => setError(String(err)));
  }, [open, refresh]);

  // While the code waits for approval in the browser, check quietly (no
  // spinner) until the CLI has stored the login.
  const waiting = open && login !== null && login !== 'starting';
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/__publish/status?slideId=${encodeURIComponent(slideId)}`);
        const next = (await res.json()) as Status;
        if (!next.vercel.loggedIn) return;
        setLogin(null);
        setStatus(next);
        setLiveOn(next.live.required || next.live.enabled);
      } catch {
        // Try again on the next tick.
      }
    }, LOGIN_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, slideId]);

  if (import.meta.env.PROD) return null;

  const record = status?.record ?? null;
  const live = status?.live ?? null;
  const busy = phase === 'publishing' || phase === 'unpublishing';
  const publish = async () => {
    setError(null);
    setPhase('publishing');
    try {
      await post('/__publish', slideId, { live: liveOn, owner: status?.vercel.user ?? '' });
      await refresh();
      window.dispatchEvent(new Event(LIVE_CHANGED_EVENT));
      window.dispatchEvent(new Event(PUBLISHED_CHANGED_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhase('idle');
    }
  };

  const unpublish = async () => {
    setError(null);
    setPhase('unpublishing');
    try {
      await post('/__publish/unpublish', slideId);
      await refresh();
      window.dispatchEvent(new Event(LIVE_CHANGED_EVENT));
      window.dispatchEvent(new Event(PUBLISHED_CHANGED_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhase('idle');
    }
  };

  const startLogin = async () => {
    setError(null);
    setLogin('starting');
    try {
      const res = await fetch('/__publish/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json().catch(() => ({}))) as Partial<DeviceLogin> & {
        error?: string;
      };
      if (!res.ok || !body.url || !body.code) throw new Error(body.error ?? `HTTP ${res.status}`);
      setLogin({ url: body.url, code: body.code });
    } catch (err) {
      setLogin(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copy = async () => {
    const url = record?.url ?? published?.url;
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label={s.title}
        title={s.title}
        data-publish-ui
      >
        <Globe className="size-3.5" />
        <span className="hidden lg:inline">{s.button}</span>
      </Button>
      {published && (
        <span className="inline-flex items-center" data-publish-chip>
          <a
            href={published.url}
            target="_blank"
            rel="noreferrer"
            title={`${s.openLive}：${published.url}`}
            className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-[6px] px-1.5 font-mono text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            <span className="truncate">{published.url.replace(/^https?:\/\//, '')}</span>
          </a>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={copy}
            aria-label={copied ? s.copied : s.copy}
            title={copied ? s.copied : s.copy}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </span>
      )}
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="sm:max-w-lg" data-publish-dialog>
          <DialogHeader>
            <DialogTitle>{phase === 'confirm-unpublish' ? s.confirmTitle : s.title}</DialogTitle>
            <DialogDescription>
              {phase === 'confirm-unpublish' ? s.confirmBody : s.intro}
            </DialogDescription>
          </DialogHeader>

          {!status && (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              {s.checking}
            </p>
          )}

          {status && !status.vercel.loggedIn && (
            <div className="grid gap-2 text-[13px]" data-publish-state="not-connected">
              <p className="font-medium">{s.notConnected}</p>
              {!status.vercel.installed ? (
                <p className="text-muted-foreground">{s.notConnectedHint}</p>
              ) : login === null ? (
                <>
                  <p className="text-muted-foreground">{s.loginHint}</p>
                  <p className="text-muted-foreground">{s.loginSignup}</p>
                </>
              ) : login === 'starting' ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                  {s.loginStarting}
                </p>
              ) : (
                <div
                  className="grid gap-2 rounded-[8px] border border-border p-3"
                  data-publish-state="login-code"
                >
                  <p className="text-muted-foreground">{s.loginCode}</p>
                  <p
                    className="font-mono text-[20px] font-semibold tracking-[0.12em]"
                    translate="no"
                  >
                    {login.code}
                  </p>
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                    {s.loginWaiting}
                  </p>
                  <p className="text-[12px] text-muted-foreground">{s.loginSignup}</p>
                  {/* The CLI opens the page itself; this is only the fallback. */}
                  <a
                    href={login.url}
                    target="_blank"
                    rel="noreferrer"
                    className="justify-self-start text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    data-publish-action="login-go"
                  >
                    {s.loginGo}
                  </a>
                </div>
              )}
            </div>
          )}

          {status?.vercel.loggedIn && phase !== 'confirm-unpublish' && (
            <div className="grid gap-3 text-[13px]">
              <p className="text-muted-foreground">
                {s.account}：
                <span className="break-all font-medium text-foreground">{status.vercel.user}</span>
              </p>
              {record ? (
                <div
                  className="grid gap-2 rounded-[8px] border border-border p-3"
                  data-publish-state="live"
                >
                  <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600">
                    <span className="size-2 rounded-full bg-emerald-500" />
                    {s.live}
                  </span>
                  <a
                    href={record.url}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all font-mono text-[12.5px] underline underline-offset-2"
                    data-publish-url
                  >
                    {record.url}
                  </a>
                  <span className="text-muted-foreground">
                    {s.updatedAt}：{new Date(record.publishedAt).toLocaleString()}
                  </span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={copy}>
                      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      {copied ? s.copied : s.copy}
                    </Button>
                    <a
                      href={record.url}
                      target="_blank"
                      rel="noreferrer"
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    >
                      <ExternalLink className="size-3.5" />
                      {s.open}
                    </a>
                  </div>
                </div>
              ) : (
                // Vercel adds a suffix when the name is taken, so the address is only
                // known after the deploy; don't promise one up front.
                <p className="text-muted-foreground">{s.urlAfterPublish}</p>
              )}
            </div>
          )}

          {status?.vercel.loggedIn && phase !== 'confirm-unpublish' && live?.server && (
            <div
              className="grid gap-2 rounded-[8px] border border-border p-3 text-[13px]"
              data-publish-live
            >
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[var(--brand,#e5484d)]"
                  checked={liveOn}
                  disabled={busy || live.required}
                  onChange={(e) => setLiveOn(e.target.checked)}
                  data-publish-live-toggle
                />
                <span className="grid gap-0.5">
                  <span className="font-medium">{s.liveToggle}</span>
                  <span className="text-muted-foreground">
                    {live.required ? s.liveRequired : s.liveToggleHint}
                  </span>
                </span>
              </label>
              {live.enabled && live.joinUrl && (
                <div className="grid gap-1 text-muted-foreground" data-publish-live-room>
                  <span>
                    {s.liveJoin}：
                    <span className="break-all font-mono text-foreground">{live.joinUrl}</span>
                  </span>
                  <span>{s.livePanelHint}</span>
                </div>
              )}
              {record && liveOn !== live.enabled && (
                <span className="text-muted-foreground">{s.liveNeedsRepublish}</span>
              )}
            </div>
          )}

          {busy && (
            <p className="flex items-center gap-2 text-[13px]" data-publish-progress>
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              {phase === 'publishing' ? s.publishing : s.unpublishing}
            </p>
          )}

          {error && (
            <div className="grid gap-1 rounded-[8px] bg-destructive/10 p-3 text-[12.5px] text-destructive">
              <span className="font-medium">{s.failed}</span>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono">{error}</pre>
            </div>
          )}

          <DialogFooter>
            {status && !status.vercel.loggedIn && (
              <Button
                size="sm"
                variant={status.vercel.installed ? 'ghost' : 'default'}
                onClick={() => void refresh()}
              >
                <RefreshCw className="size-3.5" />
                {s.recheck}
              </Button>
            )}
            {status && !status.vercel.loggedIn && status.vercel.installed && login === null && (
              <Button size="sm" onClick={() => void startLogin()} data-publish-action="login">
                {s.login}
              </Button>
            )}
            {status?.vercel.loggedIn && phase === 'confirm-unpublish' && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setPhase('idle')}>
                  {s.cancel}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => void unpublish()}>
                  {s.confirmUnpublish}
                </Button>
              </>
            )}
            {status?.vercel.loggedIn && phase !== 'confirm-unpublish' && (
              <>
                {record && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setPhase('confirm-unpublish')}
                    data-publish-action="unpublish"
                  >
                    {s.unpublish}
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void publish()}
                  data-publish-action="publish"
                >
                  {record ? s.republish : s.publish}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
