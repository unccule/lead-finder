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
  assert.deepEqual(search.counts, { new_no_site: 4, new_with_site: 1, in_base: 0, excluded: 0, skipped_no_contacts: 1 });
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
  assert.deepEqual(search.counts, { new_no_site: 0, new_with_site: 0, in_base: 5, excluded: 0, skipped_no_contacts: 1 });
  const imported = await (await post('/api/osm/import', { search_id: search.search_id, include: ['no_site', 'with_site'] })).json();
  assert.equal(imported.added, 0);
  assert.equal(listCompanies(db).length, 5);
});

test('выборочно удалённые компании автопоиск больше не предлагает; полная очистка — начинаем с нуля', async () => {
  const sinichka = listCompanies(db).find((c) => c.name === 'Синичка');
  let response = await post('/api/companies/delete', { ids: [sinichka.id] });
  assert.deepEqual(await response.json(), { deleted: 1 });
  assert.equal(listCompanies(db).length, 4);

  let search = await (await post('/api/osm/search', { city: 'Ставрополь', groups: ['food'] })).json();
  assert.deepEqual(search.counts, { new_no_site: 0, new_with_site: 0, in_base: 4, excluded: 1, skipped_no_contacts: 1 });
  let imported = await (await post('/api/osm/import', { search_id: search.search_id, include: ['no_site', 'with_site'] })).json();
  assert.equal(imported.added, 0, '«Синичка» не вернулась');

  response = await post('/api/companies/clear', { confirm: 'all' });
  const cleared = await response.json();
  assert.equal(cleared.deleted, 4);
  assert.equal(cleared.backup, null, 'база в памяти — копию не делаем');
  assert.equal(listCompanies(db).length, 0);

  search = await (await post('/api/osm/search', { city: 'Ставрополь', groups: ['food'] })).json();
  assert.deepEqual(search.counts, { new_no_site: 4, new_with_site: 1, in_base: 0, excluded: 0, skipped_no_contacts: 1 },
    'после полной очистки список «не предлагать» тоже пуст');
  imported = await (await post('/api/osm/import', { search_id: search.search_id, include: ['no_site'] })).json();
  assert.equal(imported.added, 4);
});

test('удалённых раньше можно вернуть галочкой «добавить снова» или очистив список «не предлагать снова»', async () => {
  const get = async (path) => (await fetch(baseUrl + path)).json();
  // Сначала в базе должны быть все 5 найденных компаний (предыдущий тест добавил только «без сайта»).
  const first = await (await post('/api/osm/search', { city: 'Ставрополь', groups: ['food'] })).json();
  await post('/api/osm/import', { search_id: first.search_id, include: ['no_site', 'with_site'] });
  const all = listCompanies(db);
  assert.equal(all.length, 5);
  // Как было у пользователя: «выбрать всех → удалить» — все попали в «не предлагать снова».
  await post('/api/companies/delete', { ids: all.map((c) => c.id) });
  assert.equal(listCompanies(db).length, 0);
  assert.equal((await get('/api/excluded')).count, all.length);

  let search = await (await post('/api/osm/search', { city: 'Ставрополь', groups: ['food'] })).json();
  assert.equal(search.counts.new_no_site + search.counts.new_with_site, 0);
  assert.equal(search.counts.excluded, all.length);

  // Галочка «Удалённые раньше — добавить снова».
  const imported = await (await post('/api/osm/import', { search_id: search.search_id, include: ['excluded'] })).json();
  assert.equal(imported.added, all.length);
  assert.equal((await get('/api/excluded')).count, 0, 'вернувшиеся убраны из «не предлагать снова»');

  // Удалить без запоминания (галочка снята) — список «не предлагать» не растёт.
  await post('/api/companies/delete', { ids: listCompanies(db).map((c) => c.id), remember: false });
  assert.equal((await get('/api/excluded')).count, 0);
  search = await (await post('/api/osm/search', { city: 'Ставрополь', groups: ['food'] })).json();
  assert.equal(search.counts.excluded, 0);
  assert.equal(search.counts.new_no_site + search.counts.new_with_site, all.length);

  // Очистка самого списка «не предлагать снова».
  const back = await (await post('/api/osm/import', { search_id: search.search_id, include: ['no_site', 'with_site'] })).json();
  assert.equal(back.added, all.length);
  await post('/api/companies/delete', { ids: listCompanies(db).map((c) => c.id) });
  assert.equal((await get('/api/excluded')).count, all.length);
  assert.equal((await post('/api/excluded/clear', {})).status, 400, 'без подтверждения не чистим');
  assert.deepEqual(await (await post('/api/excluded/clear', { confirm: 'all' })).json(), { cleared: all.length });
  assert.equal((await get('/api/excluded')).count, 0);

  // Вернём компании для следующих тестов.
  search = await (await post('/api/osm/search', { city: 'Ставрополь', groups: ['food'] })).json();
  await post('/api/osm/import', { search_id: search.search_id, include: ['no_site', 'with_site'] });
});

test('удаление: защита от ошибочных и случайных запросов', async () => {
  for (const body of [{}, { ids: [] }, { ids: ['1'] }, { ids: [1.5] }, { ids: [-1] }, { ids: 'all' }]) {
    const response = await post('/api/companies/delete', body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  for (const body of [{}, { confirm: true }, { confirm: 'yes' }]) {
    const response = await post('/api/companies/clear', body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const notJson = await fetch(`${baseUrl}/api/companies/clear`, { method: 'POST', body: 'confirm=all' });
  assert.equal(notJson.status, 415, 'обычная HTML-форма с чужого сайта не сможет очистить базу');
  assert.ok(listCompanies(db).length > 0, 'ничего не удалено');
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
