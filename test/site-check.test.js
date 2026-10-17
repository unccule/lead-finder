// Проверка сайтов — без настоящего интернета: подменяем fetch (сами сайты) и lookup (DNS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSite, createSiteCheckJob } from '../src/site-check.js';
import { siteStatus } from '../shared/site-status.js';
import { openDatabase } from '../src/db.js';
import { addCompany, listCompanies } from '../src/companies.js';

const publicIp = async () => [{ address: '93.184.216.34', family: 4 }];
const NOW = () => new Date('2026-10-18T12:00:00Z');

const GOOD_PAGE = `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Кафе «Ромашка» — Ставрополь</title>
  <link rel="stylesheet" href="https://static.tildacdn.com/css/tilda-grid.css"></head>
  <body><footer>© 2015–2025 Ромашка</footer></body></html>`;

/** Ненастоящий fetch: по адресу отдаёт заранее заданный ответ и запоминает, что запрашивали. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const route = routes[url];
    if (!route) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    if (route instanceof Error) throw route;
    return route();
  };
  fn.calls = calls;
  return fn;
}

const html = (body, init = {}) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const redirect = (location, status = 301) => () => new Response(null, { status, headers: { location } });

test('хороший сайт: открывается, HTTPS, мобильная версия, © год, Tilda — один запрос на главную', async () => {
  const fetchImpl = fakeFetch({ 'https://romashka.ru/': html(GOOD_PAGE) });
  const result = await checkSite('romashka.ru/menu?utm=1', { fetchImpl, lookup: publicIp, now: NOW });

  assert.equal(result.status, 'ok');
  assert.equal(result.http_status, 200);
  assert.equal(result.https, true);
  assert.equal(result.mobile, true);
  assert.equal(result.copyright_year, 2025);
  assert.equal(result.platform, 'Tilda');
  assert.equal(result.title, 'Кафе «Ромашка» — Ставрополь');
  assert.ok(result.page_bytes > 100);
  assert.equal(typeof result.response_ms, 'number');

  assert.equal(fetchImpl.calls.length, 1, 'ровно один запрос');
  assert.equal(fetchImpl.calls[0].url, 'https://romashka.ru/', 'только главная страница');
  assert.equal(fetchImpl.calls[0].options.redirect, 'manual');
  assert.match(fetchImpl.calls[0].options.headers['User-Agent'], /LeadFinder/);
  assert.equal(siteStatus({ website: 'https://romashka.ru', site_check: result }, { now: NOW() }).group, 'ok');
});

test('старый сайт: без мобильной версии, © 2016, http — попадает в «Сайт с проблемами»', async () => {
  const page = '<html><head><title>Автосервис</title></head><body>Copyright &copy; 2012-2016</body></html>';
  const fetchImpl = fakeFetch({ 'http://motor26.ru/': html(page) });
  const result = await checkSite('http://motor26.ru', { fetchImpl, lookup: publicIp, now: NOW });
  assert.equal(result.mobile, false);
  assert.equal(result.copyright_year, 2016);
  assert.equal(result.https, false);

  const status = siteStatus({ website: 'http://motor26.ru', site_check: result }, { now: NOW() });
  assert.equal(status.group, 'problem');
  assert.deepEqual(status.problems.map((p) => p.code), ['no_mobile', 'no_https', 'old_copyright']);
  assert.deepEqual(status.problems.map((p) => p.text),
    ['нет мобильной версии', 'нет HTTPS — браузер пишет «Не защищено»', '© 2016 — сайт давно не обновляли']);
});

test('переадресация http → https проходится (это та же главная страница)', async () => {
  const fetchImpl = fakeFetch({
    'http://romashka.ru/': redirect('https://romashka.ru/'),
    'https://romashka.ru/': html(GOOD_PAGE),
  });
  const result = await checkSite('http://romashka.ru', { fetchImpl, lookup: publicIp, now: NOW });
  assert.equal(result.status, 'ok');
  assert.equal(result.https, true);
  assert.equal(result.final_url, 'https://romashka.ru/');
  assert.equal(fetchImpl.calls.length, 2);
});

test('сайт переадресует на ВКонтакте — туда не идём, это и есть ответ', async () => {
  const fetchImpl = fakeFetch({ 'https://romashka.ru/': redirect('https://vk.com/romashka', 302) });
  const result = await checkSite('https://romashka.ru', { fetchImpl, lookup: publicIp, now: NOW });
  assert.equal(result.status, 'redirect_away');
  assert.match(result.note, /ВКонтакте/);
  assert.equal(fetchImpl.calls.length, 1, 'vk.com не открывали');
});

test('соцсети, Taplink и карты не открываем вообще', async () => {
  const fetchImpl = fakeFetch({});
  for (const url of ['https://vk.com/romashka', 'taplink.cc/romashka', 'https://2gis.ru/kazan/firm/1']) {
    assert.equal((await checkSite(url, { fetchImpl, lookup: publicIp })).status, 'not_site', url);
  }
  assert.equal(fetchImpl.calls.length, 0);
});

test('домен не существует', async () => {
  const lookup = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); };
  const result = await checkSite('https://cafe-kompot.ru/', { fetchImpl: fakeFetch({}), lookup, now: NOW });
  assert.equal(result.status, 'dns');
  assert.equal(siteStatus({ website: 'https://cafe-kompot.ru/', site_check: result }).label, 'Домен не существует');
});

test('сайт не ответил за отведённое время', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  // Таймер AbortSignal.timeout не удерживает Node от завершения (в программе это делает сервер).
  // В тесте держим «живым» обычным таймером, пока ждём срабатывания таймаута.
  const keepAlive = setTimeout(() => {}, 5_000);
  const result = await checkSite('https://slow.ru', { fetchImpl, lookup: publicIp, timeoutMs: 50, now: NOW });
  clearTimeout(keepAlive);
  assert.equal(result.status, 'timeout');
});

test('сломанный HTTPS: пробуем http:// — сайт открылся, но отмечаем, что HTTPS не работает', async () => {
  const tlsError = new TypeError('fetch failed', { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } });
  const fetchImpl = fakeFetch({
    'https://veranda-rest.ru/': tlsError,
    'http://veranda-rest.ru/': html('<title>Veranda-rest.ru</title> Сайт в процессе разработки. Домен veranda-rest.ru зарегистрирован'),
  });
  const result = await checkSite('https://veranda-rest.ru/', { fetchImpl, lookup: publicIp, now: NOW });
  assert.equal(result.status, 'parked');
  assert.equal(result.https, false);
  assert.match(result.note, /HTTPS не работает/);
  assert.equal(siteStatus({ website: 'https://veranda-rest.ru/', site_check: result }).label, 'Заглушка вместо сайта');
});

test('обрыв соединения на HTTPS: тоже пробуем http://', async () => {
  const reset = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  const fetchImpl = fakeFetch({ 'https://topgun.ru/': reset, 'http://topgun.ru/': html(GOOD_PAGE) });
  const result = await checkSite('https://topgun.ru', { fetchImpl, lookup: publicIp, now: NOW });
  assert.equal(result.status, 'ok');
  assert.equal(result.https, false);
  assert.match(result.note, /обрывает соединение/);
});

test('главная отвечает 404, а в карточке указана страница филиала — проверяем её (не больше одного запроса)', async () => {
  const fetchImpl = fakeFetch({
    'https://chain.ru/': html('not found', { status: 404 }),
    'https://chain.ru/salons/stavropol': html(GOOD_PAGE),
  });
  const result = await checkSite('https://chain.ru/salons/stavropol', { fetchImpl, lookup: publicIp, now: NOW });
  assert.equal(result.status, 'ok');
  assert.match(result.note, /страницу из карточки/);
  assert.equal(fetchImpl.calls.length, 2);

  const rootOnly = fakeFetch({ 'https://big-bro.ru/': html('not found', { status: 404 }) });
  assert.equal((await checkSite('https://big-bro.ru/', { fetchImpl: rootOnly, lookup: publicIp })).status, 'http_error');
  assert.equal(rootOnly.calls.length, 1, 'в карточке и так главная — второй раз не идём');
});

test('сайт на бесплатном адресе конструктора — это проблема (повод предложить свой сайт)', async () => {
  const fetchImpl = fakeFetch({ 'https://romashka.tilda.ws/': html(GOOD_PAGE) });
  const result = await checkSite('romashka.tilda.ws', { fetchImpl, lookup: publicIp, now: NOW });
  assert.equal(result.free_host, 'Tilda');
  const status = siteStatus({ website: 'romashka.tilda.ws', site_check: result }, { now: NOW() });
  assert.equal(status.group, 'problem');
  assert.deepEqual(status.problems, [{ code: 'free_host', text: 'сайт на бесплатном адресе конструктора (Tilda)' }]);
});

test('адреса внутренней сети не открываем (защита от ссылки-ловушки)', async () => {
  const fetchImpl = fakeFetch({});
  const privateIp = async () => [{ address: '192.168.1.1', family: 4 }];
  assert.equal((await checkSite('http://router-trap.ru', { fetchImpl, lookup: privateIp })).status, 'blocked');
  assert.equal((await checkSite('http://127.0.0.1:3001', { fetchImpl, lookup: publicIp })).status, 'blocked');
  // [::1] без точки в имени вообще не считается адресом сайта — тоже не открываем.
  assert.ok(['blocked', 'not_site'].includes((await checkSite('http://[::1]/', { fetchImpl, lookup: publicIp })).status));
  assert.equal(fetchImpl.calls.length, 0, 'ни одного запроса');
});

test('ошибки сервера: 500 — проблема, 403 — «проверь вручную» (часто это защита от ботов)', async () => {
  const fetchImpl = fakeFetch({
    'https://broken.ru/': html('error', { status: 500 }),
    'https://guarded.ru/': html('forbidden', { status: 403 }),
  });
  const broken = await checkSite('broken.ru', { fetchImpl, lookup: publicIp });
  const guarded = await checkSite('guarded.ru', { fetchImpl, lookup: publicIp });
  assert.equal(broken.status, 'http_error');
  assert.equal(siteStatus({ website: 'broken.ru', site_check: broken }).group, 'problem');
  assert.equal(siteStatus({ website: 'guarded.ru', site_check: guarded }).group, 'unchecked');
});

test('старые сайты в кодировке windows-1251 читаются правильно', async () => {
  const cp1251 = Buffer.from([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0xca, 0xe0, 0xf4, 0xe5, 0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e]); // <title>Кафе</title>
  const fetchImpl = fakeFetch({ 'https://old.ru/': () => new Response(cp1251, { headers: { 'content-type': 'text/html; charset=windows-1251' } }) });
  assert.equal((await checkSite('old.ru', { fetchImpl, lookup: publicIp })).title, 'Кафе');
});

test('итог по компании: нет сайта, только соцсеть, не проверен', () => {
  assert.deepEqual(siteStatus({ website: '' }),
    { group: 'none', label: 'Сайта нет', problems: [{ code: 'no_site', text: 'нет сайта' }] });
  assert.equal(siteStatus({ website: 'https://vk.com/romashka' }).label, 'Только ВКонтакте');
  assert.equal(siteStatus({ website: 'https://taplink.cc/romashka' }).group, 'none');
  assert.equal(siteStatus({ website: 'https://romashka.ru', site_check: null }).group, 'unchecked');
});

test('фоновая проверка: только свои сайты, один сайт филиалов — один раз, пауза между сайтами, результат в базе', async () => {
  const db = openDatabase(':memory:');
  addCompany(db, { name: 'Ромашка', address: 'ул. Ленина, 1', website: 'romashka.ru' });
  addCompany(db, { name: 'Ромашка', address: 'ул. Мира, 2', website: 'https://www.romashka.ru/' });
  addCompany(db, { name: 'Мотор', website: 'motor26.ru' });
  addCompany(db, { name: 'Синичка', website: 'vk.com/sinichka' });
  addCompany(db, { name: 'Без сайта' });

  const checked = [];
  const waits = [];
  const job = createSiteCheckJob({
    db,
    check: async (url) => {
      checked.push(url);
      return { checked_at: '2026-10-18T12:00:00.000Z', status: 'ok', https: true, mobile: true };
    },
    wait: async (ms) => waits.push(ms),
  });

  const started = job.start('new');
  assert.equal(started.started, true);
  assert.equal(started.total, 3, 'ВК и компания без сайта не проверяются');
  assert.equal(job.start('new').started, false, 'вторая проверка параллельно не запускается');
  while (job.status().running) await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(checked, ['https://romashka.ru', 'https://motor26.ru'], 'romashka.ru — один раз на два филиала');
  assert.deepEqual(waits, [1500], 'пауза между двумя разными сайтами');
  const companies = listCompanies(db);
  assert.equal(companies.filter((c) => c.site_check?.status === 'ok').length, 3);
  assert.equal(job.status().done, 3);
  assert.equal(job.start('new').total, 0, 'проверенные повторно не проверяются');
  db.close();
});
