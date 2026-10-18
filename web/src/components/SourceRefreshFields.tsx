"use client";
import type { Dispatch, SetStateAction } from "react";
import type { SourceConfig } from "@/src/lib/external-sources/types";
const sourceInputClass = "mt-1 block w-full rounded border border-neutral-200 dark:border-neutral-700 bg-transparent px-2 py-1.5 text-sm";
export function SourceRefreshFields({ form, setForm }: { form: SourceConfig; setForm: Dispatch<SetStateAction<SourceConfig>> }) {
  const mode = form.syncMode || "interval";
  const presets = [3600, 21600, 86400];
  const inputClass = sourceInputClass;
  function field(key: keyof SourceConfig, label: string, placeholder = "") {
    return <label className="block text-xs">{label}<input className={inputClass} value={String(form[key] || "")} placeholder={placeholder}
      onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} /></label>;
  }
  return <details open>
    <summary className="cursor-pointer text-sm font-medium">Refresh schedule</summary>
    <label className="mt-2 block text-xs">Automatic updates
      <select className={inputClass} value={mode} onChange={e => setForm(p => ({ ...p, syncMode: e.target.value as SourceConfig["syncMode"] }))}>
        <option value="interval">At an interval</option><option value="change">When source status changes</option><option value="manual">Manual only</option>
      </select>
    </label>
    {mode !== "manual" && <>
      <label className="mt-2 block text-xs">{mode === "change" ? "Check source status" : "Refresh source"}
        <select className={inputClass} value={presets.includes(form.syncIntervalSeconds) ? form.syncIntervalSeconds : -1}
          onChange={e => { if (e.target.value !== "-1") setForm(p => ({ ...p, syncIntervalSeconds: Number(e.target.value) })); else setForm(p => ({ ...p, syncIntervalSeconds: 7200 })); }}>
          <option value={3600}>Hourly</option><option value={21600}>Every 6 hours</option><option value={86400}>Daily</option><option value={-1}>Custom interval</option>
        </select>
      </label>
      {!presets.includes(form.syncIntervalSeconds) && <label className="mt-2 block text-xs">Custom interval (seconds)
        <input className={inputClass} type="number" min={60} max={604800} value={form.syncIntervalSeconds} onChange={e => setForm(p => ({ ...p, syncIntervalSeconds: Number(e.target.value) }))} />
      </label>}
    </>}
    {mode === "change" && <div className="mt-2 space-y-2">
      <p className="text-[11px] text-neutral-500">Check a lightweight status endpoint. Records are refreshed only after a new successful revision, or when mappings change.</p>
      {field("changePath", "Status API path", "/status")}
      {field("changeValuePath", "Completed revision field", "last_sync.finished_at")}
      {field("changeSuccessPath", "Success field", "last_sync.status")}
      {field("changeSuccessValue", "Success value", "success")}
    </div>}
    <p className="mt-2 text-[11px] text-neutral-500">Shared by all connected databases. Record lists are cached only in server memory. Manual refresh is always available.</p>
  </details>;
}
