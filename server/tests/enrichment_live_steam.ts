/** Manual read-only Steam probe. Requires explicit service env + TEST_DATABASE_ID. */
import assert from "node:assert/strict";
import { serviceTransport, loadSource, sourceCollection, fetchRecord, httpPageId } from "../../web/src/lib/external-sources/server";
import { atPath } from "../../web/src/lib/external-sources/mapping";

async function main() {
  const databaseId = process.env.TEST_DATABASE_ID;
  if (!databaseId) throw Error("Set TEST_DATABASE_ID to the database with the saved Steam source");
  httpPageId(databaseId);
  const saved = await loadSource(serviceTransport(), databaseId, process.env.TEST_SOURCE_ID);
  assert.equal(new URL(saved.config.baseUrl).hostname, "api.steampowered.com", "Choose a Steam source");
  // Override mapping/enrichment only in memory. No reducer or provider write is called.
  const config = { ...saved.config,
    enrichments: [{ path: '/IPlayerService/ClientGetLastPlayedTimes/v1/?input_json={"min_last_played":0}',
      resultsPath: "response.games", recordMatchPath: "appid", matchPath: "appid", targetField: "play_history" }],
    mappings: [{ sourcePath: "play_history.first_playtime", targetPropertyId: "1", targetType: "Date" as const,
      transform: "unixSecondsToMillis" as const, zeroIsEmpty: true }],
  };
  const source = { ...saved, config, settings: config };
  const snapshot = await sourceCollection(source);
  const dated = [...snapshot.raw.values()].filter(row => Number(atPath(row, "play_history.first_playtime")) > 0);
  assert.ok(dated.length > 0, "The source has no records with a first-play timestamp");
  const result = await fetchRecord(source, String(atPath(dated[0], "appid")));
  assert.equal(result.values[0].kind, "Date");
  assert.ok(Number(result.values[0].value) > 0);
  console.log(JSON.stringify({ result: "PASS", records: snapshot.records.length, recordsWithFirstPlayed: dated.length, databaseWrites: 0 }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
