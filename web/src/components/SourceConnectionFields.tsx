"use client";

import type { Dispatch, SetStateAction } from "react";
import { SourceRefreshFields } from "./SourceRefreshFields";
import type { SourceConfig } from "@/src/lib/external-sources/types";

export const sourceInputClass = "mt-1 block w-full rounded border border-neutral-200 dark:border-neutral-700 bg-transparent px-2 py-1.5 text-sm";

export function SourceConnectionFields({ form, setForm, secret, setSecret }: {
  form: SourceConfig; setForm: Dispatch<SetStateAction<SourceConfig>>;
  secret: string; setSecret: (value: string) => void;
}) {
  const inputClass = sourceInputClass;
  function field(key: keyof SourceConfig, label: string, hint?: string) {
    return <label className="block text-xs" key={key}>{label}
      <input value={String(form[key] ?? "")} onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))} className={inputClass} />
      {hint && <span className="mt-1 block text-[11px] text-neutral-500">{hint}</span>}
    </label>;
  }
  return <div className="space-y-3">
        {field("name", "Connection name")}
        {field("baseUrl", "Base URL", "An address reachable by the SELFbase server, e.g. http://service:8080")}
        <label className="block text-xs">Record lookup
          <select className={inputClass} value={form.recordMode || "detail"} onChange={e => setForm(p => ({ ...p, recordMode: e.target.value as SourceConfig["recordMode"] }))}>
            <option value="detail">Search API and single-record API</option>
            <option value="collection">Full collection with local search</option>
          </select>
        </label>
        {form.recordMode === "collection" && <p className="text-xs text-neutral-500">Fetch the complete list once. The server searches it and finds records by ID, using an in-memory cache shared by your databases.</p>}
        <details open><summary className="cursor-pointer text-sm font-medium">Search and records</summary>
          <div className="mt-2 grid grid-cols-2 gap-3">
            {field("searchPath", "Search path", "Example: /api/items?limit=20")}
            {form.recordMode !== "collection" && field("queryParam", "Search query parameter", "Example: q or search")}
            {field("resultsPath", "Results array path", "Example: data.items; blank for a root array")}
            {form.recordMode !== "collection" && field("detailPath", "Single-record path", "Example: /api/items/{id}")}
            {form.recordMode !== "collection" && field("detailResultPath", "Single-record result path", "Blank for a root object")}
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
              <input type="password" autoComplete="new-password" value={secret} onChange={e => setSecret(e.target.value)} className={inputClass} placeholder={"Leave blank to keep the saved credential"} />
              <span className="mt-1 block text-[11px] text-neutral-500">Stored privately on the server. Re-enter it if you change the source URL.</span>
            </label>
          </div>
        </details>
    <SourceRefreshFields form={form} setForm={setForm} />
  </div>;
}
