// Автопоиск в OpenStreetMap. Настоящий интернет не нужен: fetch подменяем «ненастоящим»,
// который отвечает заранее заготовленными данными.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OSM_GROUPS, buildOverpassQuery, hasContacts, parseElements, resolveCity, searchOsm } from '../src/osm.js';
import { parseMapLink } from '../shared/normalize.js';

export const OVERPASS_SAMPLE = {
  elements: [
    { type: 'node', id: 1, tags: { amenity: 'cafe', name: 'Компот', phone: '+7 (909) 770-72-32',
      website: 'https://cafe-kompot.ru/', 'addr:street': 'улица Маршала Жукова', 'addr:housenumber': '8' } },
    { type: 'node', id: 2, tags: { amenity: 'bar', name: 'Синичка', website: 'https://vk.com/sinichka',
      'contact:telegram': '@sinichka_bar' } },
    { type: 'way', id: 3, tags: { shop: 'car_repair', name: 'Автосервис Мотор', 'contact:vk': 'motor26' } },
    { type: 'node', id: 4, tags: { shop: 'convenience', name: 'Пятёрочка', 'brand:wikidata': 'Q1768969' } },
    { type: 'node', id: 5, tags: { amenity: 'cafe' } },
    { type: 'node', id: 6, tags: { shop: 'hairdresser', hairdresser: 'barber', name: 'Борода',
      phone: '8 918 000-11-22; +7 918 000-33-44', 'addr:city': 'Михайловск' } },
    { type: 'node', id: 7, tags: { amenity: 'car_wash', name: 'Мойка', 'contact:whatsapp': '+7 918 111-22-33' } },
    { type: 'node', id: 1, tags: { amenity: 'cafe', name: 'Компот' } },
    { type: 'node', id: 8, tags: { amenity: 'car_wash', name: 'Автомойка' } }, // ни телефона, ни ссылки, ни адреса
  ],
};

export const NOMINATIM_SAMPLE = [
  { osm_type: 'node', osm_id: 111, name: 'Ставрополь' },
  { osm_type: 'relation', osm_id: 6712557, name: 'Ставрополь', display_name: 'Ставрополь, Ставропольский край, Россия' },
];

/** Ненастоящий fetch: Nominatim → NOMINATIM_SAMPLE, Overpass → статусы из списка, затем данные. */
export function fakeOsmFetch({ overpass = OVERPASS_SAMPLE, overpassStatuses = [] } = {}) {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith('https://nominatim.openstreetmap.org/')) return Response.json(NOMINATIM_SAMPLE);
    const status = overpassStatuses.shift();
    if (status) return new Response('busy', { status });
    return Response.json(overpass);
  };
  fakeFetch.calls = calls;
  return fakeFetch;
}

const noWait = async () => {};

test('ссылка OpenStreetMap распознаётся как источник с ID', () => {
  assert.deepEqual(parseMapLink('https://www.openstreetmap.org/node/993519002'), { source: 'osm', sourceId: 'node/993519002' });
  assert.deepEqual(parseMapLink('osm.org/way/12#map=18/45/41'), { source: 'osm', sourceId: 'way/12' });
});

test('запрос Overpass: граница города, только с названием, без сетевых', () => {
  const query = buildOverpassQuery(3606712557, OSM_GROUPS.filter((g) => g.id === 'auto'));
  assert.match(query, /area\(id:3606712557\)->\.city;/);
  assert.match(query, /\["shop"~"\^\(car_repair\|tyres\)\$"\]\["name"\]\[!"brand:wikidata"\];/);
  assert.match(query, /\["amenity"="car_wash"\]/);
  assert.match(query, /out tags;/);
});

