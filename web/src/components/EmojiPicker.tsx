"use client";

import { useMemo, useRef, useState } from "react";
import { FloatingPopup } from "./FloatingPopup";
import { LUCIDE_ICON_NAMES, PageIcon } from "./PageIcon";

const EMOJIS = [
  "📄", "📊", "📁", "📌", "📎", "📅", "📆", "📋", "🔗", "✏️",
  "📝", "🗂️", "📂", "🏷️", "⭐", "💡", "🔒", "✅", "❌", "💬",
  "🎯", "🚀", "🔔", "❤️", "🔥", "👍", "🏠",
];

interface EmojiPickerProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Current icon (emoji string or `lucide:<name>`); null is treated as none. */
  currentIcon?: string | null;
  onSelect: (icon: string | null) => void;
  onClose: () => void;
}

export function EmojiPicker({ anchorRef, currentIcon, onSelect, onClose }: EmojiPickerProps) {
  const [tab, setTab] = useState<"emoji" | "icons">("icons");
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);

  const icons = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return LUCIDE_ICON_NAMES;
    return LUCIDE_ICON_NAMES.filter((n) => n.includes(q));
  }, [filter]);

  function pick(value: string | null) {
    onSelect(value);
    onClose();
  }

  return (
    <FloatingPopup anchorRef={anchorRef} onClose={onClose} className="p-2 w-64 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl">
      <div className="flex items-center gap-1 mb-2">
        {(["emoji", "icons"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setFilter("");
              if (t === "icons") {
                requestAnimationFrame(() => filterRef.current?.focus());
              }
            }}
            className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
              tab === t
                ? "bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-white"
                : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            }`}
          >
            {t === "emoji" ? "Emoji" : "Icons"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => pick(null)}
          title="Remove icon"
          className="ml-auto px-2 py-1 rounded text-xs text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          Remove
        </button>
      </div>

      {tab === "icons" ? (
        <>
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="w-full mb-2 px-2 py-1.5 rounded text-xs bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-white placeholder:text-neutral-400 outline-none"
          />
          <div className="grid grid-cols-6 gap-0.5 max-h-48 overflow-y-auto">
            {icons.map((name) => {
              const value = `lucide:${name}`;
              const selected = currentIcon === value;
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  onClick={() => pick(value)}
                  className={`w-8 h-8 flex items-center justify-center rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors ${selected ? "bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-500/50" : ""}`}
                >
                  <PageIcon icon={value} size={17} />
                </button>
              );
            })}
            {icons.length === 0 && (
              <p className="col-span-6 text-center text-xs text-neutral-400 py-4">
                No icons match “{filter}”
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-6 gap-0.5 max-h-48 overflow-y-auto">
          {EMOJIS.map((emoji, i) => (
            <button
              key={`${emoji}-${i}`}
              type="button"
              onClick={() => pick(emoji)}
              className={`w-8 h-8 flex items-center justify-center rounded text-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors ${currentIcon === emoji ? "bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-500/50" : ""}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </FloatingPopup>
  );
}
