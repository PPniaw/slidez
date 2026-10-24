import { ChevronDown, ChevronUp, NotebookPen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PANEL_TRANSITION_MS, usePanelMount } from '@/components/panel/panel-shell';
import { useNotes } from '@/lib/inspector/use-notes';
import { format, useLocale } from '@/lib/use-locale';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'open-slide:notes-drawer-open';
const DRAWER_CONTENT_H = 236;

type Props = {
  slideId: string;
  index: number;
  total: number;
  initial: string | undefined;
};

export function NotesDrawer({ slideId, index, total, initial }: Props) {
  const t = useLocale();
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  });
  const { value, setValue, status, flush } = useNotes(slideId, index, initial);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { mounted, animVisible } = usePanelMount(open);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, open ? '1' : '0');
  }, [open]);

  const statusLabel = (() => {
    switch (status.kind) {
      case 'saving':
        return t.notesDrawer.statusSaving;
      case 'saved':
        return t.notesDrawer.statusSaved;
      case 'error':
        return format(t.notesDrawer.statusError, { msg: status.message });
      default:
        return '';
    }
  })();

  return (
    <aside data-notes-drawer className="hidden shrink-0 bg-sidebar md:block">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => {
            if (o) void flush();
            return !o;
          });
        }}
        className="flex h-12 w-full items-center gap-2.5 px-4 text-[17px] text-foreground transition-colors duration-150 hover:bg-muted/40 active:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
        aria-expanded={open}
      >
        <NotebookPen className="size-5 text-foreground/80" />
        <span className="font-medium">{t.notesDrawer.toggle}</span>
        <span className="font-mono text-[14px] tabular-nums text-muted-foreground">
          {format(t.notesDrawer.pageLabel, { n: index + 1, total })}
        </span>
        <span
          className={cn(
            'ml-auto truncate text-[14px]',
            status.kind === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
          aria-live="polite"
        >
          {statusLabel}
        </span>
        {/* A visible target: the whole bar toggles, but this is where people look. */}
        <span className="grid size-8 shrink-0 place-items-center rounded-[6px] border border-border bg-background text-foreground">
          {open ? <ChevronDown className="size-5" /> : <ChevronUp className="size-5" />}
        </span>
      </button>
      {mounted && (
        <div
          className="overflow-hidden transition-[height] ease-swift motion-reduce:transition-none"
          style={{
            height: animVisible ? DRAWER_CONTENT_H : 0,
            transitionDuration: `${PANEL_TRANSITION_MS}ms`,
          }}
        >
          <div className="px-4 py-2">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => {
                void flush();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  // Escape during IME composition dismisses the candidate
                  // list; it must not blur the textarea.
                  if (e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  textareaRef.current?.blur();
                } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void flush();
                }
              }}
              placeholder={t.notesDrawer.placeholder}
              rows={6}
              spellCheck
              className="block h-[218px] w-full resize-none rounded-[6px] border border-border bg-card px-3 py-2.5 text-[16px] leading-relaxed text-card-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </div>
        </div>
      )}
    </aside>
  );
}
