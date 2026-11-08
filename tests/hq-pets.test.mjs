import test from 'node:test';
import assert from 'node:assert/strict';
import {BREED_SPRITES,spriteForBreed} from '../web/hq-pet.mjs';
import {BREED_SPRITE_IDS} from '../web/hq-breed-map.mjs';
import {readFileSync,existsSync} from 'node:fs';
const catalog=JSON.parse(readFileSync(new URL('../web/assets/breeds.json',import.meta.url)));
test('120 distinct breed sprites are all selectable from catalogue; atlas files exist',()=>{
 assert.equal(BREED_SPRITES.length,120);
 assert.equal(new Set(BREED_SPRITES.map(b=>b[0])).size,120);
 assert.equal(new Set(Object.values(BREED_SPRITE_IDS)).size,120);
 for(let slot=0;slot<120;slot++){
  const id=Object.keys(BREED_SPRITE_IDS).find(id=>BREED_SPRITE_IDS[id]===slot);
  const b=catalog.find(b=>b.id===id);assert.ok(b);
  const sprite=spriteForBreed({breedId:id,breedName:b.name,breedFamily:b.family});
  assert.equal(sprite.slot,slot);assert.ok(existsSync(new URL(sprite.atlas)));
 }
});
test('Akita varieties, collies and Papillon choose distinct correct artwork; custom breeds keep a fallback',()=>{
 assert.equal(spriteForBreed({breedId:'Q29164',breedName:'Акита-ину'}).key,'akita');
 assert.equal(spriteForBreed({breedId:'dw-american-akita',breedName:'Американская акита'}).key,'american-akita');
 assert.equal(spriteForBreed({breedName:'Бордер-колли'}).key,'border');
 assert.equal(spriteForBreed({breedId:'dw-papillon'}).key,'papillon');
 assert.equal(spriteForBreed({breedName:'Неизвестная порода',breedFamily:'sighthound'}).key,'greyhound');
});
