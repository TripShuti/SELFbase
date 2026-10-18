export const TARGET_TYPES = ["Text", "Number", "Duration", "Date", "Checkbox", "Url", "Select", "MultiSelect"] as const;
export type TargetType = typeof TARGET_TYPES[number];
export const TRANSFORMS = [
  ["identity", "As provided"], ["statusRules", "Status from rules"], ["secondsToMinutes", "Seconds → minutes"],
  ["millisecondsToMinutes", "Milliseconds → minutes"], ["hoursToMinutes", "Hours → minutes"],
  ["isoDateToMillis", "ISO date → date"], ["unixSecondsToMillis", "Unix seconds → date"],
] as const;
export type Transform = typeof TRANSFORMS[number][0];
export interface StatusRule {
  path: string;
  operator: "equals" | "greaterThan" | "exists";
  value: string;
  result: string;
}
export interface RelatedDate {
  path: string;
  resultsPath: string;
  valuePath: string;
  whenPath: string;
  whenEquals: string;
  offsetParam: string;
  limitParam: string;
  totalPath: string;
  pageSize: number;
}
export interface SourceMapping {
  rules?: StatusRule[];
  defaultValue?: string;
  preserveValues?: string[];
  related?: RelatedDate;
  sourcePath: string;
  targetPropertyId: string;
  targetType: TargetType;
  transform: Transform;
}
export const SOURCE_PREFIX = "external-source.";
export interface SourceConfig {
  sourceId?: string;
  enabled: boolean;
  name: string;
  baseUrl: string;
  searchPath: string;
  queryParam: string;
  resultsPath: string;
  detailPath: string;
  detailResultPath: string;
  idPath: string;
  labelPath: string;
  subtitlePath: string;
  imagePath: string;
  authHeader: string;
  authPrefix: string;
  linkPropertyId: string;
  mappings: SourceMapping[];
  syncIntervalSeconds: number;
  fillEmptyTitle: boolean;
  revision: string;
}
export const EMPTY_SOURCE: SourceConfig = {
  enabled: true, name: "", baseUrl: "", searchPath: "/items", queryParam: "q",
  resultsPath: "items", detailPath: "/items/{id}", detailResultPath: "",
  idPath: "id", labelPath: "name", subtitlePath: "", imagePath: "",
  authHeader: "Authorization", authPrefix: "Bearer ", linkPropertyId: "", mappings: [],
  syncIntervalSeconds: 300, fillEmptyTitle: true, revision: "",
};
export interface ExternalRecord { id: string; label: string; subtitle: string; image: string }
export interface ConvertedField { propertyId: string; kind: TargetType; value: string | number | boolean | string[] }
export interface SourceStatus { serviceConfigured: boolean; automaticSync: boolean; lastRun: string | null; updated: number; error: string | null }

export function parseSourceConfig(raw: string | null | undefined): SourceConfig | null {
  try {
    const value = JSON.parse(raw || "{}").externalSource;
    if (!value || typeof value.enabled !== "boolean" || typeof value.name !== "string" ||
        typeof value.baseUrl !== "string" || !/^[1-9]\d*$/.test(value.linkPropertyId) ||
        !Array.isArray(value.mappings) || !Number.isFinite(value.syncIntervalSeconds)) return null;
    return value as SourceConfig;
  } catch { return null; }
}
export function isExternalLinkColumn(config: string): boolean {
  try { return JSON.parse(config || "{}").externalSource === true; } catch { return false; }
}
export function parseRecordLink(raw: string): { id: string; label: string } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return typeof value.id === "string" && typeof value.label === "string" ? value : null;
  } catch { return null; }
}

/** Links remain persisted for compatibility, but are managed from the row name. */
export function visibleSourceProperties<T extends { id: bigint; config: string }>(
  properties: readonly T[], source: SourceConfig | null = null,
): T[] {
  return properties.filter(property => String(property.id) !== source?.linkPropertyId && !isExternalLinkColumn(property.config));
}
export function externalLinkValue(
  values: readonly { propertyDefinitionId: bigint; value: { tag: string; value?: unknown } }[],
  source: SourceConfig | null | undefined,
): string {
  const value = values.find(v => String(v.propertyDefinitionId) === source?.linkPropertyId)?.value;
  return value?.tag === "Text" && typeof value.value === "string" ? value.value : "";
}
export function isEmptyRowTitle(title: string): boolean {
  return !title.trim() || title.trim() === "Untitled";
}

export function workspaceSources(settings: readonly { key: string; valueJson: string }[]): SourceConfig[] {
  return settings.flatMap(setting => {
    if (!setting.key.startsWith(SOURCE_PREFIX)) return [];
    try {
      const source = JSON.parse(setting.valueJson) as SourceConfig;
      return source.sourceId && setting.key === SOURCE_PREFIX + source.sourceId && typeof source.name === "string" &&
        typeof source.baseUrl === "string" ? [source] : [];
    } catch { return []; }
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Copy only unambiguous column names/types; ids are local to each database. */
export function copySourceMappings(mappings: readonly SourceMapping[],
  from: readonly { id: bigint; name: string; propertyType: { tag: string } }[],
  to: readonly { id: bigint; name: string; propertyType: { tag: string }; config: string }[],
): SourceMapping[] {
  return mappings.flatMap(mapping => {
    const original = from.find(p => String(p.id) === mapping.targetPropertyId);
    if (!original) return [];
    const matches = to.filter(p => p.name === original.name && p.propertyType.tag === mapping.targetType && !isExternalLinkColumn(p.config));
    return matches.length === 1 ? [{ ...mapping, targetPropertyId: String(matches[0].id) }] : [];
  }).filter((mapping, index, all) => all.findIndex(m => m.targetPropertyId === mapping.targetPropertyId) === index);
}
