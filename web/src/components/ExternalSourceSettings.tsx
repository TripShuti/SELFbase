"use client";

import { useEffect, useRef, useState } from "react";
import { useReducer, useTable } from "spacetimedb/react";
import { reducers, tables } from "@/src/module_bindings";
import { useDatabaseSchema, usePropertyDefinitions } from "@/src/hooks/useDatabase";
import { useCurrentUser } from "@/src/hooks/useUser";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { EMPTY_SOURCE, TARGET_TYPES, TRANSFORMS, parseSourceConfig, parseSourceConfigs, isExternalLinkColumn, type SourceConfig, type SourceStatus, type ExternalRecord } from "@/src/lib/external-sources/types";
import { externalSourceFetch } from "@/src/lib/external-sources/client";
import { ExternalMappingOptions } from "./ExternalMappingOptions";
import { SourceConnectionFields } from "./SourceConnectionFields";
import { useWorkspaceSettings } from "@/src/hooks/useWorkspaceSettings";
import { workspaceSources, copySourceMappings } from "@/src/lib/external-sources/types";
import { FloatingPopup } from "./FloatingPopup";

const inputClass = "mt-1 block w-full rounded border border-neutral-200 dark:border-neutral-700 bg-transparent px-2 py-1.5 text-sm";

export function ExternalSourceSettings({ databaseId }: { databaseId: bigint }) {
  const { schema } = useDatabaseSchema(databaseId);
  const properties = usePropertyDefinitions(schema?.id ?? 0n);
  const { user } = useCurrentUser();
  const { activeWorkspace } = useWorkspace();
  const configure = useReducer(reducers.configureExternalSource);
  const disconnect = useReducer(reducers.disconnectExternalSource);
  const saveShared = useReducer(reducers.saveSharedExternalSource);
  const [settings] = useWorkspaceSettings();
  const sources = workspaceSources(settings);
  const [schemas] = useTable(tables.database_schema);
  const [allProperties] = useTable(tables.property_definition);
  const [copyFrom, setCopyFrom] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SourceConfig>({ ...EMPTY_SOURCE });
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<SourceStatus | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const connections = parseSourceConfigs(schema?.config);
  const primary = connections[0];
  const config = connections.find(c => c.sourceId === form.sourceId) || (!form.sourceId ? primary : undefined);
  const canConfigure = !!(user?.isAuthenticated && user.isAdmin);

  useEffect(() => {
    if (!open) return;
    const current = parseSourceConfigs(schema?.config);
    setForm(previous => {
      const selected = current.find(c => c.sourceId === previous.sourceId) || current[0];
      return selected ? { ...selected, mappings: [...selected.mappings] } : { ...EMPTY_SOURCE, mappings: [] };
    });
    setSecret(""); setError(""); setMessage("");
  }, [open, schema?.config]);
  useEffect(() => {
    if (!open) return;
    setForm(previous => {
      let changed = false;
      const mappings = previous.mappings.map(mapping => {
        const property = properties.find(p => String(p.id) === mapping.targetPropertyId);
        if (!property || property.propertyType.tag === mapping.targetType || !(TARGET_TYPES as readonly string[]).includes(property.propertyType.tag)) return mapping;
        changed = true;
        return { ...mapping, targetType: property.propertyType.tag as typeof mapping.targetType,
          ...(!["Select", "Text"].includes(property.propertyType.tag) && mapping.transform === "statusRules" ? { transform: "identity" as const, rules: undefined, defaultValue: undefined } : {}),
          ...(property.propertyType.tag !== "Select" ? { preserveValues: undefined } : {}),
          ...(property.propertyType.tag !== "Date" ? { related: undefined, zeroIsEmpty: undefined } : {}) };
      });
      return changed ? { ...previous, mappings } : previous;
    });
  }, [open, properties, schema?.config]);
  useEffect(() => {
    if (!open || !activeWorkspace) return;
    const abort = new AbortController();
    externalSourceFetch<SourceStatus>(activeWorkspace.dbName, databaseId, { status: "1", sourceId: form.sourceId || "" }, "GET", abort.signal)
      .then(setStatus).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [open, activeWorkspace, databaseId, form.sourceId]);

  async function save() {
    if (!schema) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const url = new URL(form.baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an HTTP or HTTPS URL");
      if (form.mappings.some(m => !m.sourcePath || !m.targetPropertyId)) throw new Error("Choose a source field and destination for each mapping");
      await configure({ databaseId, configJson: JSON.stringify({ ...form, mappings: form.mappings.map(m => ({ ...m, ...(m.preserveValues ? { preserveValues: m.preserveValues.map(s => s.trim()).filter(Boolean) } : {}) })) }), secret: form.sourceId ? undefined : secret || undefined });
      setSecret(""); setMessage("Connection saved. Use Add from source beside a row name to select a record.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save connection"); }
    finally { setBusy(false); }
  }
  async function makeReusable() {
    if (!config) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await saveShared({ sourceId: crypto.randomUUID(), configJson: JSON.stringify(config), secret: undefined, importDatabaseId: databaseId });
      setMessage("Saved as a workspace source. Other databases can now select it without entering the credential.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save workspace source"); }
    finally { setBusy(false); }
  }
  function selectSource(id: string) {
    const selected = connections.find(source => source.sourceId === id) || sources.find(source => source.sourceId === id);
    if (!selected) return;
    setSecret(""); setCopyFrom("");
    const saved = connections.find(source => source.sourceId === id);
    setForm(previous => saved ? { ...saved, mappings: [...saved.mappings] } : {
      ...selected, enabled: true, linkPropertyId: primary?.linkPropertyId || "", mappings: [],
      fillEmptyTitle: previous.fillEmptyTitle,
    });
  }
  function copyMappings(pageId: string) {
    setCopyFrom(pageId);
    const other = schemas.find(s => String(s.pageId) === pageId);
    const source = parseSourceConfigs(other?.config).find(c => c.sourceId === form.sourceId);
    if (!other || !source) return;
    const mappings = copySourceMappings(source.mappings, allProperties.filter(p => p.schemaId === other.id), properties);
    setForm(p => ({ ...p, mappings }));
    setMessage(`Copied ${mappings.length} of ${source.mappings.length} mappings by matching column name and type. Review before saving.`);
  }
  async function testConnection() {
    if (!activeWorkspace) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await externalSourceFetch<{ records: ExternalRecord[] }>(activeWorkspace.dbName, databaseId, { q: "", sourceId: form.sourceId || "" });
      setMessage(result.records.length ? `Connected: ${result.records.slice(0, 3).map(r => r.label).join(", ")}` : "Connected. No records returned for an empty search.");
    } catch (e) { setError(e instanceof Error ? e.message : "Connection failed"); }
    finally { setBusy(false); }
  }

  async function refreshConnection() {
    if (!activeWorkspace || !config) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await externalSourceFetch<{ updated: number; failed: number }>(activeWorkspace.dbName, databaseId, { action: "refreshSource", sourceId: config.sourceId || "" }, "POST");
      setMessage("Refreshed " + result.updated + " linked records.");
      if (result.failed) setError(result.failed + " records could not be refreshed; saved values were kept.");
    } catch (e) { setError(e instanceof Error ? e.message : "Refresh failed"); }
    finally { setBusy(false); }
  }
  async function disconnectConnection() {
    if (!config) return;
    setBusy(true); setError(""); setMessage("");
    try { await disconnect({ databaseId, sourceId: config.sourceId || "" }); setMessage("Source disconnected. Saved values were kept."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not disconnect"); }
    finally { setBusy(false); }
  }
  return <>
    <button ref={anchor} type="button" onClick={() => setOpen(!open)} title="External data source"
      className="shrink-0 rounded border border-neutral-200 dark:border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800">
      {connections.length > 1 ? "Data sources (" + connections.length + ")" : primary?.enabled ? primary.name : "Data source"}
    </button>
    {open && <FloatingPopup anchorRef={anchor} onClose={() => setOpen(false)}
      className="z-50 w-[min(520px,calc(100vw-16px))] max-h-[85vh] overflow-auto rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-4 shadow-xl text-neutral-900 dark:text-neutral-100">
      <h3 className="font-semibold">External data source</h3>
      <p className="mt-1 mb-3 text-xs text-neutral-500">Search an HTTP API from the Name column and keep selected fields up to date. Choose a saved workspace source, then map the fields for this database.</p>
      {status && <p className="mb-3 text-xs text-neutral-500">
        {!status.serviceConfigured ? "Set up the server service token to enable external connections."
          : status.syncMode === "manual" ? "Automatic refresh is off for this source. Use manual refresh when needed."
          : status.automaticSync ? "Background updates are active, including when your browser is closed."
          : "Manual refresh is available. Background updates are disabled on the server."}
        {status.lastRun && ` Last check: ${new Date(status.lastRun).toLocaleString()}.`}
        {status.waitingForChange && <span className="block">No new successful source revision. Saved values are unchanged.</span>}
        {status.error && <span className="block text-red-500">{status.error}</span>}
      </p>}
      {!canConfigure && <p className="my-3 text-xs text-neutral-500">A workspace administrator can configure this connection.</p>}
      <fieldset disabled={!canConfigure || busy} className="space-y-3 disabled:opacity-60">
        <label className="block text-xs">Workspace source
          <select aria-label="Workspace source" className={inputClass} value={form.sourceId || ""} onChange={e => selectSource(e.target.value)}>
            <option value="" disabled>{config && !config.sourceId ? "Existing database connection" : "Choose a saved source"}</option>
            {sources.map(source => <option key={source.sourceId} value={source.sourceId}>{source.name}{connections.some(c => c.sourceId === source.sourceId) ? " · connected" : ""}</option>)}
          </select>
        </label>
        <p className="text-xs text-neutral-500"><a href="/workspace/settings#data-sources" className="text-blue-600 underline">Manage workspace sources</a></p>
        {config && !config.sourceId && <button type="button" onClick={makeReusable} className="rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-700">Make saved connection reusable</button>}
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.enabled} onChange={e => setForm(p => ({ ...p, enabled: e.target.checked }))} />Enable connection and synchronization</label>
        {!form.sourceId && config && <SourceConnectionFields form={form} setForm={setForm} secret={secret} setSecret={setSecret} />}
        {form.sourceId && <p className="text-xs text-neutral-500">Address and credentials are managed once in <a href="/workspace/settings#data-sources" className="text-blue-600 underline">Settings → Data sources</a>.</p>}
        <details open><summary className="cursor-pointer text-sm font-medium">Columns to update</summary>
          <p className="mt-2 text-xs text-neutral-500">Use Add from source or the link icon beside a row name. Existing record links are kept automatically.</p>
          {form.mappings.length === 0 && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">No fields are mapped yet. Selecting a record can fill its name; map fields below to also fill other columns.</p>}
          <p className="mt-2 text-[11px] text-neutral-500">Create destination columns in your table first, then map the API fields below. Missing or null source values preserve existing data.</p>
          {form.sourceId && <label className="mt-3 block text-xs">Copy mappings from another database
            <select aria-label="Copy mappings from database" className={inputClass} value={copyFrom} onChange={e => copyMappings(e.target.value)}>
              <option value="">Choose a database with matching columns</option>
              {schemas.filter(s => s.pageId !== databaseId && parseSourceConfigs(s.config).some(c => c.sourceId === form.sourceId)).map(s => <option key={String(s.pageId)} value={String(s.pageId)}>{s.name}</option>)}
            </select>
          </label>}
          {form.mappings.map((mapping, index) => <div key={index} className="mt-3 rounded border border-neutral-200 dark:border-neutral-700 p-2">
            <input aria-label={`Source field ${index + 1}`} placeholder="Source field path" value={mapping.sourcePath} className={inputClass}
              onChange={e => setForm(p => ({ ...p, mappings: p.mappings.map((m, i) => i === index ? { ...m, sourcePath: e.target.value } : m) }))} />
            <select aria-label={`Destination column ${index + 1}`} value={mapping.targetPropertyId} className={inputClass} onChange={e => {
              const property = properties.find(p => String(p.id) === e.target.value);
              if (!property) return;
              setForm(p => ({ ...p, mappings: p.mappings.map((m, i) => i === index ? { ...m, targetPropertyId: String(property.id), targetType: property.propertyType.tag as typeof m.targetType,
                ...(!["Select", "Text"].includes(property.propertyType.tag) && m.transform === "statusRules" ? { transform: "identity" as const, rules: undefined, defaultValue: undefined } : {}),
                ...(property.propertyType.tag !== "Select" ? { preserveValues: undefined } : {}),
                ...(property.propertyType.tag !== "Date" ? { related: undefined, zeroIsEmpty: undefined } : {}) } : m) }));
            }}>
              <option value="">Choose destination column</option>
              {properties.filter(p => (TARGET_TYPES as readonly string[]).includes(p.propertyType.tag) && String(p.id) !== form.linkPropertyId && !isExternalLinkColumn(p.config)).map(p => <option key={String(p.id)} value={String(p.id)}>{p.name} · {p.propertyType.tag}</option>)}
            </select>
            <div className="flex gap-2">
              <select aria-label={`Value transform ${index + 1}`} className={inputClass} value={mapping.transform}
                onChange={e => setForm(p => ({ ...p, mappings: p.mappings.map((m, i) => i === index ? { ...m, transform: e.target.value as typeof m.transform,
                  ...(e.target.value === "statusRules" ? { rules: m.rules?.length ? m.rules : [{ path: m.sourcePath, operator: "equals" as const, value: "true", result: "Completed" }] } : { rules: undefined, defaultValue: undefined }),
                  ...(e.target.value !== "isoDateToMillis" ? { related: undefined, zeroIsEmpty: undefined } : {}) } : m) }))}>
                {TRANSFORMS.map(([value, label]) => <option key={value} value={value} disabled={value === "statusRules" && !["Select", "Text"].includes(mapping.targetType)}>{label}</option>)}
              </select>
              <button type="button" onClick={() => setForm(p => ({ ...p, mappings: p.mappings.filter((_, i) => i !== index) }))} className="px-2 text-xs text-red-500">Remove</button>
            </div>
            <ExternalMappingOptions mapping={mapping} onChange={updated => setForm(p => ({ ...p, mappings: p.mappings.map((m, i) => i === index ? updated : m) }))} />
          </div>)}
          <button type="button" disabled={form.mappings.length >= 32} onClick={() => setForm(p => ({ ...p, mappings: [...p.mappings, { sourcePath: "", targetPropertyId: "", targetType: "Text", transform: "identity" }] }))}
            className="mt-2 rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:hover:bg-neutral-800">+ Map another field</button>
        </details>
        {form.sourceId && <p className="text-xs text-neutral-500">Refresh schedule is shared by all databases and configured in Settings → Data sources.</p>}
        {config && <button type="button" onClick={disconnectConnection} className="text-xs text-red-500">Disconnect source · keep values</button>}
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.fillEmptyTitle} onChange={e => setForm(p => ({ ...p, fillEmptyTitle: e.target.checked }))} />Use record name for an empty row title</label>
      </fieldset>
      {error && <p role="alert" className="mt-3 text-xs text-red-500">{error}</p>}
      {message && <p role="status" className="mt-3 text-xs text-green-600">{message}</p>}
      <div className="mt-4 flex justify-end gap-2">
        {config?.enabled && <button disabled={busy} onClick={refreshConnection} className="rounded px-3 py-1.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800">Refresh connected rows now</button>}
        {config?.enabled && <button disabled={busy} onClick={testConnection} className="rounded px-3 py-1.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800">Test saved connection</button>}
        <button disabled={busy || !schema || !canConfigure || (!form.sourceId && !config)} onClick={save} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">{busy ? "Working…" : "Save connection"}</button>
      </div>
    </FloatingPopup>}
  </>;
}
