import {
  Check,
  CheckCheck,
  Copy,
  Download,
  Eye,
  EyeOff,
  MessagesSquare,
  MonitorUp,
  PanelRightClose,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  exportLiveCsv,
  type LiveAdminAccess,
  type LiveAdminQuestion,
  type LiveSettings,
  useLiveAdmin,
} from '@/lib/live/admin';
import { joinUrl, useLiveRoom } from '@/lib/live/room';
import { useLocale } from '@/lib/use-locale';
import { cn } from '@/lib/utils';

// Kept here instead of the shared locale files so this fork-only feature
// doesn't touch files upstream edits every release.
const ZH = {
  button: '互動',
  title: '現場互動',
  collapse: '收合現場互動',
  expand: '展開現場互動',
  unread: '{n} 則新的發問或回饋',
  close: '關閉',
  online: '{n} 人在線',
  joined: '{joined}/{cap} 人加入',
  join: '觀眾加入網址',
  copy: '複製',
  copied: '已複製',
  tabQa: '發問',
  tabFeedback: '回饋',
  tabSettings: '設定',
  open: '未回答',
  answered: '已回答',
  hidden: '已隱藏',
  top: '熱門',
  newest: '最新',
  anonymous: '匿名',
  pending: '待審核',
  approve: '公開',
  spotlight: '上螢幕',
  spotlightOff: '收起',
  onScreen: '螢幕上',
  markAnswered: '已回答',
  unanswer: '取消已回答',
  hide: '隱藏',
  restore: '復原',
  noQuestions: '這裡還沒有問題。觀眾掃簡報角落的 QR code 就能發問。',
  rating: '評分',
  ratingCount: '{n} 人評分',
  noRating: '還沒有人評分',
  reactions: '表情',
  resetReactions: '歸零',
  comments: '一句話心得',
  noComments: '還沒有心得。',
  qaOpen: '開放發問',
  feedbackOpen: '開放回饋',
  identity: '發問身分',
  idAnonymous: '一律匿名（不問名字）',
  idOptional: '可選擇具名',
  idRequired: '必須具名',
  moderation: '新問題',
  modPost: '直接出現在觀眾手機',
  modPre: '我公開後才出現',
  exportCsv: '匯出 CSV',
  connecting: '連線中…',
  offline: '連線中斷，正在重新連線…',
  unavailable: '這份簡報沒有開啟現場互動。發布時勾選「開啟現場互動」即可使用。',
};
const EN: typeof ZH = {
  button: 'Live',
  title: 'Live interaction',
  collapse: 'Collapse live interaction',
  expand: 'Expand live interaction',
  unread: '{n} new questions or comments',
  close: 'Close',
  online: '{n} online',
  joined: '{joined}/{cap} joined',
  join: 'Audience link',
  copy: 'Copy',
  copied: 'Copied',
  tabQa: 'Questions',
  tabFeedback: 'Feedback',
  tabSettings: 'Settings',
  open: 'Open',
  answered: 'Answered',
  hidden: 'Hidden',
  top: 'Top',
  newest: 'Newest',
  anonymous: 'Anonymous',
  pending: 'Pending',
  approve: 'Publish',
  spotlight: 'Show on screen',
  spotlightOff: 'Take down',
  onScreen: 'On screen',
  markAnswered: 'Answered',
  unanswer: 'Not answered',
  hide: 'Hide',
  restore: 'Restore',
  noQuestions: 'No questions yet. The audience scans the QR code in the corner of the slides.',
  rating: 'Rating',
  ratingCount: '{n} ratings',
  noRating: 'No ratings yet',
  reactions: 'Reactions',
  resetReactions: 'Reset',
  comments: 'Comments',
  noComments: 'No comments yet.',
  qaOpen: 'Accept questions',
  feedbackOpen: 'Accept feedback',
  identity: 'Who asks',
  idAnonymous: 'Always anonymous',
  idOptional: 'Name optional',
  idRequired: 'Name required',
  moderation: 'New questions',
  modPost: 'Show on phones right away',
  modPre: 'Show after I publish them',
  exportCsv: 'Export CSV',
  connecting: 'Connecting…',
  offline: 'Connection lost, reconnecting…',
  unavailable: 'Live interaction is off for this deck. Turn it on when you publish.',
};

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));

type Tab = 'qa' | 'feedback' | 'settings';

type Filter = 'open' | 'answered' | 'hidden';

