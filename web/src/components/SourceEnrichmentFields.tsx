"use client";

import type { Dispatch, SetStateAction } from "react";
import type { SourceConfig, SourceEnrichment } from "@/src/lib/external-sources/types";

export function SourceEnrichmentFields({ form, setForm }: { form: SourceConfig; setForm: Dispatch<SetStateAction<SourceConfig>> }) {
  const rules = form.enrichments || [];
  const inputClass = "mt-1 block w-full rounded border border-neutral-200 dark:border-neutral-700 bg-transparent px-2 py-1.5 text-sm";
  function field(rule: SourceEnrichment, index: number, key: keyof SourceEnrichment, label: string, placeholder: string) {
    return <label className="block text-xs">{label}
      <input aria-label={`${label} ${index + 1}`} value={rule[key]} placeholder={placeholder} className={inputClass}
        onChange={e => setForm(previous => ({ ...previous, enrichments: (previous.enrichments || []).map((value, i) => i === index ? { ...value, [key]: e.target.value } : value) }))} />
    </label>;
  }
  return <details open={rules.length > 0}>
    <summary className="cursor-pointer text-sm font-medium">Additional API lists</summary>
    <p className="mt-2 text-[11px] text-neutral-500">Match records from another complete list on this source using a shared ID. Lists use the same authentication, refresh schedule and in-memory cache. No match preserves saved values; failed requests reject the refresh.</p>
    {rules.map((rule, index) => <div key={index} className="mt-3 space-y-2 rounded border border-neutral-200 p-2 dark:border-neutral-700">
      {field(rule, index, "path", "Additional API path", "/activity")}
      {field(rule, index, "resultsPath", "Additional results array", "response.items; blank for a root array")}
      <div className="grid grid-cols-2 gap-2">
        {field(rule, index, "recordMatchPath", "Main record match field", "id")}
        {field(rule, index, "matchPath", "Additional record match field", "id")}
      </div>
      {field(rule, index, "targetField", "Attach as field", "activity")}
      <p className="text-[11px] text-neutral-500">Map added fields using {rule.targetField || "activity"}.field_name. Existing record fields are never overwritten.</p>
      <button type="button" className="text-xs text-red-500" onClick={() => setForm(previous => ({ ...previous, enrichments: (previous.enrichments || []).filter((_, i) => i !== index) }))}>Remove additional list</button>
    </div>)}
    <button type="button" disabled={rules.length >= 4} className="mt-2 text-xs text-blue-600 disabled:opacity-50" onClick={() => setForm(previous => {
      const current = previous.enrichments || [];
      let suffix = 1;
      while (current.some(rule => rule.targetField === `extra_${suffix}`)) suffix++;
      return { ...previous, enrichments: [...current, { path: "/activity", resultsPath: "items", recordMatchPath: previous.idPath || "id", matchPath: "id", targetField: `extra_${suffix}` }] };
    })}>+ Add API list</button>
  </details>;
}
