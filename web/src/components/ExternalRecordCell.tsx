"use client";

import { useEffect, useRef, useState } from "react";
import { useReducer } from "spacetimedb/react";
import { reducers } from "@/src/module_bindings";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { parseRecordLink, isEmptyRowTitle, type ExternalRecord } from "@/src/lib/external-sources/types";
import { externalSourceFetch } from "@/src/lib/external-sources/client";
import { FloatingPopup } from "./FloatingPopup";

export function ExternalRecordCell({ pageId, databaseId, value, forceEdit, onClose,
  variant = "cell", rowTitle = "", sourceEnabled = true, sourceName = "",
}: {
  pageId: bigint; databaseId?: bigint; value: string; forceEdit?: boolean; onClose?: () => void;
  variant?: "cell" | "title"; rowTitle?: string; sourceEnabled?: boolean; sourceName?: string;
}) {
  const { activeWorkspace } = useWorkspace();
  const linkRecord = useReducer(reducers.linkExternalRecord);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<ExternalRecord[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const db = activeWorkspace?.dbName;
  const link = parseRecordLink(value);
  function close() { setOpen(false); onClose?.(); }
  useEffect(() => { if (forceEdit) setOpen(true); }, [forceEdit]);
  useEffect(() => { if (open) { setQuery(isEmptyRowTitle(rowTitle) ? "" : rowTitle); setError(""); } }, [open, rowTitle]);
  useEffect(() => {
    if (!open || !db || databaseId == null || !sourceEnabled) return;
    const abort = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      externalSourceFetch<{ records: ExternalRecord[] }>(db, databaseId, { q: query }, "GET", abort.signal)
        .then(data => { setRecords(data.records); setError(""); })
        .catch(e => { if (!abort.signal.aborted) setError(e.message); })
        .finally(() => { if (!abort.signal.aborted) setSearching(false); });
    }, 250);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [open, db, databaseId, query, sourceEnabled]);
  async function choose(record: ExternalRecord) {
    if (!db || databaseId == null) return;
    setBusy(true); setError("");
    try {
      await linkRecord({ rowId: pageId, recordId: record.id, label: record.label });
      await externalSourceFetch(db, databaseId, { rowId: String(pageId) }, "POST");
      close();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not link record"); }
    finally { setBusy(false); }
  }
  async function refresh() {
    if (!db || databaseId == null) return;
    setBusy(true); setError("");
    try { await externalSourceFetch(db, databaseId, { rowId: String(pageId) }, "POST"); close(); }
    catch (e) { setError(e instanceof Error ? e.message : "Refresh failed"); }
    finally { setBusy(false); }
  }
  const action = link ? "Manage source link" : isEmptyRowTitle(rowTitle) ? "Add from source" : "Link to source";
  return <>
    <button ref={anchor} type="button" disabled={databaseId == null || (!sourceEnabled && !link)}
      onClick={e => { e.stopPropagation(); setOpen(true); }}
      onMouseDown={e => e.stopPropagation()}
      aria-label={variant === "title" ? `${action}: ${rowTitle || "Untitled"}` : undefined}
      className={variant === "title"
        ? `inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-xs transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800 ${link ? "text-blue-600 dark:text-blue-400" : "text-neutral-400 hover:text-blue-600 dark:hover:text-blue-400"}`
        : "h-full w-full truncate px-2 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800/50"}
      title={link ? `Linked to ${sourceName || "external source"}: ${link.label || link.id}. Refresh, change or unlink.` : action}>
      {variant === "title" ? <>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l2-2" />
        </svg>
        {!link && isEmptyRowTitle(rowTitle) && <span>Add from source</span>}
      </> : link ? link.label || link.id : <span className="text-neutral-400">Search external records…</span>}
    </button>
    {open && <FloatingPopup anchorRef={anchor} onClose={close}
      className="z-50 w-[min(380px,calc(100vw-16px))] rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-3 shadow-xl text-neutral-900 dark:text-neutral-100">
      <div onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === "Escape") close(); e.stopPropagation(); }}>
      {!sourceEnabled && <p className="mb-2 text-xs text-neutral-500">This source is disabled. Saved values are kept; you can unlink this row.</p>}
      {sourceEnabled && <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search connected source…" aria-label="Search external records"
        className="w-full rounded border border-neutral-200 dark:border-neutral-700 bg-transparent px-2 py-2 text-sm outline-none focus:border-blue-500" />}
      {sourceEnabled && !isEmptyRowTitle(rowTitle) && <p className="mt-2 text-[11px] text-neutral-500">Your row name will stay unchanged.</p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
      {sourceEnabled && <div className="mt-2 max-h-64 overflow-auto">
        {searching && <p className="p-2 text-xs text-neutral-500">Searching…</p>}
        {!searching && !error && records.length === 0 && <p className="p-2 text-xs text-neutral-500">No matching records found.</p>}
        {!searching && records.map(record => <button key={record.id} disabled={busy} onClick={() => choose(record)}
          className="flex w-full items-center gap-3 rounded p-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50">
          {record.image && <img src={record.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-10 w-10 rounded object-cover" />}
          <span className="min-w-0 flex-1"><span className="block truncate text-sm">{record.label}</span>
            {record.subtitle && <span className="block text-xs text-neutral-500">{record.subtitle}</span>}</span>
        </button>)}
      </div>}
      {link && <div className="mt-2 flex items-center justify-between border-t border-neutral-200 dark:border-neutral-700 pt-2 text-xs">
        <button disabled={busy || !sourceEnabled} onClick={refresh} className="rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">{busy ? "Updating…" : "Refresh now"}</button>
        <button disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          try { await linkRecord({ rowId: pageId, recordId: "", label: "" }); close(); }
          catch (e) { setError(e instanceof Error ? e.message : "Could not unlink"); }
          finally { setBusy(false); }
        }} className="rounded px-2 py-1 text-neutral-500 hover:text-red-500">Unlink · keep values</button>
      </div>}
      </div>
    </FloatingPopup>}
  </>;
}
