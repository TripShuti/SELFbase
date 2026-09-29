"use client";

import { useState } from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import type { BlockComment } from "@/src/module_bindings/types";
import { useCurrentUser, useUsers } from "@/src/hooks/useUser";
import {
  useBlockComments,
  useCreateBlockComment,
  useDeleteBlockComment,
  useResolveBlockComment,
  useUpdateBlockComment,
  type CommentThread,
} from "@/src/hooks/useBlockComments";

interface CommentsPanelProps {
  pageId: bigint;
  onClose: () => void;
  /** Block id to anchor the next new comment to (from the block menu). */
  anchorBlockId: string | null;
  onClearAnchor?: () => void;
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

function authorName(
  authorHex: string,
  meHex: string | undefined,
  users: ReturnType<typeof useUsers>["users"]
): string {
  if (meHex && authorHex === meHex) return "You";
  const u = users.find((x) => x.identity.toHexString() === authorHex);
  return u?.name || u?.email || `${authorHex.slice(0, 8)}…`;
}

function AnchorChip({ blockId }: { blockId: string }) {
  return (
    <span
      title={`Anchored to block ${blockId}`}
      className="inline-block max-w-[10rem] truncate align-middle text-[10px] px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
    >
      ▸ block {blockId.slice(0, 8)}
    </span>
  );
}

function CommentCard({
  comment,
  pageId,
  depth,
  defaultReplyOpen,
}: {
  comment: BlockComment;
  pageId: bigint;
  depth: number;
  defaultReplyOpen?: boolean;
}) {
  const { identity } = useSpacetimeDB();
  const { users } = useUsers();
  const { user: currentUser } = useCurrentUser();
  const updateComment = useUpdateBlockComment();
  const resolveComment = useResolveBlockComment();
  const deleteComment = useDeleteBlockComment();
  const createComment = useCreateBlockComment();
  const [replyOpen, setReplyOpen] = useState(!!defaultReplyOpen);
  const [reply, setReply] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meHex = identity?.toHexString();
  const mine = meHex != null && comment.author.toHexString() === meHex;
  const canModerate = mine || (currentUser?.isAdmin ?? false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={depth > 0 ? "ml-5 border-l-2 border-neutral-200 dark:border-neutral-700 pl-3" : ""}>
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-neutral-900 dark:text-white truncate">
          {authorName(comment.author.toHexString(), meHex, users)}
        </span>
        <span className="text-[10px] text-neutral-400 dark:text-neutral-500 shrink-0">
          {formatTime(comment.createdAt)}
        </span>
        {comment.blockId && <AnchorChip blockId={comment.blockId} />}
      </div>
      {editing ? (
        <div className="mt-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={4000}
            disabled={busy}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 outline-none"
          />
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={() =>
                void run(async () => {
                  await updateComment({ commentId: comment.id, content: draft.trim() });
                  setEditing(false);
                })
              }
              className="px-2 py-1 rounded text-xs font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 disabled:opacity-40"
            >
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(comment.content);
                setEditing(false);
              }}
              className="px-2 py-1 rounded text-xs text-neutral-500"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-0.5 text-sm text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap break-words">
          {comment.content}
        </p>
      )}
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {depth === 0 && (
          <button
            type="button"
            onClick={() => setReplyOpen((o) => !o)}
            className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            Reply
          </button>
        )}
        {canModerate && !editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(comment.content);
              setEditing(true);
            }}
            className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            Edit
          </button>
        )}
        {canModerate && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() =>
                resolveComment({ commentId: comment.id, resolved: !comment.resolved })
              )
            }
            className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            {comment.resolved ? "Reopen" : "Resolve"}
          </button>
        )}
        {canModerate && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm("Delete this comment?")) {
                void run(() => deleteComment({ commentId: comment.id }));
              }
            }}
            className="text-xs text-neutral-500 hover:text-red-600 dark:hover:text-red-400"
          >
            Delete
          </button>
        )}
      </div>
      {replyOpen && depth === 0 && (
        <div className="mt-2">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
            maxLength={4000}
            disabled={busy}
            placeholder="Reply…"
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 outline-none"
          />
          <div className="mt-1">
            <button
              type="button"
              disabled={busy || !reply.trim()}
              onClick={() =>
                void run(async () => {
                  await createComment({
                    pageId,
                    blockId: undefined,
                    parentId: comment.id,
                    content: reply.trim(),
                  });
                  setReply("");
                  setReplyOpen(false);
                })
              }
              className="px-2 py-1 rounded text-xs font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 disabled:opacity-40"
            >
              Reply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ThreadView({ thread, pageId }: { thread: CommentThread; pageId: bigint }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        thread.root.resolved
          ? "border-neutral-200 dark:border-neutral-800 opacity-70"
          : "border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900"
      }`}
    >
      <CommentCard comment={thread.root} pageId={pageId} depth={0} />
      {thread.replies.length > 0 && (
        <div className="mt-2 space-y-2.5">
          {thread.replies.map((r) => (
            <CommentCard key={String(r.id)} comment={r} pageId={pageId} depth={1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function CommentsPanel({ pageId, onClose, anchorBlockId, onClearAnchor }: CommentsPanelProps) {
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
    <div className="flex flex-col h-full bg-white dark:bg-neutral-900 border-l border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
        <h2 className="text-sm font-medium text-neutral-900 dark:text-white flex-1">
          Comments{openCount > 0 && <span className="ml-1.5 text-xs text-neutral-500">· {openCount} open</span>}
        </h2>
        <button
          type="button"
          onClick={() => setShowResolved((s) => !s)}
          title={showResolved ? "Hide resolved" : "Show resolved"}
          className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          {showResolved ? "Hide resolved" : "Show resolved"}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close comments"
          className="p-1 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {visible.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500 text-center py-6">
            No comments yet. Start the discussion below.
          </p>
        ) : (
          visible.map((t) => <ThreadView key={String(t.root.id)} thread={t} pageId={pageId} />)
        )}
      </div>

      <div className="px-4 py-3 border-t border-neutral-200 dark:border-neutral-800">
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
          placeholder={anchorBlockId ? "Comment on this block…" : "Comment on this page…"}
          className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-2.5 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none"
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
    </div>
  );
}
