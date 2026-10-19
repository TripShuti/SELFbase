import assert from 'node:assert/strict';
import {serviceTransport,loadSource,searchSource,syncSourceDatabase} from '../../web/src/lib/external-sources/server';
async function main(){
 const t=serviceTransport(),db=process.env.TEST_DATABASE_ID!;
 const source=await loadSource(t,db,process.env.TEST_SOURCE_ID!);
 const records=await searchSource(source,'catalog');
 assert.equal(records[0].id,'1');
 assert.equal(records[0].image,'https://images.example.com/apps/1/abc.jpg');
 assert.deepEqual(await syncSourceDatabase(t,db,source),{updated:1,failed:0});
 console.log('PASS: collection search and source-specific synchronization against SpacetimeDB 2.0.3');
}
main().catch(e=>{console.error(e);process.exitCode=1});
