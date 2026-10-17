// Весь путь через сервер: автопоиск → «Добавить в базу» → фоновая проверка сайтов.
// Интернет ненастоящий: и OpenStreetMap, и сайты компаний отвечают заготовками.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createServer } from '../src/server.js';
import { listCompanies } from '../src/companies.js';
import { fakeOsmFetch } from './osm.test.js';

let db;
let server;
let baseUrl;
let fetchImpl;

before(async () => {
  db = openDatabase(':memory:');
  const osmFetch = fakeOsmFetch();
  // Сайты компаний: у «Компота» — нормальная страница.
  fetchImpl = async (url, options) => {
    if (url === 'https://cafe-kompot.ru/') {
      return new Response('<meta name="viewport" content="width=device-width"><title>Компот</title>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return osmFetch(url, options);
  };
  server = createServer({ db, fetchImpl, lookup: async () => [{ address: '93.184.216.34', family: 4 }], sitePauseMs: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

const post = (path, body) => fetch(baseUrl + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('список сфер для автопоиска', async () => {
  const { groups } = await (await fetch(`${baseUrl}/api/osm/groups`)).json();
  assert.ok(groups.length >= 5);
  assert.deepEqual(groups.filter((g) => g.default).map((g) => g.id), ['food', 'auto', 'beauty']);
});

test('поиск → итоги → добавление в базу → проверка сайтов запускается сама', async () => {
  let response = await post('/api/osm/search', { city: 'Ставрополь', groups: ['food', 'auto', 'beauty'] });
  assert.equal(response.status, 200);
  const search = await response.json();
  assert.equal(search.city.name, 'Ставрополь');
  assert.equal(search.total, 5);
  assert.deepEqual(search.counts, { new_no_site: 4, new_with_site: 1, in_base: 0, skipped_no_contacts: 1 });
  assert.ok(search.sample.some((item) => item.name === 'Синичка'));

  response = await post('/api/osm/import', { search_id: search.search_id, include: ['no_site', 'with_site'] });
  const imported = await response.json();
  assert.deepEqual(imported, { added: 5, duplicates: 0, invalid: 0, site_check_started: true });

  // Ждём, пока фоновая проверка закончится.
  let state;
  do {
    state = await (await fetch(`${baseUrl}/api/site-checks`)).json();
  } while (state.running);
  assert.equal(state.done, 1, 'проверен только собственный сайт «Компота»');
  assert.equal(state.pending, 0);

  const companies = listCompanies(db);
  const kompot = companies.find((c) => c.name === 'Компот');
  assert.equal(kompot.source, 'osm');
  assert.equal(kompot.source_id, 'node/1');
  assert.equal(kompot.site_check.status, 'ok');
  assert.equal(kompot.site_check.mobile, true);
  assert.equal(companies.find((c) => c.name === 'Синичка').site_check, null, 'страницу ВК не открывали');
});

test('повторный поиск видит, что компании уже в базе; повторное добавление ничего не дублирует', async () => {
  const search = await (await post('/api/osm/search', { city: 'Ставрополь', groups: ['food'] })).json();
  assert.deepEqual(search.counts, { new_no_site: 0, new_with_site: 0, in_base: 5, skipped_no_contacts: 1 });
  const imported = await (await post('/api/osm/import', { search_id: search.search_id, include: ['no_site', 'with_site'] })).json();
  assert.equal(imported.added, 0);
  assert.equal(listCompanies(db).length, 5);
});

test('устаревший поиск и неверные данные — понятные ошибки', async () => {
  let response = await post('/api/osm/import', { search_id: 'old', include: ['no_site'] });
  assert.equal(response.status, 410);
  response = await post('/api/osm/search', { city: '', groups: ['food'] });
  assert.equal(response.status, 400);
  response = await post('/api/osm/search', { city: 'Ставрополь', groups: [] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /сферу/);
});

test('ручной запуск проверки: новых сайтов нет — ничего не делаем', async () => {
  const response = await post('/api/site-checks', { scope: 'new' });
  assert.equal(response.status, 202);
  const state = await response.json();
  assert.equal(state.total, 0);
});
