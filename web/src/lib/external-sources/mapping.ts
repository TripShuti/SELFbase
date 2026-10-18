import type { SourceConfig, SourceMapping, ConvertedField, ExternalRecord } from "./types";

/** A deliberately small selector: own-property dot paths, including array indexes. */
export function atPath(record: unknown, path: string): unknown {
  if (!path) return record;
  let value = record;
  for (const key of path.split(".")) {
    if (["__proto__", "prototype", "constructor"].includes(key) || value == null ||
        typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}
export function describeRecord(raw: unknown, config: SourceConfig): ExternalRecord {
  const id = text(atPath(raw, config.idPath));
  const label = text(atPath(raw, config.labelPath));
  if (id == null || !id || id === "." || id === ".." || id.length > 512 || /[\x00-\x1f\x7f]/.test(id) || label == null || label.length > 1000) {
    throw new Error("Response record is missing a valid id or label; check the field paths");
  }
  const image = text(atPath(raw, config.imagePath)) || "";
  return { id, label, subtitle: text(atPath(raw, config.subtitlePath)) || "", image: /^https?:\/\//i.test(image) ? image : "" };
}
function numeric(raw: unknown): number {
  if ((typeof raw !== "number" && typeof raw !== "string") || (typeof raw === "string" && !raw.trim())) throw new Error("Expected a number");
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error("Expected a finite number");
  return value;
}
export function convertField(raw: unknown, mapping: SourceMapping): ConvertedField | null {
  // Missing/null upstream data never erases a previously known value.
  if (raw == null) return null;
  let value: unknown = raw;
  switch (mapping.transform) {
    case "secondsToMinutes": value = numeric(raw) / 60; break;
    case "millisecondsToMinutes": value = numeric(raw) / 60_000; break;
    case "hoursToMinutes": value = numeric(raw) * 60; break;
    case "unixSecondsToMillis": value = numeric(raw) * 1000; break;
    case "isoDateToMillis": value = typeof raw === "string" ? Date.parse(raw) : NaN; break;
    case "identity": break;
    default: throw new Error("Unknown transform");
  }
  let converted: ConvertedField["value"];
  switch (mapping.targetType) {
    case "Text": case "Url": case "Select": {
      const result = text(value);
      if (result == null) throw new Error("Expected text");
      converted = result; break;
    }
    case "Number": converted = numeric(value); break;
    case "Date": case "Duration": {
      const result = Math.floor(numeric(value));
      if (!Number.isSafeInteger(result) || result < 0) throw new Error("Expected a non-negative date/duration");
      converted = String(result); break;
    }
    case "Checkbox":
      if (typeof value !== "boolean") throw new Error("Expected true or false");
      converted = value; break;
    case "MultiSelect":
      if (!Array.isArray(value) || !value.every(v => typeof v === "string")) throw new Error("Expected an array of strings");
      converted = value; break;
    default: throw new Error("Unsupported target type");
  }
  return { propertyId: mapping.targetPropertyId, kind: mapping.targetType, value: converted };
}
export function mappedValues(record: unknown, config: SourceConfig): ConvertedField[] {
  return config.mappings.flatMap(mapping => {
    try {
      const field = convertField(atPath(record, mapping.sourcePath), mapping);
      return field ? [field] : [];
    } catch {
      throw new Error(`Cannot convert field ${mapping.sourcePath} to ${mapping.targetType}`);
    }
  });
}
