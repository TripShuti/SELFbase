import { describe, expect, it } from "vitest";
import { EMPTY_SOURCE, copySourceMappings, workspaceSources, type SourceMapping } from "./types";
const mapping: SourceMapping = { sourcePath: "elapsed", targetPropertyId: "10", targetType: "Duration", transform: "secondsToMinutes" };
const original = [{ id: 10n, name: "Elapsed", propertyType: { tag: "Duration" } }];
const target = [{ id: 90n, name: "Elapsed", propertyType: { tag: "Duration" }, config: "{}" }];
describe("workspace source reuse", () => {
  it("copies transforms using the destination database's ids", () => {
    expect(copySourceMappings([mapping], original, target)).toEqual([{ ...mapping, targetPropertyId: "90" }]);
    expect(mapping.targetPropertyId).toBe("10");
  });
  it("skips missing, incompatible and ambiguous destination columns", () => {
    expect(copySourceMappings([mapping], original, [])).toEqual([]);
    expect(copySourceMappings([mapping], original, [{ ...target[0], propertyType: { tag: "Number" } }])).toEqual([]);
    expect(copySourceMappings([mapping], original, [...target, { ...target[0], id: 91n }])).toEqual([]);
  });
  it("never copies a mapping to hidden source metadata", () => {
    expect(copySourceMappings([mapping], original, [{ ...target[0], config: '{"externalSource":true}' }])).toEqual([]);
  });
  it("lists only valid registry entries, keeping unrelated settings out", () => {
    const source = { ...EMPTY_SOURCE, sourceId: "source-a", name: "Inventory" };
    expect(workspaceSources([
      { key: "ai.max_hops", valueJson: "3" },
      { key: "external-source.source-a", valueJson: JSON.stringify(source) },
      { key: "external-source.wrong-id", valueJson: JSON.stringify(source) },
      { key: "external-source.broken", valueJson: "{" },
    ])).toEqual([source]);
  });
});
