import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SOURCE, type SourceConfig } from "../lib/external-sources/types";
import { ExternalRecordCell } from "./ExternalRecordCell";
import { PagePropertiesPanel } from "./PagePropertiesPanel";

const fixture = vi.hoisted(() => ({ values: [] as unknown[] }));
vi.mock("spacetimedb/react", () => ({ useReducer: () => vi.fn(), useTable: () => [[{ id: 1250n, parentId: 1248n, title: "Entry" }]] }));
vi.mock("@/src/module_bindings", () => ({ reducers: {}, tables: { page: {} } }));
vi.mock("@/src/providers/WorkspaceProvider", () => ({ useWorkspace: () => ({ activeWorkspace: { dbName: "test" } }) }));
vi.mock("@/src/hooks/useDatabase", () => ({ usePagePropertyValues: () => fixture.values }));
vi.mock("@/src/hooks/useUser", () => ({ useUsers: () => ({ users: [] }) }));
vi.mock("./PropertyCell", () => ({ PropertyCell: () => null }));
vi.mock("./propertyTypeIcons", () => ({ PropertyTypeIcon: () => null }));
afterEach(() => { fixture.values = []; vi.unstubAllGlobals(); });
const source = (name: string, sourceId: string): SourceConfig => ({ ...EMPTY_SOURCE, enabled: true, name, sourceId, linkPropertyId: "85" });
const jellyfin = source("Jellyfin", "jellyfin");
const psn = source("psnSELF", "psn");
const steam = source("Steam", "steam");
function panel(sources: SourceConfig[], raw = "") {
  vi.stubGlobal("React", React);
  fixture.values = raw ? [{ propertyDefinitionId: 85n, value: { tag: "Text", value: raw } }] : [];
  return renderToStaticMarkup(createElement(PagePropertiesPanel, { pageId: 1250n, properties: [], externalSource: sources[0], externalSources: sources }));
}

describe("row source status", () => {
  it("does not claim the database source is linked to an unlinked row", () => {
    const html = panel([jellyfin]);
    expect(html).toContain("Not linked to a source");
    expect(html).toContain("Link to source: Entry");
    expect(html).not.toContain("Jellyfin");
    expect(html).not.toContain("Linked to");
  });
  it.each([psn, steam])("names the actual linked source $name in a multi-source database", linked => {
    const html = panel([psn, steam], JSON.stringify({ id: "record", label: "Record", sourceId: linked.sourceId }));
    expect(html).toContain(`<span>${linked.name}</span>`);
    expect(html).toContain(`Linked to ${linked.name}: Record`);
    expect(html).not.toContain("External source</span>");
  });
  it("retains legacy primary-source links without a sourceId", () => {
    expect(panel([jellyfin], '{"id":"old","label":"Legacy"}')).toContain("Linked to Jellyfin: Legacy");
  });
  it("does not substitute a different source when the linked source is unavailable", () => {
    const html = panel([psn, steam], '{"id":"old","label":"Legacy","sourceId":"removed"}');
    expect(html).toContain("Unavailable source");
    expect(html).not.toContain("Linked to psnSELF");
    expect(html).not.toContain("Linked to Steam");
  });
  it("keeps the source control out of ordinary pages", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(createElement(PagePropertiesPanel, { pageId: 1250n, properties: [] }));
    expect(html).not.toContain("source");
  });
  it("uses the same linked tooltip for grid/list/board title controls", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(createElement(ExternalRecordCell, { pageId: 1n, databaseId: 2n, variant: "title", rowTitle: "Entry", value: '{"id":"1","label":"Record","sourceId":"steam"}', sources: [psn, steam], sourceName: psn.name }));
    expect(html).toContain("Linked to Steam: Record");
    expect(html).not.toContain("Linked to psnSELF");
  });
});
