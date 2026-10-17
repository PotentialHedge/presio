import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CornerDownLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { filterItems, type PaletteItem } from "@/lib/commands";

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * The command palette (⌘K): every command there is here — Presio's own and
 * the running plugins' — searchable by name, run with Enter or a click.
 * Mount it while open; it starts empty each time.
 */
export function CommandPalette({
  items,
  extraItems,
  onClose,
  placeholder = "Type a command or search…",
}: {
  items: PaletteItem[];
  /** Rows that depend on what's typed ("Go to slide 12"), listed first. */
  extraItems?: (query: string) => PaletteItem[];
  onClose: () => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // With a query, the best matches first; without, grouped by category in
  // the order the categories first appear.
  const shown = useMemo(() => {
    const extra = extraItems?.(query) ?? [];
    if (query.trim()) return [...extra, ...filterItems(items, query)];
    const order: string[] = [];
    for (const item of items) if (!order.includes(item.category)) order.push(item.category);
    return [...extra, ...order.flatMap((category) => items.filter((i) => i.category === category))];
  }, [items, extraItems, query]);
  const searching = !!query.trim();
  // Grouped rows start their category with a heading.
  const headings = useMemo(
    () => shown.map((item, i) => (!searching && item.category !== shown[i - 1]?.category ? item.category : null)),
    [shown, searching]
  );
  const current = Math.min(active, Math.max(0, shown.length - 1));

  // Give focus back to whatever had it (a slide, a button) on closing.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return;
    if (item.prefill !== undefined) {
      setQuery(item.prefill);
      setActive(0);
      inputRef.current?.focus();
      return;
    }
    // Close first: the command may open something of its own (a file
    // picker, a dialog) that should have the focus.
    onClose();
    item.run?.();
  };

  const move = (by: number) => {
    if (!shown.length) return;
    setActive((current + by + shown.length) % shown.length);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The page's own shortcuts never see what's typed here.
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    const ctrl = e.ctrlKey && !e.metaKey;
    if (e.key === "ArrowDown" || (ctrl && e.key === "n")) {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp" || (ctrl && e.key === "p")) {
      e.preventDefault();
      move(-1);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      move(e.key === "PageDown" ? 8 : -8);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[current]);
    } else if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] animate-in fade-in-0 duration-100"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="command-palette"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
        className="mx-auto mt-3 sm:mt-[12vh] w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl animate-in fade-in-0 zoom-in-[0.98] duration-100"
      >
        <div className="flex items-center gap-2.5 border-b px-3.5">
          <Search size={16} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder={placeholder}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={shown.length ? `${listId}-${current}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            data-testid="command-palette-input"
            // 16px on phones, so iOS doesn't zoom the page in on focus.
            className="h-12 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
          />
          <kbd className="hidden sm:inline-flex h-5 items-center rounded border bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground">
            Esc
          </kbd>
        </div>
        <div ref={listRef} id={listId} role="listbox" className="max-h-[min(24rem,60dvh)] overflow-y-auto overscroll-contain p-1.5">
          {shown.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">No commands match “{query.trim()}”</p>
          )}
          {shown.map((item, i) => {
            const heading = headings[i];
            const Icon = item.icon;
            const selected = i === current;
            return (
              <div key={item.id}>
                {heading && (
                  <div className={cn("px-2.5 pb-1 text-[11px] font-medium text-muted-foreground", i > 0 ? "pt-3" : "pt-1.5")}>
                    {heading}
                  </div>
                )}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={item.disabled || undefined}
                  data-index={i}
                  data-testid={`command-${item.id}`}
                  onMouseMove={() => {
                    if (!selected) setActive(i);
                  }}
                  onClick={() => choose(item)}
                  className={cn(
                    "flex min-h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm",
                    selected && "bg-accent text-accent-foreground",
                    item.disabled && "opacity-50"
                  )}
                >
                  <span className="flex w-4 shrink-0 justify-center text-muted-foreground">{Icon && <Icon size={15} />}</span>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {searching && <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline max-w-[10rem]">{item.category}</span>}
                  {item.shortcut && (
                    <kbd className="inline-flex h-5 shrink-0 items-center rounded border bg-muted px-1.5 font-sans text-[11px] font-medium text-muted-foreground">
                      {item.shortcut}
                    </kbd>
                  )}
                  {selected && !item.shortcut && <CornerDownLeft size={13} className="hidden shrink-0 text-muted-foreground sm:block" />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="hidden items-center gap-4 border-t px-3.5 py-2 text-[11px] text-muted-foreground sm:flex">
          <span>
            <kbd className="font-sans">↑↓</kbd> to move
          </span>
          <span>
            <kbd className="font-sans">↵</kbd> to run
          </span>
          <span className="ml-auto">
            <kbd className="font-sans">{IS_MAC ? "⌘K" : "Ctrl+K"}</kbd> to close
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
