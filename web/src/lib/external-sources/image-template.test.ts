import { describe, expect, it, vi, afterEach } from 'vitest';
import { describeRecord, recordImage } from './mapping';
import { EMPTY_SOURCE, type SourceConfig } from './types';
import { searchSource } from './server';
const template='https://images.example.com/apps/{appid}/{art.hash}.jpg';
const config:SourceConfig={...EMPTY_SOURCE,imagePath:'cover_url',imageUrlTemplate:template};
afterEach(()=>vi.unstubAllGlobals());
describe('generic source image templates',()=>{
 it('keeps existing direct cover_url images without any template',()=>{
  expect(describeRecord({id:'game',name:'Game',cover_url:'https://image.api.playstation.com/image.png'},{...EMPTY_SOURCE,imagePath:'cover_url'}).image).toBe('https://image.api.playstation.com/image.png');
 });
 it('combines numeric IDs and nested fields and encodes field values',()=>{
  expect(recordImage({appid:620,art:{hash:'a/b?x=#&'}},config)).toBe('https://images.example.com/apps/620/a%2Fb%3Fx%3D%23%26.jpg');
  expect(recordImage({appid:0,art:{hash:'hash'}},config)).toBe('https://images.example.com/apps/0/hash.jpg');
 });
 it('uses direct URLs or no image when any required field is absent or empty',()=>{
  for(const hash of [undefined,null,'','  ',{},[]]){
   expect(recordImage({appid:620,art:{hash}},config)).toBe('');
   expect(recordImage({appid:620,art:{hash},cover_url:'https://fallback.example/a.png'},config)).toBe('https://fallback.example/a.png');
  }
 });
 it('does not allow record values to choose hosts or executable protocols',()=>{
  for(const imageUrlTemplate of ['javascript:{appid}','https://{host}/a.png','https://user:pass@example.com/{appid}','https://example.com/{__proto__.x}','https://example.com/{oops']){
   expect(recordImage({appid:1,host:'evil.example'}, {...config,imageUrlTemplate})).toBe('');
  }
  expect(recordImage({cover_url:'javascript:alert(1)'},{...config,imageUrlTemplate:''})).toBe('');
 });
 it('includes the template in collection cache identity so edits appear immediately',async()=>{
  const fetch=vi.fn().mockImplementation(async()=>Response.json({items:[{id:1,name:'Game',appid:620,art:{hash:'abc'}}]}));vi.stubGlobal('fetch',fetch);
  const source={config:{...config,sourceId:'image-template-cache',baseUrl:'https://source.example',searchPath:'/items',recordMode:'collection' as const},secret:''};
  expect((await searchSource(source,''))[0].image).toBe('https://images.example.com/apps/620/abc.jpg');
  expect((await searchSource({...source,config:{...source.config,imageUrlTemplate:'https://other.example/{appid}.png'}},''))[0].image).toBe('https://other.example/620.png');
  expect(fetch).toHaveBeenCalledTimes(2);
 });
});