/** Toolbar button + side panel where the presenter runs the deck's live room. */
export function LivePanelButton({ slideId }: { slideId: string }) {
  const s = useLocale().id.startsWith('zh') ? ZH : EN;
  const room = useLiveRoom(slideId);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!room) setOpen(false);
  }, [room]);

  if (import.meta.env.PROD || !room) return null;
  return (
    <>
      <Button
        size="sm"
        variant={open ? 'secondary' : 'ghost'}
        onClick={() => setOpen((v) => !v)}
        aria-label={s.title}
        title={s.title}
        data-live-panel-ui
      >
        <MessagesSquare className="size-3.5" />
        <span className="hidden lg:inline">{s.button}</span>
      </Button>
      {open && <LivePanel slideId={slideId} onClose={() => setOpen(false)} />}
    </>
  );
}

const COLLAPSED_KEY = 'open-slide:presenter-live-collapsed';

/**
 * The live panel as the presenter window's last column. It collapses to a
 * thin strip that counts questions and comments arriving meanwhile; the
 * panel stays mounted so the room connection (and the count) keeps going.
 */
export function PresenterLivePanel({ slideId }: { slideId: string }) {
  const s = useLocale().id.startsWith('zh') ? ZH : EN;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [total, setTotal] = useState(0);
  const [seen, setSeen] = useState(0);
  const unread = collapsed ? Math.max(0, total - seen) : 0;

  useEffect(() => {
    if (!collapsed) setSeen(total);
  }, [collapsed, total]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // Private mode: the choice just isn't remembered.
    }
  };

  return (
    <section
      data-presenter-live
      data-collapsed={collapsed || undefined}
      className={cn(
        'flex min-h-0 flex-col gap-3',
        collapsed ? 'lg:w-12' : 'lg:w-[clamp(320px,28vw,460px)]',
      )}
    >
      {/* The label sets the row's height, as in the other columns, so the boxes
          line up; the button's negative margin keeps it from growing the row. */}
      <div className="flex items-center gap-2">
        {/* Same look as the presenter's section labels. */}
        <span
          className={cn(
            'eyebrow block min-w-0 flex-1 truncate text-[13px] text-foreground/85',
            collapsed && 'invisible',
          )}
        >
          {s.title}
        </span>
        {!collapsed && (
          <Button
            size="icon-xs"
            variant="ghost"
            className="-my-1"
            onClick={toggle}
            aria-label={s.collapse}
            title={s.collapse}
          >
            <PanelRightClose className="size-4" aria-hidden />
          </Button>
        )}
      </div>
      {collapsed && (
        <button
          type="button"
          onClick={toggle}
          aria-label={s.expand}
          title={unread ? fill(s.unread, { n: unread }) : s.expand}
          className="relative flex min-h-0 flex-1 flex-col items-center gap-3 rounded-[8px] border border-foreground/20 py-3 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <MessagesSquare className="size-5" aria-hidden />
          <span className="font-medium text-[15px] tracking-[0.1em] [writing-mode:vertical-rl]">
            {s.title}
          </span>
          {unread > 0 && (
            <span
              data-live-unread
              className="absolute -top-1.5 -right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-red-500 px-1 font-semibold text-[11px] text-white tabular-nums"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      )}
      {/* Read from a step back while presenting: scale the whole panel up rather
          than restyling every size it uses in the toolbar. */}
      <div
        className={cn('min-h-0 flex-1 flex-col', collapsed ? 'hidden' : 'flex')}
        style={{ zoom: 1.15 }}
      >
        <LivePanel slideId={slideId} embedded onTotal={setTotal} />
      </div>
    </section>
  );
}

function LivePanel({
  slideId,
  onClose,
  embedded = false,
  onTotal,
}: {
  slideId: string;
  onClose?: () => void;
  embedded?: boolean;
  /** Questions plus comments so far, for the presenter's unread count. */
  onTotal?: (n: number) => void;
}) {
  const locale = useLocale().id;
  const s = locale.startsWith('zh') ? ZH : EN;
  const timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const [access, setAccess] = useState<LiveAdminAccess | null>(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<Tab>('qa');
  const [filter, setFilter] = useState<Filter>('open');
  const [sort, setSort] = useState<'top' | 'new'>('top');
  const [copied, setCopied] = useState(false);
  const { state, status, message, send } = useLiveAdmin(access);
  const total = state ? state.questions.length + state.comments.length : 0;
  useEffect(() => {
    onTotal?.(total);
  }, [onTotal, total]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/__publish/live-admin?slideId=${encodeURIComponent(slideId)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) return setMissing(true);
        setAccess((await res.json()) as LiveAdminAccess);
      })
      .catch(() => !cancelled && setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [slideId]);

  const settings = state?.settings;
  const setSetting = (patch: Partial<LiveSettings>) => send({ t: 'settings', patch });
  const pendingOf = (q: LiveAdminQuestion) =>
    settings?.moderation === 'pre' && !q.approved && !q.hidden;
  const questions = (state?.questions ?? [])
    .filter((q) =>
      filter === 'hidden' ? q.hidden : !q.hidden && (filter === 'answered') === q.answered,
    )
    .sort((a, b) => (sort === 'top' ? b.votes - a.votes || b.id - a.id : b.id - a.id));
  const count = (f: Filter) =>
    (state?.questions ?? []).filter((q) =>
      f === 'hidden' ? q.hidden : !q.hidden && (f === 'answered') === q.answered,
    ).length;

  const copyJoin = async () => {
    if (!access) return;
    await navigator.clipboard.writeText(joinUrl(access));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const download = async () => {
    if (!access) return;
    const url = URL.createObjectURL(await exportLiveCsv(access));
    const a = document.createElement('a');
    a.href = url;
    a.download = `live-${slideId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'qa', label: s.tabQa, count: state ? count('open') : undefined },
    { id: 'feedback', label: s.tabFeedback, count: state?.comments.length || undefined },
    { id: 'settings', label: s.tabSettings },
  ];

  return (
    <aside
      data-live-panel
      aria-label={s.title}
      className={cn(
        'flex flex-col overflow-hidden overscroll-contain border bg-background text-[13px]',
        embedded
          ? 'min-h-0 flex-1 rounded-[8px] border-foreground/20'
          : 'fixed top-14 right-3 bottom-3 z-50 w-[392px] border-border max-w-[calc(100vw-24px)] rounded-[14px] shadow-[0_1px_2px_oklch(0_0_0/0.06),0_18px_48px_-16px_oklch(0_0_0/0.28)]',
      )}
    >
      <header className="grid gap-2 border-border border-b px-4 pt-3 pb-3">
        <div className="flex items-center gap-2">
          {!embedded && <h2 className="font-semibold text-[14px]">{s.title}</h2>}
          <span
            className="inline-flex items-center gap-1.5 text-muted-foreground tabular-nums"
            role="status"
            aria-live="polite"
            data-live-panel-counts
          >
            <span
              aria-hidden
              className={cn(
                'size-1.5 rounded-full',
                status === 'online' ? 'bg-emerald-500' : 'bg-muted-foreground/50',
              )}
            />
            {state
              ? `${fill(s.online, { n: state.online })}・${fill(s.joined, { joined: state.joined, cap: state.cap })}`
              : status === 'offline'
                ? s.offline
                : status === 'closed'
                  ? (message ?? s.unavailable)
                  : s.connecting}
          </span>
          {onClose && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="ml-auto"
              onClick={onClose}
              aria-label={s.close}
            >
              <X className="size-4" aria-hidden />
            </Button>
          )}
        </div>
        {access && (
          <div className="flex min-w-0 items-center gap-2 rounded-[10px] bg-muted/60 py-1 pr-1 pl-2.5">
            <span className="shrink-0 text-muted-foreground">{s.join}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px]" translate="no">
              {joinUrl(access).replace(/^https?:\/\//, '')}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void copyJoin()}
              aria-label={s.copy}
              title={s.copy}
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? s.copied : s.copy}
            </Button>
          </div>
        )}
      </header>

      {missing ? (
        <div className="grid flex-1 place-items-center p-6 text-center text-muted-foreground">
          <p className="max-w-[28ch]">{s.unavailable}</p>
        </div>
      ) : (
        <>
          <div className="px-4 pt-3">
            <div
              role="tablist"
              aria-label={s.title}
              className="grid grid-cols-3 gap-0.5 rounded-[10px] border border-border bg-muted/60 p-0.5"
            >
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  data-live-tab={t.id}
                  className={cn(
                    'inline-flex h-7 items-center justify-center gap-1.5 rounded-[8px] font-medium text-muted-foreground transition-[background-color,color,box-shadow]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                    tab === t.id &&
                      'bg-background text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.08)]',
                  )}
                >
                  {t.label}
                  {t.count ? (
                    <span className="rounded-full bg-foreground/8 px-1.5 text-[11px] tabular-nums">
                      {t.count}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-4">
            {!state && !missing && (
              <div className="grid gap-3" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="grid gap-2 py-1">
                    <div className="h-3.5 w-4/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                    <div className="h-3 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                  </div>
                ))}
              </div>
            )}

            {state && tab === 'qa' && (
              <div className="grid gap-3">
                {state.spotlight && (
                  <div
                    className="grid gap-2 rounded-[12px] border border-[var(--brand,#e5484d)]/35 bg-[var(--brand,#e5484d)]/[0.06] p-3"
                    data-live-onscreen
                  >
                    <span className="inline-flex items-center gap-1.5 font-medium text-[12px] text-[var(--brand,#e5484d)]">
                      <MonitorUp className="size-3.5" aria-hidden />
                      {s.onScreen}
                    </span>
                    <p className="whitespace-pre-wrap break-words text-[14px] leading-snug">
                      {state.spotlight.text}
                    </p>
                    <div>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => send({ t: 'spotlight', id: null })}
                      >
                        {s.spotlightOff}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  <fieldset className="m-0 flex gap-0.5 rounded-[8px] border-0 bg-muted/60 p-0.5">
                    {(['open', 'answered', 'hidden'] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={filter === f}
                        onClick={() => setFilter(f)}
                        className={cn(
                          'h-6 whitespace-nowrap rounded-[6px] px-2 text-[12px] text-muted-foreground tabular-nums transition-[background-color,color]',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                          filter === f &&
                            'bg-background text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.08)]',
                        )}
                      >
                        {s[f]} {count(f)}
                      </button>
                    ))}
                  </fieldset>
                  <button
                    type="button"
                    onClick={() => setSort((v) => (v === 'top' ? 'new' : 'top'))}
                    className="h-6 shrink-0 whitespace-nowrap rounded-[6px] px-2 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    {sort === 'top' ? s.top : s.newest} ↕
                  </button>
                </div>

                {questions.length === 0 && (
                  <div className="grid place-items-center gap-2 py-10 text-center text-muted-foreground">
                    <MessagesSquare className="size-5 opacity-60" aria-hidden />
                    <p className="max-w-[30ch]">{s.noQuestions}</p>
                  </div>
                )}

                <ul className="divide-y divide-border">
                  {questions.map((q) => {
                    const onScreen = state.spotlight?.id === q.id;
                    return (
                      <li key={q.id} data-live-question className="flex gap-3 py-3">
                        <div
                          className="flex w-9 shrink-0 flex-col items-center rounded-[8px] bg-muted/60 py-1 tabular-nums"
                          title={`${q.votes}`}
                        >
                          <span aria-hidden className="text-[10px] text-muted-foreground">
                            ▲
                          </span>
                          <span className="font-semibold text-[13px]">{q.votes}</span>
                        </div>
                        <div className="grid min-w-0 flex-1 gap-1.5">
                          <p className="whitespace-pre-wrap break-words text-[14px] leading-snug">
                            {q.text}
                          </p>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
                            <span>{q.name || s.anonymous}</span>
                            <span>{timeFmt.format(new Date(q.createdAt))}</span>
                            {pendingOf(q) && (
                              <span className="rounded-full border border-border px-1.5">
                                {s.pending}
                              </span>
                            )}
                            {onScreen && (
                              <span className="font-medium text-[var(--brand,#e5484d)]">
                                {s.onScreen}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            {!q.hidden && (
                              <Button
                                size="xs"
                                variant={onScreen ? 'default' : 'outline'}
                                onClick={() => send({ t: 'spotlight', id: onScreen ? null : q.id })}
                                data-live-action="spotlight"
                              >
                                <MonitorUp aria-hidden />
                                {onScreen ? s.spotlightOff : s.spotlight}
                              </Button>
                            )}
                            {pendingOf(q) && (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => send({ t: 'question', id: q.id, approved: true })}
                              >
                                {s.approve}
                              </Button>
                            )}
                            <span className="ml-auto" />
                            {!q.hidden && (
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={q.answered ? s.unanswer : s.markAnswered}
                                title={q.answered ? s.unanswer : s.markAnswered}
                                aria-pressed={q.answered}
                                className={cn(q.answered && 'text-emerald-600')}
                                onClick={() =>
                                  send({ t: 'question', id: q.id, answered: !q.answered })
                                }
                              >
                                <CheckCheck aria-hidden />
                              </Button>
                            )}
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label={q.hidden ? s.restore : s.hide}
                              title={q.hidden ? s.restore : s.hide}
                              onClick={() => {
                                if (onScreen && !q.hidden) send({ t: 'spotlight', id: null });
                                send({ t: 'question', id: q.id, hidden: !q.hidden });
                              }}
                            >
                              {q.hidden ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
                            </Button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {state && tab === 'feedback' && (
              <div className="grid gap-5" data-live-feedback>
                <section className="grid gap-2">
                  <h3 className="font-medium text-muted-foreground">{s.rating}</h3>
                  <p className="flex items-baseline gap-1.5 tabular-nums">
                    <span className="font-semibold text-[28px] leading-none">
                      {state.rating.count ? state.rating.avg : '–'}
                    </span>
                    <span className="text-muted-foreground">/ 5</span>
                    <span className="ml-auto text-muted-foreground">
                      {state.rating.count
                        ? fill(s.ratingCount, { n: state.rating.count })
                        : s.noRating}
                    </span>
                  </p>
                  <div className="grid gap-1.5">
                    {[5, 4, 3, 2, 1].map((stars) => {
                      const n = state.rating.dist[stars - 1];
                      const max = Math.max(1, ...state.rating.dist);
                      return (
                        <div
                          key={stars}
                          className="grid grid-cols-[28px_1fr_24px] items-center gap-2 text-[12px] tabular-nums"
                        >
                          <span className="text-muted-foreground">{stars} ★</span>
                          <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <span
                              className="block h-full rounded-full bg-[var(--brand,#e5484d)] transition-[width] duration-300"
                              style={{ width: `${(n / max) * 100}%` }}
                            />
                          </span>
                          <span className="text-right">{n}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="grid gap-2">
                  <div className="flex items-center">
                    <h3 className="font-medium text-muted-foreground">{s.reactions}</h3>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => send({ t: 'reset-reactions' })}
                    >
                      {s.resetReactions}
                    </Button>
                  </div>
                  <div className="grid grid-cols-5 gap-1.5">
                    {Object.entries(state.reactions).map(([emoji, n]) => (
                      <div
                        key={emoji}
                        className="grid place-items-center gap-0.5 rounded-[10px] border border-border py-2 tabular-nums"
                      >
                        <span className="text-[18px] leading-none">{emoji}</span>
                        <span className="text-[12px] text-muted-foreground">{n}</span>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="grid gap-1">
                  <h3 className="font-medium text-muted-foreground">{s.comments}</h3>
                  {state.comments.length === 0 && (
                    <p className="py-4 text-muted-foreground">{s.noComments}</p>
                  )}
                  <ul className="divide-y divide-border">
                    {state.comments.map((c) => (
                      <li key={c.id} className="grid gap-0.5 py-2.5">
                        <p className="whitespace-pre-wrap break-words text-[14px] leading-snug">
                          {c.text}
                        </p>
                        <span className="text-[12px] text-muted-foreground tabular-nums">
                          {timeFmt.format(new Date(c.createdAt))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            )}

            {settings && tab === 'settings' && (
              <div className="grid divide-y divide-border" data-live-settings>
                <SettingRow label={s.qaOpen}>
                  <Switch
                    checked={settings.qaOpen}
                    label={s.qaOpen}
                    onChange={(v) => setSetting({ qaOpen: v })}
                  />
                </SettingRow>
                <SettingRow label={s.feedbackOpen}>
                  <Switch
                    checked={settings.feedbackOpen}
                    label={s.feedbackOpen}
                    onChange={(v) => setSetting({ feedbackOpen: v })}
                  />
                </SettingRow>
                <SettingRow label={s.identity} htmlFor="live-identity">
                  <select
                    id="live-identity"
                    className="h-8 rounded-[8px] border border-border bg-background px-2 text-foreground"
                    value={settings.anonymity}
                    onChange={(e) =>
                      setSetting({ anonymity: e.target.value as LiveSettings['anonymity'] })
                    }
                  >
                    <option value="anonymous">{s.idAnonymous}</option>
                    <option value="optional">{s.idOptional}</option>
                    <option value="required">{s.idRequired}</option>
                  </select>
                </SettingRow>
                <SettingRow label={s.moderation} htmlFor="live-moderation">
                  <select
                    id="live-moderation"
                    className="h-8 rounded-[8px] border border-border bg-background px-2 text-foreground"
                    value={settings.moderation}
                    onChange={(e) =>
                      setSetting({ moderation: e.target.value as LiveSettings['moderation'] })
                    }
                  >
                    <option value="post">{s.modPost}</option>
                    <option value="pre">{s.modPre}</option>
                  </select>
                </SettingRow>
                <div className="pt-3">
                  <Button size="sm" variant="outline" onClick={() => void download()}>
                    <Download aria-hidden />
                    {s.exportCsv}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function SettingRow({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <label htmlFor={htmlFor} className="text-[13px]">
        {label}
      </label>
      {children}
    </div>
  );
}

function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-[background-color]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        checked ? 'bg-[var(--brand,#e5484d)]' : 'bg-muted-foreground/30',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-block size-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
