// Генерирует связь ID справочника с рисунками по названиям и синонимам.
// Сами изображения создаются отдельно; этот скрипт ничего не рисует.
import {readFileSync,writeFileSync} from 'node:fs';
import {BREED_SPRITES} from '../web/hq-pet.mjs';
const root=new URL('../',import.meta.url);
const catalog=JSON.parse(readFileSync(new URL('web/assets/breeds.json',root)));
const rules=[...BREED_SPRITES.slice(48),...BREED_SPRITES.slice(0,48)];
const ids={};
for(const breed of catalog){
 const match=rules.find(([,pattern])=>[breed.name,...breed.aliases].some(name=>new RegExp(pattern,'i').test(name)));
 if(match)ids[breed.id]=match[2];
}
writeFileSync(new URL('web/hq-breed-map.mjs',root),'// Генерируется scripts/build_pet_sprites.mjs; точные ID важнее похожих названий.\nexport const BREED_SPRITE_IDS = '+JSON.stringify(ids,null,2)+';\n');
console.log('Breed catalogue IDs matched to individual sprites:',Object.keys(ids).length);
