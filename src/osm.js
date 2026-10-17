// Автопоиск компаний в OpenStreetMap (OSM) — открытой карте мира, которую заполняют люди.
// Её данные можно законно использовать (лицензия ODbL), нужно только указывать источник:
// «© участники OpenStreetMap».
//
// Один поиск = два запроса:
//  1. Nominatim (поиск адресов OSM): название города → ID его границы на карте.
//  2. Overpass API: все организации нужных видов внутри этой границы — одним запросом.
// Сетевые компании («Магнит», KFC…) отсеиваем сразу: у них в OSM есть метка brand:wikidata,
// а сайт им не продать.
import { normalizePhone } from '../shared/normalize.js';
import { classifyLink } from '../shared/link-kinds.js';
import { pickLinks } from '../shared/parse-card.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Сервисы OSM просят честно представляться: по этому имени видно, кто делает запросы.
const USER_AGENT = 'LeadFinder/0.1 (personal local tool)';
const TIMEOUT_MS = 120_000; // большой город Overpass может считать до минуты и дольше
const RETRY_DELAYS_MS = [5_000, 15_000];

/**
 * Сферы для поиска и соответствующие им метки OSM.
 * Метки — это «теги» вроде amenity=cafe (кафе) или shop=car_repair (автосервис).
 */
export const OSM_GROUPS = [
  { id: 'food', label: 'Рестораны и кафе', default: true,
    filters: ['["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court)$"]'] },
  { id: 'auto', label: 'Автосервисы, шиномонтаж, мойки', default: true,
    filters: ['["shop"~"^(car_repair|tyres)$"]', '["craft"="car_repair"]', '["amenity"="car_wash"]'] },
  { id: 'beauty', label: 'Салоны красоты, парикмахерские', default: true,
    filters: ['["shop"~"^(hairdresser|beauty|massage|tattoo)$"]'] },
  { id: 'medical', label: 'Стоматологии и медцентры', default: false,
    filters: ['["amenity"~"^(dentist|clinic|doctors)$"]'] },
  { id: 'fitness', label: 'Фитнес и спорт', default: false,
    filters: ['["leisure"~"^(fitness_centre|sports_centre)$"]'] },
  { id: 'services', label: 'Бытовые услуги (химчистки, ателье, ремонт обуви)', default: false,
    filters: ['["shop"~"^(dry_cleaning|laundry|tailor|shoe_repair|copyshop|photo)$"]',
      '["craft"~"^(tailor|shoemaker|key_cutter|photographer)$"]'] },
  { id: 'pets', label: 'Ветклиники и зоотовары', default: false,
    filters: ['["amenity"="veterinary"]', '["shop"="pet"]'] },
  { id: 'hotels', label: 'Гостиницы и хостелы', default: false,
    filters: ['["tourism"~"^(hotel|hostel|guest_house|motel)$"]'] },
  { id: 'education', label: 'Курсы и автошколы', default: false,
    filters: ['["amenity"~"^(driving_school|language_school|music_school|dancing_school|prep_school)$"]'] },
  { id: 'shops', label: 'Небольшие магазины (цветы, одежда, мебель…)', default: false,
    filters: ['["shop"~"^(florist|bakery|confectionery|clothes|shoes|gift|toys|jewelry|optician|furniture|hardware|' +
      'doityourself|sports|books|fabric|curtain|interior_decoration|bathroom_furnishing|kitchen|bed|cosmetics|' +
      'perfumery|butcher|seafood|frame|art|music|bicycle|fishing|outdoor|second_hand|baby_goods|bag|watches)$"]'] },
];

/** Ошибка с понятным текстом для человека и HTTP-кодом для ответа сервера. */
export class OsmError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * Ищет компании выбранных сфер в городе.
 * Возвращает { city: { name, display, areaId }, items: [...], skipped }:
 *   items   — компании, с которыми можно работать (см. parseElements);
 *   skipped — сколько пропущено: нет ни телефона, ни ссылки, ни адреса («Автомойка» без всего) —
 *             таким не позвонить, не написать и даже не найти их в 2ГИС.
 */
