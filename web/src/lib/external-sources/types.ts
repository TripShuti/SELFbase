export const TARGET_TYPES = ["Text", "Number", "Duration", "Date", "Checkbox", "Url", "Select", "MultiSelect"] as const;
export type TargetType = typeof TARGET_TYPES[number];
export const TRANSFORMS = [
  ["identity", "As provided"], ["secondsToMinutes", "Seconds → minutes"],
  ["millisecondsToMinutes", "Milliseconds → minutes"], ["hoursToMinutes", "Hours → minutes"],
  ["isoDateToMillis", "ISO date → date"], ["unixSecondsToMillis", "Unix seconds → date"],
] as const;
export type Transform = typeof TRANSFORMS[number][0];
export interface SourceMapping {
  sourcePath: string;
  targetPropertyId: string;
  targetType: TargetType;
  transform: Transform;
}
export interface SourceConfig {
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
