"use client";

import { useMemo, useRef, useState } from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import { HttpStdbTransport } from "@/src/lib/api-endpoint";
import {
  buildNotionPlan,
  parseCsv,
  runNotionImport,
  type NotionColumnKind,
  type NotionPlan,
} from "@/src/lib/notionImport";
import { readActiveWorkspaceToken, resolveWorkspaceDbName, resolveWorkspaceWsUri } from "@/src/lib/workspaceConnections";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";

function wsToHttp(uri: string): string {
  if (/^wss:\/\//i.test(uri)) return `https://${uri.slice(6)}`;
  if (/^ws:\/\//i.test(uri)) return `http://${uri.slice(5)}`;
  return uri;
}

type ColCfg = { name: string; kind: NotionColumnKind | "skip" };

function inferKind(name: string, values: string[]): NotionColumnKind {
  const filled = values.filter((v) => v !== "");
  if (filled.length === 0) return "text";
  if (filled.every((v) => Number.isFinite(Number.parseFloat(v.replace(",", "."))))) return "number";
  const uniq = new Set(filled);
  if (uniq.size <= 12 && filled.every((v) => v.length <= 40)) return "select";
  return "text";
}

export function NotionImportSection() {
  const { activeWorkspace } = useWorkspace();
  const { isActive } = useSpacetimeDB();
  const csvRef = useRef<HTMLInputElement>(null);
  const mdRef = useRef<HTMLInputElement>(null);
  const [csvName, setCsvName] = useState("");
  const [csvText, setCsvText] = useState<string | null>(null);
  const [mdCount, setMdCount] = useState(0);
  const [mdFiles, setMdFiles] = useState<Array<{ name: string; text: string }>>([]);
  const [dbName, setDbName] = useState("");
  const [titleCol, setTitleCol] = useState("");
  const [cols, setCols] = useState<ColCfg[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const headers = useMemo(() => {
    if (!csvText) return [];
    const rows = parseCsv(csvText);
    return rows[0] ?? [];
  }, [csvText]);

  async function handleCsv(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setCsvName(file.name);
    setCsvText(text);
    setDone(null);
    setError(null);
    try {
      const rows = parseCsv(text);
      const header = rows[0] ?? [];
      const data = rows.slice(1);
      if (!titleCol) setTitleCol(header[0] ?? "");
      if (!dbName) {
        const base = file.name.replace(/\.csv$/i, "").replace(/ [0-9a-f]{32}$/, "");
        setDbName(base || "Notion import");
      }
      setCols(
        header.slice(1).map((h) => {
          const colIdx = header.indexOf(h);
          const vals = data.map((r) => (r[colIdx] ?? "").trim());
          return { name: h, kind: inferKind(h, vals) };
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleMdDir(files: FileList | null) {
    if (!files) return;
    const list: Array<{ name: string; text: string }> = [];
    for (const f of Array.from(files)) {
      if (!f.name.endsWith(".md")) continue;
      // webkitdirectory gives paths like "export/Page <id>.md" — keep the leaf.
      const leaf = f.name.split("/").pop() ?? f.name;
      list.push({ name: leaf, text: await f.text() });
    }
    setMdFiles(list);
    setMdCount(list.length);
    setDone(null);
  }

  const planPreview = useMemo<NotionPlan | null>(() => {
    if (!csvText && mdFiles.length === 0) return null;
    try {
      return buildNotionPlan({
        csvText: csvText ?? undefined,
        mdFiles,
        dbName: dbName || "Notion import",
        titleCol: titleCol || undefined,
        selectCols: cols.filter((c) => c.kind === "select").map((c) => c.name),
        numberCols: cols.filter((c) => c.kind === "number").map((c) => c.name),
        skipCols: cols.filter((c) => c.kind === "skip").map((c) => c.name),
      });
    } catch {
      return null;
    }
  }, [csvText, mdFiles, dbName, titleCol, cols]);

  function setColKind(name: string, kind: NotionColumnKind | "skip") {
    setCols((prev) => prev.map((c) => (c.name === name ? { ...c, kind } : c)));
  }

  async function handleRun() {
    if (!activeWorkspace || !planPreview) return;
    const token = readActiveWorkspaceToken();
    if (!token) {
      setError("Not signed in.");
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    setProgress("Starting…");
    try {
      const transport = new HttpStdbTransport({
        baseUrl: wsToHttp(resolveWorkspaceWsUri(activeWorkspace.wsUri)),
        dbName: resolveWorkspaceDbName(activeWorkspace.dbName),
        token,
      });
      const res = await runNotionImport(transport, planPreview, {
        dbName,
        onProgress: (p) => setProgress(`${p.stage}: ${p.rowsDone}/${p.rowsTotal}`),
      });
      setProgress("");
      setDone(`Imported database "${dbName}" — ${res.rows} rows + ${res.docs} docs.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress("");
    } finally {
      setBusy(false);
    }
  }

  const canRun = isActive && !!activeWorkspace && !!planPreview && !busy &&
    (planPreview.records.length > 0 || planPreview.orphans.length > 0);

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-4">
        Import from Notion
      </h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        Rebuild a Notion Markdown + CSV export here: one database with rows,
        values and page bodies. Everything lands as new pages — existing
        content is untouched.
      </p>

      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => csvRef.current?.click()}
            disabled={busy}
            className="px-3 py-1.5 rounded text-sm font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:opacity-90 disabled:opacity-40"
          >
            {csvName ? `CSV: ${csvName}` : "Choose CSV…"}
          </button>
          <input
            ref={csvRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              void handleCsv(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => mdRef.current?.click()}
            disabled={busy}
            className="px-3 py-1.5 rounded text-sm font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 hover:opacity-90 disabled:opacity-40"
          >
            {mdCount > 0 ? `Markdown folder: ${mdCount} files` : "Choose Markdown folder…"}
          </button>
          <input
            ref={mdRef}
            type="file"
            className="hidden"
            // @ts-expect-error webkitdirectory is valid but missing from React types
            webkitdirectory=""
            onChange={(e) => {
              void handleMdDir(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {headers.length > 0 && (
          <div className="rounded border border-neutral-200 dark:border-neutral-800 p-3 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-neutral-500">Database name</span>
                <input
                  value={dbName}
                  onChange={(e) => setDbName(e.target.value)}
                  disabled={busy}
                  className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-2.5 py-1.5 text-sm outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs text-neutral-500">Title column</span>
                <select
                  value={titleCol}
                  onChange={(e) => setTitleCol(e.target.value)}
                  disabled={busy}
                  className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-2.5 py-1.5 text-sm outline-none"
                >
                  {headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
            </div>
            <div>
              <p className="text-xs text-neutral-500 mb-1.5">Columns</p>
              <div className="space-y-1.5">
                {cols.map((c) => (
                  <div key={c.name} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 truncate text-neutral-800 dark:text-neutral-200">{c.name}</span>
                    <select
                      value={c.kind}
                      onChange={(e) => setColKind(c.name, e.target.value as ColCfg["kind"])}
                      disabled={busy}
                      className="rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-2 py-1 text-xs outline-none"
                    >
                      <option value="text">Text</option>
                      <option value="number">Number</option>
                      <option value="select">Select</option>
                      <option value="skip">Skip</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>
            {planPreview && (
              <p className="text-xs text-neutral-500">
                {planPreview.records.length} rows
                {planPreview.matched > 0 && ` (${planPreview.matched} with page text)`}
                {planPreview.orphans.length > 0 && `, ${planPreview.orphans.length} standalone pages`}
                {planPreview.columns.length > 0 &&
                  ` · ${planPreview.columns.map((c) => `${c.name} (${c.kind})`).join(", ")}`}
              </p>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {done && <p className="text-sm text-green-700 dark:text-green-300">{done}</p>}
        {busy && <p className="text-sm text-neutral-500 animate-pulse">{progress || "Importing…"}</p>}

        <div>
          <button
            type="button"
            onClick={() => void handleRun()}
            disabled={!canRun}
            className="px-3 py-1.5 rounded text-sm font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </section>
  );
}
