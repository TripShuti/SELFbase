"use client";

import { useEffect, useRef, useState } from "react";
import { useReducer } from "spacetimedb/react";
import { reducers } from "@/src/module_bindings";
import { useDatabaseSchema, usePropertyDefinitions } from "@/src/hooks/useDatabase";
import { useCurrentUser } from "@/src/hooks/useUser";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { EMPTY_SOURCE, TARGET_TYPES, TRANSFORMS, parseSourceConfig, type SourceConfig, type SourceStatus, type ExternalRecord } from "@/src/lib/external-sources/types";
import { externalSourceFetch } from "@/src/lib/external-sources/client";
import { FloatingPopup } from "./FloatingPopup";

const inputClass = "mt-1 block w-full rounded border border-neutral-200 dark:border-neutral-700 bg-transparent px-2 py-1.5 text-sm";

export function ExternalSourceSettings({ databaseId }: { databaseId: bigint }) {
  const { schema } = useDatabaseSchema(databaseId);
  const properties = usePropertyDefinitions(schema?.id ?? 0n);
  const { user } = useCurrentUser();
  const { activeWorkspace } = useWorkspace();
  const configure = useReducer(reducers.configureExternalSource);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SourceConfig>({ ...EMPTY_SOURCE });
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<SourceStatus | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const config = parseSourceConfig(schema?.config);
  const canConfigure = !!(user?.isAuthenticated && user.isAdmin);

  useEffect(() => {
    if (!open) return;
    const current = parseSourceConfig(schema?.config);
    setForm(current ? { ...current, mappings: [...current.mappings] } : { ...EMPTY_SOURCE, mappings: [] });
    setSecret(""); setError(""); setMessage("");
  }, [open, schema?.config]);
  useEffect(() => {
    if (!open || !activeWorkspace) return;
    const abort = new AbortController();
    externalSourceFetch<SourceStatus>(activeWorkspace.dbName, databaseId, { status: "1" }, "GET", abort.signal)
      .then(setStatus).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [open, activeWorkspace, databaseId]);

  function field(key: keyof SourceConfig, label: string, hint?: string) {
    return <label className="block text-xs" key={key}>{label}
      <input value={String(form[key])} onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))} className={inputClass} />
      {hint && <span className="mt-1 block text-[11px] text-neutral-500">{hint}</span>}
    </label>;
  }
  async function save() {
    if (!schema) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const url = new URL(form.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an HTTP or HTTPS URL");
      if (form.mappings.some(m => !m.sourcePath || !m.targetPropertyId)) throw new Error("Choose a source field and destination for each mapping");
      await configure({ databaseId, configJson: JSON.stringify(form), secret: secret || undefined });
      setSecret(""); setMessage("Connection saved. Use the link column to find and select a record.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save connection"); }
    finally { setBusy(false); }
  }
  async function testConnection() {
    if (!activeWorkspace) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await externalSourceFetch<{ records: ExternalRecord[] }>(activeWorkspace.dbName, databaseId, { q: "" });
      setMessage(result.records.length ? `Connected: ${result.records.slice(0, 3).map(r => r.label).join(", ")}` : "Connected. No records returned for an empty search.");
    } catch (e) { setError(e instanceof Error ? e.message : "Connection failed"); }
    finally { setBusy(false); }
  }

  return <>
    <button ref={anchor} type="button" onClick={() => setOpen(!open)} title="External data source"
      className="shrink-0 rounded border border-neutral-200 dark:border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800">
      {config?.enabled ? config.name : "Data source"}
    </button>
    {open && <FloatingPopup anchorRef={anchor} onClose={() => setOpen(false)}
      className="z-50 w-[min(520px,calc(100vw-16px))] max-h-[85vh] overflow-auto rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-4 shadow-xl text-neutral-900 dark:text-neutral-100">
      <h3 className="font-semibold">External data source</h3>
      <p className="mt-1 mb-3 text-xs text-neutral-500">Search an HTTP API from a table cell and keep selected fields up to date. Each database can connect to one source. Other columns stay yours.</p>
      {status && <p className="mb-3 text-xs text-neutral-500">
        {!status.serviceConfigured ? "Set up the server service token to enable external connections."
          : status.automaticSync ? "Background updates are active, including when your browser is closed."
          : "Manual refresh is available. Background updates are disabled on the server."}
        {status.lastRun && ` Last check: ${new Date(status.lastRun).toLocaleString()}.`}
        {status.error && <span className="block text-red-500">{status.error}</span>}
      </p>}
      {!canConfigure && <p className="my-3 text-xs text-neutral-500">A workspace administrator can configure this connection.</p>}
      <fieldset disabled={!canConfigure || busy} className="space-y-3 disabled:opacity-60">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.enabled} onChange={e => setForm(p => ({ ...p, enabled: e.target.checked }))} />Enable connection and synchronization</label>
        {field("name", "Connection name")}
        {field("baseUrl", "Base URL", "An address reachable by the SELFbase server, e.g. http://service:8080")}
        <details open><summary className="cursor-pointer text-sm font-medium">Search and records</summary>
          <div className="mt-2 grid grid-cols-2 gap-3">
            {field("searchPath", "Search path", "Example: /api/items?limit=20")}
            {field("queryParam", "Search query parameter", "Example: q or search")}
            {field("resultsPath", "Results array path", "Example: data.items; blank for a root array")}
            {field("detailPath", "Single-record path", "Example: /api/items/{id}")}
            {field("detailResultPath", "Single-record result path", "Blank for a root object")}
            {field("idPath", "Stable ID field", "Example: id")}
            {field("labelPath", "Display name field", "Example: name")}
            {field("subtitlePath", "Subtitle field (optional)")}
            {field("imagePath", "Image URL field (optional)")}
          </div>
          <p className="mt-2 text-[11px] text-neutral-500">Field selectors use dot paths, e.g. stats.total or items.0.name. Search and detail records should expose the same ID and label paths.</p>
        </details>
        <details><summary className="cursor-pointer text-sm font-medium">Authentication</summary>
          <div className="mt-2 grid grid-cols-2 gap-3">
            {field("authHeader", "Header name", "Blank for a public API; e.g. Authorization or X-API-Key")}
            {field("authPrefix", "Value prefix", "For bearer auth include the trailing space: Bearer ")}
            <label className="col-span-2 text-xs">Credential
              <input type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)} className={inputClass} placeholder={config ? "Leave blank to keep the saved credential" : "API token"} />
              <span className="mt-1 block text-[11px] text-neutral-500">Stored privately on the server. Re-enter it if you change the source URL.</span>
            </label>
          </div>
        </details>
        <details open><summary className="cursor-pointer text-sm font-medium">Columns to update</summary>
          <label className="mt-2 block text-xs">Record search column
            <select value={form.linkPropertyId} onChange={e => setForm(p => ({ ...p, linkPropertyId: e.target.value }))} className={inputClass}>
              <option value="">Create “External record” column</option>
              {properties.filter(p => p.propertyType.tag === "Text").map(p => <option value={String(p.id)} key={String(p.id)}>{p.name}</option>)}
            </select>
          </label>
          <p className="mt-2 text-[11px] text-neutral-500">Create destination columns in your table first, then map the API fields below. Missing or null source values preserve existing data.</p>
          {form.mappings.map((mapping, index) => <div key={index} className="mt-3 rounded border border-neutral-200 dark:border-neutral-700 p-2">
            <input aria-label={`Source field ${index + 1}`} placeholder="Source field path" value={mapping.sourcePath} className={inputClass}
              onChange={e => setForm(p => ({ ...p, mappings: p.mappings.map((m, i) => i === index ? { ...m, sourcePath: e.target.value } : m) }))} />
            <select aria-label={`Destination column ${index + 1}`} value={mapping.targetPropertyId} className={inputClass} onChange={e => {
              const property = properties.find(p => String(p.id) === e.target.value);
              if (!property) return;
              setForm(p => ({ ...p, mappings: p.mappings.map((m, i) => i === index ? { ...m, targetPropertyId: String(property.id), targetType: property.propertyType.tag as typeof m.targetType } : m) }));
            }}>
              <option value="">Choose destination column</option>
              {properties.filter(p => (TARGET_TYPES as readonly string[]).includes(p.propertyType.tag) && String(p.id) !== form.linkPropertyId).map(p => <option key={String(p.id)} value={String(p.id)}>{p.name} · {p.propertyType.tag}</option>)}
            </select>
            <div className="flex gap-2">
              <select aria-label={`Value transform ${index + 1}`} className={inputClass} value={mapping.transform}
                onChange={e => setForm(p => ({ ...p, mappings: p.mappings.map((m, i) => i === index ? { ...m, transform: e.target.value as typeof m.transform } : m) }))}>
                {TRANSFORMS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button type="button" onClick={() => setForm(p => ({ ...p, mappings: p.mappings.filter((_, i) => i !== index) }))} className="px-2 text-xs text-red-500">Remove</button>
            </div>
          </div>)}
          <button type="button" disabled={form.mappings.length >= 32} onClick={() => setForm(p => ({ ...p, mappings: [...p.mappings, { sourcePath: "", targetPropertyId: "", targetType: "Text", transform: "identity" }] }))}
            className="mt-2 rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-neutral-800">+ Map another field</button>
        </details>
        <label className="block text-xs">Refresh interval (seconds)
          <input type="number" min={60} max={86400} value={form.syncIntervalSeconds} className={inputClass} onChange={e => setForm(p => ({ ...p, syncIntervalSeconds: Number(e.target.value) }))} />
        </label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.fillEmptyTitle} onChange={e => setForm(p => ({ ...p, fillEmptyTitle: e.target.checked }))} />Use record name for an empty row title</label>
      </fieldset>
      {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
      {message && <p role="status" className="mt-3 text-xs text-green-600">{message}</p>}
      <div className="mt-4 flex justify-end gap-2">
        {config?.enabled && <button disabled={busy} onClick={testConnection} className="rounded px-3 py-1.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800">Test saved connection</button>}
        <button disabled={busy || !schema || !canConfigure} onClick={save} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">{busy ? "Working…" : "Save connection"}</button>
      </div>
    </FloatingPopup>}
  </>;
}
