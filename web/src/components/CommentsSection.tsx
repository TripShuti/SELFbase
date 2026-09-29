"use client";

import { useState } from "react";
import {
  useBlockComments,
  useCreateBlockComment,
} from "@/src/hooks/useBlockComments";
import { AnchorChip, ThreadView } from "./CommentsThread";

/**
 * Notion-style inline comments section: lives at the bottom of the page,
 * below properties and content. Same threads as the side panel.
 */
export function CommentsSection({
  pageId,
  anchorBlockId,
  onClearAnchor,
}: {
  pageId: bigint;
  anchorBlockId: string | null;
  onClearAnchor?: () => void;
}) {
  const { threads, openCount } = useBlockComments(pageId);
  const createComment = useCreateBlockComment();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const visible = threads.filter((t) => showResolved || !t.root.resolved);

  async function post() {
    const content = draft.trim();
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      await createComment({
        pageId,
        blockId: anchorBlockId ?? undefined,
        parentId: undefined,
        content,
      });
      setDraft("");
      onClearAnchor?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-10 border-t border-neutral-200 dark:border-neutral-800 pt-4">
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide flex-1">
          Comments{openCount > 0 && <span className="ml-1.5 normal-case">· {openCount} open</span>}
        </h2>
        <button
          type="button"
          onClick={() => setShowResolved((s) => !s)}
          className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          {showResolved ? "Hide resolved" : "Show resolved"}
        </button>
      </div>

      <div className="space-y-6">
        {visible.map((t) => (
          <ThreadView key={String(t.root.id)} thread={t} pageId={pageId} />
        ))}
      </div>

      <div className="mt-4">
        {anchorBlockId && (
          <div className="mb-1.5 flex items-center gap-2">
            <AnchorChip blockId={anchorBlockId} />
            <button
              type="button"
              onClick={onClearAnchor}
              className="text-xs text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300"
            >
              ✕
            </button>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          maxLength={4000}
          disabled={busy}
          placeholder={anchorBlockId ? "Comment on this block…" : "Add a comment…"}
          className="w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2.5 text-sm text-neutral-900 dark:text-neutral-100 outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-600"
        />
        {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() => void post()}
            className="px-3 py-1.5 rounded text-sm font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 disabled:opacity-40"
          >
            Comment
          </button>
        </div>
      </div>
    </section>
  );
}