export async function searchOsm({ city, groups }, { fetchImpl = fetch, wait = sleep } = {}) {
  const selected = OSM_GROUPS.filter((group) => groups.includes(group.id));
  if (selected.length === 0) throw new OsmError('Выбери хотя бы одну сферу', 400);

  const place = await resolveCity(city, { fetchImpl });
  const query = buildOverpassQuery(place.areaId, selected);
  const send = () => requestJson(fetchImpl, OVERPASS_URL, {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
    service: 'поиск компаний',
  });

  // Бесплатный сервер при перегрузке сразу отвечает 502 «очередь заполнена, повторите запрос».
  // Повторяем до двух раз с нарастающей паузой. На 429 («слишком много запросов от тебя»)
  // не повторяем — сервер прямо просит подождать.
  let data;
  for (let attempt = 0; ; attempt++) {
    try {
      data = await send();
      break;
    } catch (error) {
      const retryable = error.status === 502 || error.status === 504;
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
      await wait(RETRY_DELAYS_MS[attempt]);
    }
  }
  // Overpass может ответить «200 OK», но с ошибкой внутри (например, не успел посчитать).
  if (typeof data.remark === 'string' && /error|timed out/i.test(data.remark)) {
    throw new OsmError('OpenStreetMap не успел обработать запрос. Выбери меньше сфер или попробуй позже.', 504);
  }
  const all = parseElements(data.elements, place.name);
  const items = all.filter(hasContacts);
  return { city: place, items, skipped: all.length - items.length };
}

/** Есть хоть что-то, чтобы связаться с компанией или найти её: телефон, ссылка или адрес. */
export function hasContacts(item) {
  return Boolean(item.phone || item.website || item.address);
}

/** Название города → { name, display, areaId }. areaId — номер границы города для Overpass. */
export async function resolveCity(name, { fetchImpl = fetch } = {}) {
  const query = String(name ?? '').trim();
  if (!query) throw new OsmError('Укажи город', 400);

  const url = new URL(NOMINATIM_URL);
  url.search = new URLSearchParams({
    q: query, format: 'jsonv2', limit: '5', countrycodes: 'ru', 'accept-language': 'ru', featureType: 'settlement',
  }).toString();
  const results = await requestJson(fetchImpl, url.href, { service: 'поиск города' });

  // Нужна граница (relation или way), а не просто точка на карте.
  const found = Array.isArray(results) ? results.find((r) => r.osm_type === 'relation' || r.osm_type === 'way') : null;
  if (!found) throw new OsmError(`Не нашёл город «${query}» в OpenStreetMap. Проверь написание.`, 404);

  const id = Number(found.osm_id);
  return {
    name: String(found.name || query),
    display: String(found.display_name || query),
    // Так Overpass нумерует области: 3600000000 + номер relation, 2400000000 + номер way.
    areaId: (found.osm_type === 'relation' ? 3_600_000_000 : 2_400_000_000) + id,
  };
}

/** Текст запроса на языке Overpass QL. ["name"] — только с названием, [!"brand:wikidata"] — без сетей. */
export function buildOverpassQuery(areaId, groups) {
  const lines = groups.flatMap((group) => group.filters)
    .map((filter) => `  nwr(area.city)${filter}["name"][!"brand:wikidata"];`);
  return `[out:json][timeout:110];\narea(id:${Number(areaId)})->.city;\n(\n${lines.join('\n')}\n);\nout tags;`;
}

// Соцсети в OSM записывают по-разному: ссылкой (vk.com/romashka) или просто именем (romashka).
const SOCIAL_TAGS = {
  'contact:vk': 'https://vk.com/',
  'contact:telegram': 'https://t.me/',
  'contact:whatsapp': 'https://wa.me/',
  'contact:instagram': 'https://instagram.com/',
  'contact:ok': 'https://ok.ru/',
  'contact:facebook': 'https://facebook.com/',
  'contact:youtube': 'https://youtube.com/',
  'contact:tiktok': 'https://tiktok.com/@',
};

/**
 * Ответ Overpass → список компаний в том же виде, что и поля нашей формы.
 * Сохраняем только данные компании: название, сферу, адрес, рабочий телефон, сайт и соцсети.
 */
