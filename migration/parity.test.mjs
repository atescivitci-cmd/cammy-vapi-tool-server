import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessParity} from './parity.mjs';
const inventory=JSON.parse(readFileSync(new URL('./tool-parity.json',import.meta.url),'utf8'));
test('unverified historical workflows prevent cutover',()=>assert.equal(assessParity(inventory,{}).ready,false));
test('a request boolean cannot prove parity',()=>assert.equal(assessParity(inventory,{confirmed:true,parity:true}).ready,false));
test('every current server endpoint is inventoried',()=>{
 const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const paths=[...source.matchAll(/app\.post\("([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(inventory.render_endpoints.map(x=>x.path).sort(),paths.sort());
});
test('no secret endpoint URLs in portable inventory',()=>{
 const data=JSON.stringify(inventory);assert.ok(!data.includes('pipedream.net'));assert.ok(!data.includes('https://'));
});
