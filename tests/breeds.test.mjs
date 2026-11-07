import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {filterBreeds} from '../web/breeds.mjs';
import {createClient} from '../web/client.mjs';
const catalog=JSON.parse(readFileSync(new URL('../web/assets/breeds.json',import.meta.url)));
test('breed search: Russian, English aliases and uncommon custom names',()=>{
 assert.ok(catalog.length>500);
 assert.equal(new Set(catalog.map(b=>b.id)).size,catalog.length);
 const ru=filterBreeds(catalog,'лабрадор'),en=filterBreeds(catalog,'labrador');
 assert.ok(ru.length>0&&en.length>0);assert.ok(ru.some(b=>en.some(e=>e.id===b.id)));
 assert.equal(catalog.some(b=>b.name.includes('Список символов')),false);
 assert.ok(filterBreeds(catalog,'хаски').length>0);
});
test('demo and Python query parameters cannot activate an offline wallet',async()=>{
 let requested;
 const client=createClient({location:{search:'?demo=1&backend=python'},fetch:async url=>{requested=url;return Response.json({pet:null});}});
 assert.equal(client.isDemo,false);assert.equal(client.isPython,false);
 await client.api('/api/me');assert.match(requested,/supabase.co\/functions\/v1\/paws-api\/api\/me$/);
});
