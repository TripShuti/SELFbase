import type {StdbTransport} from "../api-endpoint/types";
import {afterEach,describe,expect,it,vi} from 'vitest';
import {EMPTY_SOURCE, type SourceEnrichment} from './types';
import {loadSource,enrichRecords,fetchRecord,searchSource,invalidateSourceCache, type LoadedSource} from './server';
let seq=0;
const rule:SourceEnrichment={path:'/activity',resultsPath:'events',recordMatchPath:'appid',matchPath:'game.id',targetField:'activity'};
function source(extra:Partial<LoadedSource['config']>={}):LoadedSource{return {config:{...EMPTY_SOURCE,sourceId:'enrich-'+ ++seq,baseUrl:'https://api.example.com',recordMode:'collection',syncMode:'interval',searchPath:'/catalog',resultsPath:'games',idPath:'appid',labelPath:'name',enrichments:[rule],mappings:[{sourcePath:'activity.first',targetPropertyId:'7',targetType:'Date',transform:'unixSecondsToMillis',zeroIsEmpty:true}],...extra},secret:'key'}};
const game={appid:620,name:'Game',minutes:99,cover_url:'https://images.example.com/game.jpg'};
function mock(events:unknown[]=[{game:{id:'620'},first:1767225600}]){const fetch=vi.fn(async(url:URL,_init?:RequestInit)=>Response.json(String(url).includes('/activity')?{events}:String(url).includes('/items/')?game:{games:[game,{appid:1,name:'No match'}]}));vi.stubGlobal('fetch',fetch);return fetch;}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()});
describe('generic additional API lists',()=>{
 it('compares shared and bound list definitions independent of JSON property order',async()=>{
  const s=source({linkPropertyId:'50',authHeader:''});
  const reordered={targetField:rule.targetField,matchPath:rule.matchPath,recordMatchPath:rule.recordMatchPath,resultsPath:rule.resultsPath,path:rule.path};
  const transport:StdbTransport={sql:(async(q:string)=>q.includes('workspace_setting')?[{value_json:JSON.stringify(s.config)}]:[{page_id:1,config:JSON.stringify({externalSource:{...s.config,enrichments:[reordered]}})}]) as StdbTransport['sql'],call:async()=>{}};
  await expect(loadSource(transport,'1',s.config.sourceId)).resolves.toMatchObject({config:{enrichments:[rule]}});
 });
 it('joins numeric and string IDs without overwriting source records; no match remains absent',async()=>{
  const fetch=mock(),s=source({imagePath:'cover_url'});
  expect((await searchSource(s,'Game'))[0]).toEqual({id:'620',label:'Game',subtitle:'',image:game.cover_url});
  expect((await fetchRecord(s,'620')).values).toEqual([{propertyId:'7',kind:'Date',value:'1767225600000'}]);
  expect((await fetchRecord(s,'1')).values).toEqual([]);
  expect(game).not.toHaveProperty('activity');expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('coalesces concurrent searches and refreshes; manual refresh invalidates both lists',async()=>{
  const fetch=mock(),s=source();
  await Promise.all([searchSource(s,''),fetchRecord(s,'620'),fetchRecord(s,'1')]);expect(fetch).toHaveBeenCalledTimes(2);
  invalidateSourceCache(s);await fetchRecord(s,'620');expect(fetch).toHaveBeenCalledTimes(4);
 });
 it('supports search/detail sources with one cached extra list and two different source shapes',async()=>{
  const fetch=mock(),s=source({recordMode:'detail',detailPath:'/items/{id}',detailResultPath:''});
  expect((await searchSource(s,'game'))[0].label).toBe('Game');
  expect((await fetchRecord(s,'620')).values[0].value).toBe('1767225600000');
  expect(fetch).toHaveBeenCalledTimes(3);
 });
 it('rejects duplicate IDs, missing match fields and invalid result arrays',async()=>{
  for(const events of [[{game:{id:620}},{game:{id:'620'}}],[{first:1}],null]){
   vi.stubGlobal('fetch',vi.fn(async()=>Response.json({events})));
   await expect(enrichRecords(source(),[game])).rejects.toThrow(/duplicate|match field|JSON array/);
  }
 });
 it('keeps missing and zero dates unmapped, and never substitutes unrelated records',async()=>{
  mock([{game:{id:620},first:0},{game:{id:999},first:1767225600}]);
  expect((await fetchRecord(source(),'620')).values).toEqual([]);
 });
 it('does not cache failed requests as successful snapshots',async()=>{
  const fetch=mock(),s=source();fetch.mockImplementationOnce(async()=>new Response('bad',{status:503}));
  await expect(enrichRecords(s,[game])).rejects.toThrow('503');
  expect((await enrichRecords(s,[game]))[0]).toHaveProperty('activity.first',1767225600);
 });
 it('does not overwrite existing fields or allow prototype namespaces',async()=>{
  mock();await expect(enrichRecords(source(),[{...game,activity:{first:42}}])).rejects.toThrow('conflicts');
  await expect(enrichRecords(source({enrichments:[{...rule,targetField:'__proto__'}]}),[game])).rejects.toThrow('target field');
 });
 it('uses the source origin and authentication; blocks cross-origin additional endpoints',async()=>{
  const fetch=mock(),s=source();await enrichRecords(s,[game]);
  expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer key');
  await expect(enrichRecords(source({enrichments:[{...rule,path:'//evil.example/activity'}]}),[game])).rejects.toThrow('API path');
 });
 it('expires both lists together and separates different credentials and join definitions',async()=>{
  vi.useFakeTimers();const fetch=mock(),s=source({syncIntervalSeconds:60});
  await fetchRecord(s,'620');expect(fetch).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(61000);await fetchRecord(s,'620');expect(fetch).toHaveBeenCalledTimes(4);
  await fetchRecord({...s,secret:'other'},'620');expect(fetch).toHaveBeenCalledTimes(6);
  await fetchRecord({...s,config:{...s.config,enrichments:[{...rule,targetField:'history'}],mappings:[]}},'620');expect(fetch).toHaveBeenCalledTimes(8);
 });
 it('refreshes additional lists with the primary snapshot even if their individual TTL started later',async()=>{
  vi.useFakeTimers();const start=Date.now();let first=true;
  const fetch=vi.fn(async(url:URL)=>{if(String(url).includes('/activity'))return Response.json({events:[{game:{id:620},first:1767225600}]});if(first){first=false;vi.setSystemTime(start+1000)}return Response.json({games:[game]})});
  vi.stubGlobal('fetch',fetch);const s=source({syncIntervalSeconds:60});
  await fetchRecord(s,'620');expect(fetch).toHaveBeenCalledTimes(2);
  vi.setSystemTime(start+60500);await fetchRecord(s,'620');expect(fetch).toHaveBeenCalledTimes(4);
 });
 it('rejects enrichment HTTP errors instead of returning a partial primary snapshot',async()=>{
  mock();const s=source();vi.stubGlobal('fetch',vi.fn(async(url:URL)=>String(url).includes('/activity')?new Response('',{status:401}):Response.json({games:[game]})));
  await expect(fetchRecord(s,'620')).rejects.toThrow('401');
 });
});
