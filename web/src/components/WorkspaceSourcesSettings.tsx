"use client";

import { useState } from "react";
import { useReducer, useTable } from "spacetimedb/react";
import { reducers, tables } from "@/src/module_bindings";
import { useCurrentUser } from "@/src/hooks/useUser";
import { useWorkspaceSettings } from "@/src/hooks/useWorkspaceSettings";
import { EMPTY_SOURCE, workspaceSources, parseSourceConfigs, type SourceConfig } from "@/src/lib/external-sources/types";
import { SourceConnectionFields } from "./SourceConnectionFields";

export function WorkspaceSourcesSettings() {
  const { user } = useCurrentUser();
  const [settings, ready] = useWorkspaceSettings();
  const [schemas] = useTable(tables.database_schema);
  const sources = workspaceSources(settings);
  const saveSource = useReducer(reducers.saveSharedExternalSource);
  const deleteSource = useReducer(reducers.deleteSharedExternalSource);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SourceConfig>({ ...EMPTY_SOURCE });
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const canEdit = !!(user?.isAuthenticated && user.isAdmin);
  function edit(source?: SourceConfig) {
    setEditingId(source?.sourceId || crypto.randomUUID());
    setForm(source ? { ...source, syncMode: source.syncMode || "interval", syncIntervalSeconds: source.syncMode ? source.syncIntervalSeconds : 21600 } : { ...EMPTY_SOURCE, syncMode: "interval", mappings: [] });
    setSecret(""); setError(""); setMessage("");
  }
  async function save() {
    if (!editingId) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await saveSource({ sourceId: editingId, configJson: JSON.stringify(form), secret: secret || undefined, importDatabaseId: undefined });
      setEditingId(null); setSecret("");
      setMessage("Workspace source saved. Select it from Data source in any database.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save source"); }
    finally { setBusy(false); }
  }
  async function remove(sourceId: string) {
    setBusy(true); setError(""); setMessage("");
    try {
      await deleteSource({ sourceId });
      if (editingId === sourceId) { setEditingId(null); setSecret(""); }
      setMessage("Source removed.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not remove source"); }
    finally { setBusy(false); }
  }
  return <section id="data-sources" className="mb-10 scroll-mt-6">
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Data sources</h2>
      {canEdit && <button type="button" disabled={busy} onClick={() => edit()} className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-neutral-100 dark:hover:bg-neutral-800">+ New Source</button>}
    </div>
    <p className="mb-4 text-xs text-neutral-500">Connect to an external HTTP API once and reuse it across your databases. Each database chooses its own columns to update.</p>
    {!ready ? <p className="text-xs text-neutral-500">Loading sources…</p> : !sources.length && <p className="text-sm text-neutral-500">No workspace sources yet. Create one here, or make an existing database connection reusable from its Data source settings.</p>}
    {sources.map(source => {
      const count = schemas.filter(s => parseSourceConfigs(s.config).some(c => c.sourceId === source.sourceId)).length;
      return <div key={source.sourceId} className="flex items-center gap-2 border-b border-neutral-200 py-3 dark:border-neutral-800">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{source.name}</div>
          <div className="truncate text-xs text-neutral-500">{source.baseUrl}</div>
          <div className="text-xs text-neutral-500">{count} connected database{count === 1 ? "" : "s"}</div>
        </div>
        {canEdit && <>
          <button disabled={busy} onClick={() => edit(source)} className="px-2 py-1 text-xs text-blue-600">Edit</button>
          <button disabled={busy || count > 0} title={count ? "Disconnect databases before removing this source" : "Remove source"} onClick={() => remove(source.sourceId!)} className="px-2 py-1 text-xs text-red-500 disabled:opacity-40">Remove</button>
        </>}
      </div>;
    })}
    {editingId && <div className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
      <h3 className="mb-3 text-sm font-medium">{sources.some(s => s.sourceId === editingId) ? "Edit workspace source" : "New workspace source"}</h3>
      <fieldset disabled={!canEdit || busy} className="space-y-3 disabled:opacity-50">
        <SourceConnectionFields form={form} setForm={setForm} secret={secret} setSecret={setSecret} />
        <p className="text-xs text-neutral-500">Changes apply to every connected database. Existing field mappings and record links are kept. Credentials are private and are not included in workspace snapshots.</p>
      </fieldset>
      <div className="mt-4 flex justify-end gap-2">
        <button disabled={busy} onClick={() => { setEditingId(null); setSecret(""); }} className="rounded px-3 py-1.5 text-xs">Cancel</button>
        <button disabled={busy || !canEdit} onClick={save} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">{busy ? "Saving…" : "Save source"}</button>
      </div>
    </div>}
    {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
    {message && <p role="status" className="mt-3 text-xs text-green-600">{message}</p>}
  </section>;
}