test('разбор ответа OSM: данные компании в виде полей формы', () => {
  const items = parseElements(OVERPASS_SAMPLE.elements, 'Ставрополь');
  assert.deepEqual(items.map((item) => item.osm_id), ['node/1', 'node/2', 'way/3', 'node/6', 'node/7', 'node/8'],
    'без сетевых, без безымянных и без повторов');

  const [kompot, sinichka, motor, boroda, wash, noContacts] = items;
  assert.equal(hasContacts(noContacts), false);
  assert.equal(hasContacts(boroda), true);
  assert.deepEqual(kompot, {
    osm_id: 'node/1', name: 'Компот', category: 'Рестораны и кафе', city: 'Ставрополь',
    address: 'улица Маршала Жукова, 8', card_url: 'https://www.openstreetmap.org/node/1',
    phone: '+79097707232', website: 'https://cafe-kompot.ru/', other_links: [], site_kind: 'site',
  });
  assert.equal(sinichka.site_kind, 'social');
  assert.equal(sinichka.website, 'https://vk.com/sinichka');
  assert.deepEqual(sinichka.other_links, ['https://t.me/sinichka_bar']);
  assert.equal(motor.category, 'Автосервисы');
  assert.equal(motor.website, 'https://vk.com/motor26');
  assert.equal(boroda.category, 'Барбершопы');
  assert.equal(boroda.phone, '+79180001122', 'первый из нескольких телефонов');
  assert.equal(boroda.city, 'Михайловск', 'город из адреса важнее города поиска');
  assert.equal(wash.website, 'https://wa.me/79181112233');
  assert.equal(wash.site_kind, 'social');
});

test('город: берём границу (relation), а не точку; номер области = 3600000000 + номер relation', async () => {
  const city = await resolveCity('Ставрополь', { fetchImpl: fakeOsmFetch() });
  assert.deepEqual(city, { name: 'Ставрополь', display: 'Ставрополь, Ставропольский край, Россия', areaId: 3606712557 });
});

test('город не найден — понятная ошибка', async () => {
  const fetchImpl = async () => Response.json([]);
  await assert.rejects(resolveCity('Несуществуйск', { fetchImpl }), (error) => error.status === 404 && /Не нашёл город/.test(error.message));
});

test('поиск: два запроса (город + компании) и честное имя программы в заголовке', async () => {
  const fetchImpl = fakeOsmFetch();
  const { city, items, skipped } = await searchOsm({ city: 'Ставрополь', groups: ['food', 'auto'] }, { fetchImpl, wait: noWait });
  assert.equal(city.name, 'Ставрополь');
  assert.equal(items.length, 5);
  assert.equal(skipped, 1, '«Автомойка» без телефона, ссылки и адреса пропущена');
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[1].url, /overpass-api\.de/);
  assert.match(fetchImpl.calls[1].options.headers['User-Agent'], /LeadFinder/);
});

test('поиск: сервер перегружен (502) — до двух повторов с паузой, потом успех', async () => {
  const fetchImpl = fakeOsmFetch({ overpassStatuses: [502, 502] });
  const waits = [];
  const { items } = await searchOsm({ city: 'Ставрополь', groups: ['food'] }, { fetchImpl, wait: async (ms) => waits.push(ms) });
  assert.equal(items.length, 5);
  assert.deepEqual(waits, [5000, 15000]);
  assert.equal(fetchImpl.calls.length, 4); // город + 3 попытки
});

test('поиск: три отказа подряд — сдаёмся с понятной ошибкой', async () => {
  const fetchImpl = fakeOsmFetch({ overpassStatuses: [502, 502, 502] });
  await assert.rejects(searchOsm({ city: 'Ставрополь', groups: ['food'] }, { fetchImpl, wait: noWait }),
    (error) => error.status === 502 && /поиск компаний/.test(error.message));
});

test('поиск: 429 «слишком много запросов» — не повторяем, просим подождать', async () => {
  const fetchImpl = fakeOsmFetch({ overpassStatuses: [429] });
  await assert.rejects(searchOsm({ city: 'Ставрополь', groups: ['food'] }, { fetchImpl, wait: noWait }),
    (error) => error.status === 503 && /подождать/.test(error.message));
  assert.equal(fetchImpl.calls.length, 2);
});

test('поиск: без сфер — ошибка ещё до запросов в интернет', async () => {
  const fetchImpl = fakeOsmFetch();
  await assert.rejects(searchOsm({ city: 'Ставрополь', groups: [] }, { fetchImpl }), (error) => error.status === 400);
  assert.equal(fetchImpl.calls.length, 0);
});

test('поиск: Overpass не успел посчитать (ошибка внутри ответа 200)', async () => {
  const fetchImpl = fakeOsmFetch({ overpass: { elements: [], remark: 'runtime error: Query timed out in "query"' } });
  await assert.rejects(searchOsm({ city: 'Ставрополь', groups: ['food'] }, { fetchImpl, wait: noWait }),
    (error) => error.status === 504);
});
