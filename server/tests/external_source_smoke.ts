import assert from "node:assert/strict";
import { serviceTransport, loadSource, searchSource, syncSourceDatabase, syncExternalRow } from "../../web/src/lib/external-sources/server";
async function main() {
  const transport = serviceTransport();
  const databaseId = process.env.TEST_DATABASE_ID!;
  const source = await loadSource(transport, databaseId);
  const records = await searchSource(source, "desk & lamp");
  assert.equal(records[0].label, "Desk lamp");
  assert.equal(records[0].id, "item-1");
  assert.equal(records[0].image, "https://images.example.com/direct.jpg");
  assert.equal(JSON.stringify(records).includes("integration-test-secret"), false);
  const result = await syncSourceDatabase(transport, databaseId, source);
  if (result.failed) await syncExternalRow(transport, source, databaseId, process.env.TEST_ROW_ID!);
  assert.deepEqual(result, { updated: 1, failed: 0 });
  console.log("PASS: generic HTTP search and browser-independent synchronization with real SpacetimeDB 2.0.3");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