export function parseElements(elements, cityName = '') {
  const items = [];
  const seen = new Set();
  for (const element of Array.isArray(elements) ? elements : []) {
    const tags = element?.tags ?? {};
    const name = String(tags.name ?? '').trim();
    if (!name || tags['brand:wikidata']) continue;

    const osmId = `${element.type}/${element.id}`;
    if (seen.has(osmId)) continue;
    seen.add(osmId);

    const phones = splitValues(tags.phone, tags['contact:phone'], tags['contact:mobile'], tags.mobile)
      .map(normalizePhone).filter(Boolean);
    const links = pickLinks([
      ...splitValues(tags.website, tags['contact:website'], tags.url),
      ...socialLinks(tags),
    ]);

    items.push({
      osm_id: osmId,
      name: name.slice(0, 200),
      category: categoryFor(tags),
      city: String(tags['addr:city'] || cityName).slice(0, 100),
      address: [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(', ').slice(0, 300),
      card_url: `https://www.openstreetmap.org/${osmId}`,
      phone: phones[0] ?? '',
      website: links.website,
      other_links: links.other_links,
      // 'site' — свой сайт; 'social', 'linkpage'… — только соцсеть или визитка; 'none' — ничего.
      site_kind: links.website ? classifyLink(links.website).kind : 'none',
    });
  }
  return items;
}

/** Метки OSM → наша «Сфера» (те же названия, что в подсказках формы). */
function categoryFor(tags) {
  const { amenity, shop, craft, leisure, tourism } = tags;
  if (['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'food_court'].includes(amenity)) return 'Рестораны и кафе';
  if (shop === 'tyres') return 'Шиномонтаж';
  if (amenity === 'car_wash') return 'Автомойки';
  if (shop === 'car_repair' || craft === 'car_repair') return 'Автосервисы';
  if (shop === 'hairdresser') return tags.hairdresser === 'barber' || /барбер/i.test(tags.name) ? 'Барбершопы' : 'Салоны красоты';
  if (shop === 'beauty') return tags.beauty === 'nails' ? 'Ногтевые студии' : 'Салоны красоты';
  if (shop === 'massage') return 'Салоны красоты';
  if (shop === 'tattoo') return 'Тату-салоны';
  if (amenity === 'dentist') return 'Стоматологии';
  if (amenity === 'clinic' || amenity === 'doctors') return 'Медицинские центры';
  if (leisure) return 'Фитнес и спорт';
  if (amenity === 'veterinary' || shop === 'pet') return 'Ветклиники и зоотовары';
  if (tourism) return 'Гостиницы и хостелы';
  if (/school$/.test(amenity ?? '')) return 'Образование и курсы';
  if (shop === 'florist') return 'Цветы';
  if (['dry_cleaning', 'laundry', 'tailor', 'shoe_repair', 'copyshop', 'photo'].includes(shop) || craft) return 'Бытовые услуги';
  if (shop) return 'Магазины';
  return '';
}

function socialLinks(tags) {
  const urls = [];
  for (const [key, prefix] of Object.entries(SOCIAL_TAGS)) {
    for (const value of splitValues(tags[key])) {
      if (/[./]/.test(value)) urls.push(value); // уже ссылка
      else if (key === 'contact:whatsapp') urls.push(prefix + value.replace(/\D/g, ''));
      else urls.push(prefix + value.replace(/^@/, ''));
    }
  }
  return urls;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** В OSM несколько значений пишут через «;»: "+7 900…; +7 901…". */
function splitValues(...values) {
  return values.filter(Boolean).flatMap((value) => String(value).split(';')).map((v) => v.trim()).filter(Boolean);
}

/** Запрос к сервису OSM. service — что делаем («поиск города»), чтобы в ошибке было понятно, где сбой. */
async function requestJson(fetchImpl, url, { service, ...options }) {
  const where = `OpenStreetMap (${service})`;
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new OsmError(`${where} не ответил за 2 минуты. Попробуй позже или выбери меньше сфер.`, 504);
    }
    throw new OsmError(`Нет связи с ${where}: ${error?.cause?.code ?? error?.message}. Проверь интернет.`, 502);
  }
  if (response.status === 429) {
    throw new OsmError(`${where} просит подождать: слишком много запросов. Попробуй через пару минут.`, 503);
  }
  if (!response.ok) {
    await response.body?.cancel();
    // 502/504 у бесплатных серверов OSM обычно значат «сейчас перегружен».
    throw new OsmError(`${where} ответил ошибкой ${response.status} — похоже, сервер перегружен. Попробуй через минуту.`,
      response.status === 504 ? 504 : 502);
  }
  try {
    return await response.json();
  } catch {
    throw new OsmError(`${where} прислал непонятный ответ. Попробуй позже.`, 502);
  }
}
