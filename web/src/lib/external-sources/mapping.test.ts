import { describe, expect, it } from "vitest";
import { atPath, convertField, describeRecord, mappedValues } from "./mapping";
import { EMPTY_SOURCE, parseRecordLink, parseSourceConfig, type SourceMapping } from "./types";
const mapping = (overrides: Partial<SourceMapping> = {}): SourceMapping => ({
  sourcePath: "stats.seconds", targetPropertyId: "7", targetType: "Duration", transform: "secondsToMinutes", ...overrides,
});
describe("generic external source mapping", () => {
  it("supports independent API shapes without provider-specific logic", () => {
    expect(describeRecord({ sku: "A/123", product: { title: "Keyboard" }, category: "Hardware" },
      { ...EMPTY_SOURCE, idPath: "sku", labelPath: "product.title", subtitlePath: "category" }))
      .toEqual({ id: "A/123", label: "Keyboard", subtitle: "Hardware", image: "" });
    expect(describeRecord({ id: 0, name: "First task" }, EMPTY_SOURCE).id).toBe("0");
  });
  it("reads own-property dot paths and indexed arrays", () => {
    expect(atPath({ data: [{ value: 3 }] }, "data.0.value")).toBe(3);
    expect(atPath({}, "constructor.name")).toBeUndefined();
    expect(atPath({}, "__proto__")).toBeUndefined();
  });
  it("converts seconds into minutes with correct units, including zero", () => {
    expect(convertField(288180, mapping())).toEqual({ propertyId: "7", kind: "Duration", value: "4803" });
    expect(convertField(0, mapping())?.value).toBe("0");
    expect(convertField(119, mapping())?.value).toBe("1");
  });
  it("preserves known values on missing upstream data", () => {
    expect(convertField(null, mapping())).toBeNull();
    expect(mappedValues({ stats: {} }, { ...EMPTY_SOURCE, mappings: [mapping()] })).toEqual([]);
  });
  it("handles dates, booleans and arrays without truthiness coercion", () => {
    expect(convertField("2026-10-18T10:00:00Z", mapping({ targetType: "Date", transform: "isoDateToMillis" }))?.value).toBe(String(Date.parse("2026-10-18T10:00:00Z")));
    expect(convertField(false, mapping({ targetType: "Checkbox", transform: "identity" }))?.value).toBe(false);
    expect(convertField(["a", "b"], mapping({ targetType: "MultiSelect", transform: "identity" }))?.value).toEqual(["a", "b"]);
    expect(() => convertField("false", mapping({ targetType: "Checkbox", transform: "identity" }))).toThrow();
  });
  it("rejects invalid data and unsafe images", () => {
    expect(() => convertField(-1, mapping())).toThrow();
    expect(() => convertField("", mapping())).toThrow();
    expect(() => describeRecord({ id: "..", name: "bad" }, EMPTY_SOURCE)).toThrow();
    expect(describeRecord({ id: "x", name: "X", image: "javascript:bad" }, { ...EMPTY_SOURCE, imagePath: "image" }).image).toBe("");
    expect(() => mappedValues({ stats: { seconds: "bad" } }, { ...EMPTY_SOURCE, mappings: [mapping()] })).toThrow("stats.seconds");
  });
  it("parses saved generic settings and stable links", () => {
    const config = { ...EMPTY_SOURCE, linkPropertyId: "8" };
    expect(parseSourceConfig(JSON.stringify({ externalSource: config }))).toEqual(config);
    expect(parseRecordLink(JSON.stringify({ id: "stable", label: "renamable" }))?.id).toBe("stable");
    expect(parseRecordLink("arbitrary text")).toBeNull();
  });
});
