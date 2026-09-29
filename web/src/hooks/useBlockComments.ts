"use client";

import { useMemo } from "react";
import { useReducer, useSpacetimeDB, useTable } from "spacetimedb/react";
import { reducers, tables } from "@/src/module_bindings";
import type { BlockComment } from "@/src/module_bindings/types";

export type CommentThread = {
  root: BlockComment;
  replies: BlockComment[];
};

function samePage(row: BlockComment, pageId: bigint): boolean {
  return row.pageId === pageId;
}

/** Live comments for a page, grouped into threads (roots + replies). */
export function useBlockComments(pageId: bigint): {
  threads: CommentThread[];
  openCount: number;
  ready: boolean;
} {
  const { isActive } = useSpacetimeDB();
  const [rows] = useTable(tables.block_comment);
  const mine = useMemo(
    () => rows.filter((r) => samePage(r, pageId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, pageId, isActive]
  );
  const threads = useMemo<CommentThread[]>(() => {
    const byId = new Map<string, BlockComment>();
    for (const r of mine) byId.set(String(r.id), r);
    const roots: BlockComment[] = [];
    const replies = new Map<string, BlockComment[]>();
    for (const r of mine) {
      if (r.parentId == null) {
        roots.push(r);
      } else {
        const key = String(r.parentId);
        // Orphaned replies (parent deleted without cascade, legacy rows)
        // render as roots rather than vanishing.
        if (!byId.has(key)) {
          roots.push(r);
        } else {
          const list = replies.get(key) ?? [];
          list.push(r);
          replies.set(key, list);
        }
      }
    }
    roots.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    for (const list of replies.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    }
    return roots.map((root) => ({
      root,
      replies: replies.get(String(root.id)) ?? [],
    }));
  }, [mine]);
  const openCount = useMemo(
    () => threads.filter((t) => !t.root.resolved).length,
    [threads]
  );
  return { threads, openCount, ready: isActive };
}

export function useCreateBlockComment() {
  return useReducer(reducers.createBlockComment);
}

export function useUpdateBlockComment() {
  return useReducer(reducers.updateBlockComment);
}

export function useResolveBlockComment() {
  return useReducer(reducers.resolveBlockComment);
}

export function useDeleteBlockComment() {
  return useReducer(reducers.deleteBlockComment);
}
