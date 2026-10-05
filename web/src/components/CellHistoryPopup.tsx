"use client";

import { useMemo, type RefObject } from "react";
import { FloatingPopup } from "./FloatingPopup";
import { renderValueFallback } from "./PropertyCell";
import {
  usePagePropertyValues,
  usePropertyValueHistory,
} from "@/src/hooks/useDatabase";
import { useSetPropertyValue } from "@/src/hooks/usePages";

interface CellHistoryPopupProps {
  pageId: bigint;
  propertyDefinitionId: bigint;
  /** Cell element the popup anchors to. */
  anchor: HTMLElement;
  onClose: () => void;
}

function actorLabel(changedBy: { tag: string; value?: unknown }): string {
  if (changedBy.tag === "Human") return "You";
  if (changedBy.tag === "Agent" && typeof changedBy.value === "string")
    return changedBy.value;
  return "Unknown";
}

function formatTime(ts: { microsSinceUnixEpoch: bigint }): string {
  const ms = Number(ts.microsSinceUnixEpoch) / 1000;
  const d = new Date(ms);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
  });
}

// JSON.stringify crashes on bigint (Date / Relation values carry u64s).
function valueKey(v: unknown): string {
  if (v !== null && typeof v === "object" && "tag" in v) {
    const { tag, value } = v as { tag: unknown; value: unknown };
    const norm = (x: unknown): string =>
      typeof x === "bigint"
        ? `#${x.toString()}`
        : Array.isArray(x)
          ? `[${x.map(norm).join(",")}]`
          : JSON.stringify(x) ?? "";
    return `${String(tag)}:${norm(value)}`;
  }
  return String(v);
}

export function CellHistoryPopup({
  pageId,
  propertyDefinitionId,
  anchor,
  onClose,
}: CellHistoryPopupProps) {
  const anchorRef = useMemo(
    () => ({ current: anchor }) as RefObject<HTMLElement | null>,
    [anchor],
  );
  const history = usePropertyValueHistory(pageId, propertyDefinitionId);
  const currentValues = usePagePropertyValues(pageId);
  const setPropertyValue = useSetPropertyValue();

  const currentKey = useMemo(() => {
    const cur = currentValues.find(
      (v) => v.propertyDefinitionId === propertyDefinitionId,
    );
    return cur ? valueKey(cur.value) : null;
  }, [currentValues, propertyDefinitionId]);

  async function handleRestore(value: unknown) {
    await setPropertyValue({
      pageId,
      propertyDefinitionId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: value as any,
    });
    onClose();
  }

  const shown = history.slice(0, 50);

  return (
    <FloatingPopup
      anchorRef={anchorRef}
      onClose={onClose}
      className="w-72 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl overflow-hidden"
    >
      <div className="px-3 py-2 text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider border-b border-neutral-100 dark:border-neutral-700">
        Cell history
      </div>
      <div className="max-h-72 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="px-3 py-3 text-sm text-neutral-400 dark:text-neutral-600 italic">
            No recorded changes
          </p>
        ) : (
          <ul>
            {shown.map((h) => {
              const isCurrent = currentKey != null && valueKey(h.value) === currentKey;
              return (
                <li
                  key={String(h.id)}
                  className="flex items-center gap-2 px-3 py-1.5 border-b border-neutral-50 dark:border-neutral-700/50 last:border-0 group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-neutral-800 dark:text-neutral-200 truncate">
                      {renderValueFallback(
                        h.value as Parameters<typeof renderValueFallback>[0],
                      ) || (
                        <span className="text-neutral-400 dark:text-neutral-600 italic">
                          Empty
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-neutral-400 dark:text-neutral-500">
                      {actorLabel(h.changedBy)} · {formatTime(h.changedAt)}
                      {isCurrent ? " · current" : ""}
                    </div>
                  </div>
                  {!isCurrent && (
                    <button
                      onClick={() => void handleRestore(h.value)}
                      className="flex-shrink-0 text-xs px-2 py-0.5 rounded text-blue-600 dark:text-blue-400 opacity-0 group-hover:opacity-100 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-all"
                      title="Restore this value"
                    >
                      Restore
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </FloatingPopup>
  );
}
