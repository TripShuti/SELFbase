/** Manual read-only Jellyfin probe; all workspace/property identifiers are explicit. */
import assert from "node:assert/strict";
import { serviceTransport, loadSource, fetchRecord, httpPageId } from "../../web/src/lib/external-sources/server";
import { unwrapScalar, decodePropertyValue } from "../../web/src/lib/api-endpoint/codec";
import type { SourceMapping } from "../../web/src/lib/external-sources/types";

function requiredId(name: string): string {
  const value = process.env[name];
  if (!value) throw Error(`Set ${name} before running this manual probe`);
  httpPageId(value);
  return value;
}
async function main() {
  const databaseId = requiredId("TEST_DATABASE_ID");
  const statusId = requiredId("TEST_STATUS_PROPERTY_ID"), dateId = requiredId("TEST_DATE_PROPERTY_ID");
  assert.notEqual(statusId, dateId, "Choose separate status and date properties");
  const transport = serviceTransport();
  const source = await loadSource(transport, databaseId, process.env.TEST_SOURCE_ID);
  const userId = new URL(source.config.baseUrl + source.config.detailPath.replace("{id}", "sample")).searchParams.get("userId");
  if (!userId) throw Error("The saved Jellyfin detail path must contain userId");
  for (const id of [statusId, dateId]) {
    assert.ok(source.config.mappings.some(mapping => mapping.targetPropertyId === id), "Choose properties already mapped by this source");
  }
  const status: SourceMapping = { sourcePath: "UserData", targetPropertyId: statusId, targetType: "Select", transform: "statusRules",
    rules: [
      { path: "UserData.Played", operator: "equals", value: "true", result: "Переглянуто" },
      { path: "UserData.PlayedPercentage", operator: "greaterThan", value: "0", result: "В процесі" },
      { path: "UserData.PlaybackPositionTicks", operator: "greaterThan", value: "0", result: "В процесі" },
      { path: "UserData.LastPlayedDate", operator: "exists", value: "", result: "В процесі" },
    ], defaultValue: "Не розпочато", preserveValues: ["Дроп"] };
  const date: SourceMapping = { sourcePath: "UserData.LastPlayedDate", targetPropertyId: dateId, targetType: "Date", transform: "isoDateToMillis",
    related: { path: "/Items?parentId={id}&recursive=true&includeItemTypes=Episode&userId=" + encodeURIComponent(userId) + "&enableUserData=true",
      resultsPath: "Items", valuePath: "UserData.LastPlayedDate", whenPath: "Type", whenEquals: "Series",
      offsetParam: "startIndex", limitParam: "limit", totalPath: "TotalRecordCount", pageSize: 200 } };
  source.config.mappings = source.config.mappings.map(mapping => mapping.targetPropertyId === statusId ? status : mapping.targetPropertyId === dateId ? date : mapping);
  const rows = await transport.sql<{id: number; deleted_at: unknown}>("SELECT id, deleted_at FROM page WHERE parent_pk = ?", [BigInt(databaseId)]);
  let checked = 0;
  for (const row of rows) {
    if (unwrapScalar(row.deleted_at) != null) continue;
    const [cell] = await transport.sql<{value: unknown}>("SELECT value FROM page_property_value WHERE page_id = ? AND property_definition_id = ?", [BigInt(row.id), BigInt(source.config.linkPropertyId)]);
    const raw = cell && decodePropertyValue(cell.value);
    if (typeof raw !== "string" || !raw) continue;
    const record = await fetchRecord(source, JSON.parse(raw).id);
    assert.ok(record.values.some(value => value.propertyId === statusId), "Expected a computed status");
    checked++;
  }
  assert.ok(checked > 0, "No linked records were checked");
  console.log(JSON.stringify({ result: "PASS", recordsChecked: checked, databaseWrites: 0 }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
