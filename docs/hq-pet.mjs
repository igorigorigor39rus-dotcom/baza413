import { BREED_SPRITE_IDS } from "./hq-breed-map.mjs?v=1.1.2";
// Персонажи штаба — отдельные прозрачные иллюстрации. Иконки в поиске пород
// остаются в dog.mjs. Здесь выбирается рисунок, а CSS даёт лёгкое дыхание.
const ATLAS_A = new URL("./assets/pets/dogs-a.webp?v=1.1.2", import.meta.url).href;
const ATLAS_C = new URL("./assets/pets/dogs-c.webp?v=1.1.2", import.meta.url).href;
const ATLAS_D = new URL("./assets/pets/dogs-d.webp?v=1.1.2", import.meta.url).href;
const ATLAS_E = new URL("./assets/pets/dogs-e.webp?v=1.1.2", import.meta.url).href;
const ATLAS_B = new URL("./assets/pets/dogs-b.webp?v=1.1.2", import.meta.url).href;
export const BREED_SPRITES = [
  ["bernese", "бернск|bernese", 0],
  ["german", "немецк.*овчарк|german shepherd", 1],
  ["husky", "хаски|husky", 2],
  ["labrador", "лабрад|labrador", 3],
  ["golden", "золотист.*ретрив|golden retriever", 4],
  ["corgi", "корги|corgi", 5],
  ["pug", "мопс|pug", 6],
  ["french", "француз.*бульдог|french bulldog", 7],
  ["bulldog", "английск.*бульдог|english bulldog|^bulldog$", 8],
  ["beagle", "бигл|beagle", 9],
  ["dachshund", "такс|dachshund", 10],
  ["poodle", "пудел|poodle", 11],
  ["chihuahua", "чихуа|chihuahua", 12],
  ["yorkie", "йоркшир|yorkshire", 13],
  ["pomeranian", "померан|pomeranian|немецк.*шпиц|german spitz", 14],
  ["shiba", "сиба|шиба|shiba", 15],
  ["akita", "акита|akita", 16],
  ["samoyed", "самоед|samoyed", 17],
  ["malamute", "маламут|malamute", 18],
  ["border", "бордер.?колли|border collie", 19],
  ["aussie", "австралийск.*овчарк|australian shepherd", 20],
  ["doberman", "доберман|doberman", 21],
  ["rottweiler", "ротвейлер|rottweiler", 22],
  ["dalmatian", "далмат|dalmatian", 23],
  ["boxer", "бокс[её]р|boxer", 24],
  ["dane", "немецк.*дог|great dane", 25],
  ["corso", "кане.?корсо|cane corso", 26],
  ["newfoundland", "ньюфаунд|newfoundland", 27],
  ["bernard", "сенбернар|saint bernard|st.? bernard", 28],
  ["caucasian", "кавказ.*овчарк|caucasian", 29],
  ["alabai", "среднеазиат|алабай|central asian shepherd", 30],
  ["swiss", "белая.*швейцар|white swiss|white shepherd", 31],
  ["basenji", "басенджи|basenji", 32],
  ["jack", "джек.?рассел|jack russell|parson russell", 33],
  ["westie", "вест.?хайленд|west highland", 34],
  ["scottie", "шотланд.*терьер|скотч.?терьер|scottish terrier", 35],
  ["schnauzer", "шнауцер|schnauzer", 36],
  ["staff", "стаффорд|питбуль|stafford|pit.?bull", 37],
  ["bullterrier", "бультерьер|bull terrier", 38],
  ["cocker", "кокер|cocker|русск.*спаниел", 39],
  ["cavalier", "кавалер.*кинг|cavalier", 40],
  ["shihtzu", "ши.?тцу|shih.?tzu", 41],
  ["pekingese", "пекинес|pekingese", 42],
  ["bichon", "бишон|bichon", 43],
  ["maltese", "мальтез|мальтийск|maltese", 44],
  ["greyhound", "грейхаунд|greyhound|уиппет|whippet|леврет|борз", 45],
  ["crested", "китайск.*хохлат|chinese crested|ксоло|xolo", 46],
  ["basset", "бассет|basset", 47],
  ["ridgeback", "родезийск|rhodesian ridgeback", 48],
  ["weimaraner", "веймаран|weimaraner", 49],
  ["vizsla", "выжл|визсл|vizsla", 50],
  ["gsp", "курцхаар|shorthaired pointer", 51],
  ["pointer", "английск.*пойнтер|english pointer|^pointer$", 52],
  ["irish-setter", "ирланд.*сеттер|irish setter", 53],
  ["english-setter", "английск.*сеттер|english setter", 54],
  ["gordon", "гордон|gordon setter|шотланд.*сеттер", 55],
  ["brittany", "бретон|эпаньол|brittany", 56],
  ["springer", "спрингер|springer", 57],
  ["sharpei", "шарпей|shar.?pei", 58],
  ["chow", "чау|chow", 59],
  ["borzoi", "русск.*псов.*борз|borzoi", 60],
  ["saluki", "салюки|saluki", 61],
  ["afghan", "афган.*борз|afghan hound", 62],
  ["wolfhound", "ирланд.*волкодав|irish wolfhound", 63],
  ["deerhound", "дирхаунд|deerhound", 64],
  ["italian-greyhound", "леврет|italian greyhound", 65],
  ["malinois", "малинуа|malinois|^бельгийская овчарка$|^belgian shepherd$", 66],
  ["tervuren", "тервюрен|tervuren", 67],
  ["groenendael", "грюнендаль|groenendael", 68],
  ["collie", "длиннош[её]рстн.*колли|rough collie|^колли$", 69],
  ["sheltie", "шелти|shetland sheepdog", 70],
  ["cattle", "хилер|австралийск.*пастуш|australian cattle", 71],
  ["kelpie", "келпи|kelpie", 72],
  ["beauceron", "босерон|beauceron", 73],
  ["briard", "бриар|briard", 74],
  ["dutch", "голланд.*овчарк|dutch shepherd", 75],
  ["laekenois", "лакенуа|laekenois", 76],
  ["bobtail", "бобтейл|староанглийск.*овчарк|old english sheepdog", 77],
  ["bearded", "бородат.*колли|bearded collie", 78],
  ["komondor", "комондор|komondor", 79],
  ["puli", "^пули$|^puli$", 80],
  ["bergamasco", "бергамск|бергамас|bergamasco", 81],
  ["tibetan-mastiff", "тибетск.*мастиф|tibetan mastiff", 82],
  ["english-mastiff", "английск.*мастиф|english mastiff", 83],
  ["bullmastiff", "бульмастиф|bullmastiff", 84],
  ["bordeaux", "бордос|bordeaux", 85],
  ["neapolitan", "неаполитан|наполетано|neapolitan", 86],
  ["argentino", "аргентинск.*дог|dogo argentino", 87],
  ["fila", "бразильск.*фила|фила.?браз|fila brasileiro", 88],
  ["boerboel", "бурбуль|boerboel", 89],
  ["leonberger", "леонберг|leonberger", 90],
  ["greater-swiss", "больш.*швейцар.*зеннен|greater swiss", 91],
  ["appenzeller", "аппенцелл|appenzell", 92],
  [
    "black-russian",
    "русск.*ч[её]рн.*терьер|ч[её]рн.*русск.*терьер|black russian terrier",
    93,
  ],
  ["hovawart", "ховаварт|hovawart", 94],
  ["landseer", "ландсир|landseer", 95],
  ["american-akita", "американск.*акита|american akita", 96],
  ["finnish-spitz", "финск.*шпиц|finnish spitz", 97],
  ["keeshond", "кеесхонд|вольфшпиц|keeshond", 98],
  ["vallhund", "вальхунд|vallhund", 99],
  ["elkhound", "элкхунд|эльгхунд|elkhound", 100],
  ["karelian", "карельск.*медвеж|karelian bear", 101],
  ["west-laika", "западносибирск.*лайк|west siberian laika", 102],
  [
    "european-laika",
    "русско.?европейск.*лайк|russian.?european laika|russo.?european laika",
    103,
  ],
  ["lapphund", "финск.*лаппхунд|finnish lapphund", 104],
  ["eurasier", "евразиер|евразийск|eurasier", 105],
  ["papillon", "папильон|папийон|papillon|continental toy spaniel", 106],
  ["toyfox", "той.?фокстерьер|toy fox terrier", 107],
  ["russian-toy", "русск.*той|russian toy", 108],
  [
    "minpinscher",
    "цвергпинчер|миниатюрн.*пинчер|карликов.*пинчер|miniature pinscher",
    109,
  ],
  ["manchester", "манчестер|manchester terrier", 110],
  [
    "russian-spaniel",
    "русск.*(охотнич.*)?спаниел|russian (hunting )?spaniel",
    111,
  ],
  ["lhasa", "лхаса|lhasa", 112],
  ["tibetan-terrier", "тибетск.*терьер|tibetan terrier", 113],
  ["tibetan-spaniel", "тибетск.*спаниел|tibetan spaniel", 114],
  ["havanese", "гаванск|хаванез|havanese", 115],
  ["coton", "котон|coton", 116],
  ["portuguese-water", "португальск.*водян|portuguese water", 117],
  ["lagotto", "лаготто|lagotto", 118],
  ["wheaten", "пшеничн.*терьер|wheaten terrier", 119],
];
const FAMILY = {
  generic: 3,
  retriever: 4,
  shepherd: 1,
  spitz: 15,
  bat: 7,
  flat: 6,
  long: 10,
  sighthound: 45,
  curly: 11,
  spaniel: 39,
  mastiff: 26,
  terrier: 33,
  hound: 9,
  hairless: 46,
};
export function spriteForBreed(breed = {}) {
  const name = (breed.breedName ?? breed.name ?? "").toLowerCase();
  const match = [...BREED_SPRITES.slice(48), ...BREED_SPRITES.slice(0, 48)]
    .find(([, pattern]) => new RegExp(pattern, "i").test(name));
  const slot = BREED_SPRITE_IDS[breed.breedId ?? breed.id] ?? match?.[2] ??
    FAMILY[breed.breedFamily ?? breed.family] ?? 3;
  return {
    key: BREED_SPRITES[slot][0],
    slot,
    atlas: [ATLAS_A, ATLAS_B, ATLAS_C, ATLAS_D, ATLAS_E][Math.floor(slot / 24)],
    index: slot % 24,
  };
}
const SPRITE_ROWS = [
  [0, 249, 502, 755, 1006, 1268, 1536],
  [0, 267, 534, 781, 1028, 1262, 1536],
  [0, 249, 505, 761, 1020, 1275, 1536],
  [0, 260, 512, 764, 1017, 1272, 1536],
  [0, 258, 518, 768, 1020, 1256, 1536],
];
let portraitId = 0;
export function headquartersPet(breed) {
  const item = spriteForBreed(breed), ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const rows = SPRITE_ROWS[Math.floor(item.slot / 24)];
  const row = Math.floor(item.index / 4),
    x = (item.index % 4) * 256,
    y = rows[row],
    height = rows[row + 1] - y;
  svg.style.aspectRatio = `256/${height}`;
  svg.setAttribute("width", "256");
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `${x} ${y} 256 ${height}`);
  svg.setAttribute("aria-label", `Питомец: ${breed?.breedName ?? "метис"}`);
  svg.setAttribute("role", "img");
  svg.classList.add("hq-pet", "is-animated");
  svg.dataset.breedSprite = item.key;
  const clip = document.createElementNS(ns, "clipPath");
  clip.id = `hq-dog-clip-${++portraitId}`;
  const rect = document.createElementNS(ns, "rect");
  Object.entries({ x, y, width: 256, height }).forEach(([k, v]) =>
    rect.setAttribute(k, v)
  );
  clip.append(rect);
  const image = document.createElementNS(ns, "image");
  image.setAttribute("href", item.atlas);
  image.setAttribute("width", "1024");
  image.setAttribute("height", "1536");
  image.setAttribute("clip-path", `url(#${clip.id})`);
  svg.append(clip, image);
  return svg;
}
