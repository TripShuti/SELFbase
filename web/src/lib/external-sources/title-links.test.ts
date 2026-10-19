import { describe, expect, it } from "vitest";
import { EMPTY_SOURCE, visibleSourceProperties, externalLinkValue, isEmptyRowTitle, parseRecordLink } from "./types";
const source = { ...EMPTY_SOURCE, linkPropertyId: "85" };
const definitions = [
  { id: 83n, name: "Play time", config: "{}" },
  { id: 84n, name: "Progress", config: "{}" },
  { id: 85n, name: "Renamed binding", config: '{"externalSource":true}' },
];
describe("external record links managed from row names", () => {
  it("hides the binding while preserving visible column order and original definitions", () => {
    expect(visibleSourceProperties(definitions, source).map(p => p.id)).toEqual([83n, 84n]);
    expect(definitions).toHaveLength(3);
    expect(definitions[2].config).toBe('{"externalSource":true}');
  });
  it("keeps ordinary columns named External record visible", () => {
    const property = { id: 100n, name: "External record", config: "{}" };
    expect(visibleSourceProperties([property])).toEqual([property]);
  });
  it("hides metadata after disabling a source or while config is loading", () => {
    expect(visibleSourceProperties(definitions, { ...source, enabled: false }).map(p => p.id)).toEqual([83n, 84n]);
    expect(visibleSourceProperties(definitions).map(p => p.id)).toEqual([83n, 84n]);
  });
  it("finds existing stable IDs without depending on the display name", () => {
    const raw = JSON.stringify({ id: "stable-id", label: "Original label" });
    const values = [{ propertyDefinitionId: 85n, value: { tag: "Text", value: raw } }];
    expect(parseRecordLink(externalLinkValue(values, source))?.id).toBe("stable-id");
    expect(values[0].value.value).toBe(raw);
  });
  it("distinguishes a new title from a custom title", () => {
    expect(isEmptyRowTitle("Untitled")).toBe(true);
    expect(isEmptyRowTitle(" ")).toBe(true);
    expect(isEmptyRowTitle("My collection entry")).toBe(false);
    expect(isEmptyRowTitle("Untitled project")).toBe(false);
  });
});
