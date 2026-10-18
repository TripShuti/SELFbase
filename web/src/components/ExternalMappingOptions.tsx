"use client";

import type { SourceMapping, RelatedDate } from "@/src/lib/external-sources/types";
import { sourceInputClass as inputClass } from "./SourceConnectionFields";

export function ExternalMappingOptions({ mapping, onChange }: {
  mapping: SourceMapping; onChange: (mapping: SourceMapping) => void;
}) {
  function relatedField(key: keyof RelatedDate, label: string) {
    return <label className="block text-xs" key={key}>{label}
      <input aria-label={label} className={inputClass} value={String(mapping.related?.[key] ?? "")}
        type={key === "pageSize" ? "number" : "text"} min={key === "pageSize" ? 1 : undefined} max={key === "pageSize" ? 500 : undefined}
        onChange={e => { if (mapping.related) onChange({ ...mapping, related: { ...mapping.related, [key]: key === "pageSize" ? Number(e.target.value) : e.target.value } }); }} />
    </label>;
  }
  return <div className="mt-2 space-y-2">
    {mapping.transform === "statusRules" && <div className="space-y-2">
      <p className="text-[11px] text-neutral-500">First matching rule wins. Paths start at the detail record root. A missing source field preserves the saved value.</p>
      {(mapping.rules || []).map((rule, index) => <div key={index} className="rounded bg-neutral-50 p-2 dark:bg-neutral-800">
        <label className="text-xs">Condition field
          <input className={inputClass} value={rule.path} onChange={e => onChange({ ...mapping, rules: mapping.rules!.map((r, i) => i === index ? { ...r, path: e.target.value } : r) })} />
        </label>
        <select aria-label="Rule operator" className={inputClass} value={rule.operator}
          onChange={e => onChange({ ...mapping, rules: mapping.rules!.map((r, i) => i === index ? { ...r, operator: e.target.value as typeof r.operator } : r) })}>
          <option value="equals">Equals</option><option value="greaterThan">Greater than</option><option value="exists">Has a value</option>
        </select>
        {rule.operator !== "exists" && <label className="text-xs">Condition value
          <input className={inputClass} value={rule.value} onChange={e => onChange({ ...mapping, rules: mapping.rules!.map((r, i) => i === index ? { ...r, value: e.target.value } : r) })} />
        </label>}
        <label className="text-xs">Result label
          <input className={inputClass} value={rule.result} onChange={e => onChange({ ...mapping, rules: mapping.rules!.map((r, i) => i === index ? { ...r, result: e.target.value } : r) })} />
        </label>
        <button type="button" className="mt-2 text-xs text-red-500" onClick={() => onChange({ ...mapping, rules: mapping.rules!.filter((_, i) => i !== index) })}>Remove rule</button>
      </div>)}
      <button type="button" disabled={(mapping.rules?.length || 0) >= 16} className="text-xs text-blue-600"
        onClick={() => onChange({ ...mapping, rules: [...(mapping.rules || []), { path: "", operator: "equals", value: "true", result: "" }] })}>+ Add status rule</button>
      <label className="block text-xs">When no rule matches
        <input className={inputClass} value={mapping.defaultValue || ""} placeholder="Leave blank to preserve the saved value"
          onChange={e => onChange({ ...mapping, defaultValue: e.target.value })} />
      </label>
    </div>}
    {mapping.targetType === "Select" && <label className="block text-xs">Manual labels to keep (comma separated)
      <input className={inputClass} value={(mapping.preserveValues || []).join(",")} placeholder="Labels synchronization must not overwrite"
        onChange={e => onChange({ ...mapping, preserveValues: e.target.value.split(",") })}
        onBlur={e => onChange({ ...mapping, preserveValues: e.target.value.split(",").map(value => value.trim()).filter(Boolean) })} />
      <span className="mt-1 block text-[11px] text-neutral-500">Exact label match. To resume synchronization, select a different label in the row.</span>
    </label>}
    {mapping.targetType === "Date" && <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={!!mapping.zeroIsEmpty} onChange={e => onChange({ ...mapping, zeroIsEmpty: e.target.checked })} />
      Treat a zero timestamp as missing
    </label>}
    {mapping.targetType === "Date" && <details className="text-xs">
      <summary className="cursor-pointer">Latest date from related records</summary>
      <label className="mt-2 flex items-center gap-2">
        <input type="checkbox" checked={!!mapping.related} onChange={e => onChange({ ...mapping, transform: e.target.checked ? "isoDateToMillis" : mapping.transform,
          related: e.target.checked ? { path: "/items/{id}/events", resultsPath: "items", valuePath: "occurredAt", whenPath: "", whenEquals: "", offsetParam: "offset", limitParam: "limit", totalPath: "totalCount", pageSize: 200 } : undefined })} />
        Fetch related records and use the latest date
      </label>
      {mapping.related && <div className="mt-2 space-y-2">
        <p className="text-[11px] text-neutral-500">Uses the same source and credentials. The latest date from this list and the primary field is saved. Empty lists preserve known dates.</p>
        {relatedField("path", "Related API path with {id}")}
        {relatedField("resultsPath", "Related results array path")}
        {relatedField("valuePath", "Date field in each related record")}
        {relatedField("whenPath", "Only when field (blank = always)")}
        {relatedField("whenEquals", "Only when value equals")}
        <div className="grid grid-cols-2 gap-2">
          {relatedField("offsetParam", "Offset query parameter")}
          {relatedField("limitParam", "Limit query parameter")}
          {relatedField("totalPath", "Total count field (optional)")}
          {relatedField("pageSize", "Related page size")}
        </div>
        <p className="text-[11px] text-neutral-500">Leave both pagination parameters blank only if the API returns the entire list. At most 20 pages are read; incomplete results keep existing values.</p>
      </div>}
    </details>}
  </div>;
}
