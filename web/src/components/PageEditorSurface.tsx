"use client";

import type { PageContent } from "@/src/module_bindings/types";
import type { PageRow } from "@/src/hooks/usePages";
import { useMigrateBlockNotePageOnOpen } from "@/src/hooks/useMigrateBlockNotePageOnOpen";
import { ComponentTreeRenderer } from "./component-renderers";
import { PageMigratingShell } from "./PageMigratingShell";

export type PageEditorSurfaceProps = {
  page: PageRow;
  content: PageContent | undefined;
  /** Open the comments panel anchored to a block (from the block menu). */
  onCommentBlock?: (blockId: string) => void;
  /** Editor remount key — e.g. content updatedAt in modals. */
  editorKeySuffix?: string | number;
};

/**
 * Doc body: ComponentTree when migrated; legacy BlockNote pages lazy-migrate
 * on first open. Pages that cannot migrate (migration disabled or failed)
 * show a blocking shell — the legacy BlockNote editor has been removed.
 */
export function PageEditorSurface({
  page,
  content,
  onCommentBlock,
  editorKeySuffix = "",
}: PageEditorSurfaceProps) {
  const migration = useMigrateBlockNotePageOnOpen(page, content?.content);

  if (migration.showComponentTree) {
    // `key` forces a fresh editor instance per page. Without it, navigating
    // between ComponentTree pages reuses ComponentTreeRenderer's instance state
    // — focus/undo coordinators (created once via useRef) and any in-flight
    // optimistic blocks — which could carry one page's content/undo stack onto
    // another.
    return (
      <ComponentTreeRenderer
        key={`${page.id}-${editorKeySuffix}`}
        surfaceId={page.id}
        onCommentBlock={onCommentBlock}
      />
    );
  }

  if (migration.status === "failed") {
    return (
      <PageMigratingShell error={migration.error} onRetry={migration.retry} />
    );
  }

  if (migration.status === "disabled") {
    return <PageMigratingShell disabled />;
  }

  return <PageMigratingShell />;
}
