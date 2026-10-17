// Проверяем сервер целиком: настоящие HTTP-запросы к серверу на случайном свободном порту.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDatabase } from '../src/db.js';
import { createServer } from '../src/server.js';

let db;
let server;
let baseUrl;

before(async () => {
  db = openDatabase(':memory:');
  server = createServer({ db });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); // порт 0 = любой свободный
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

const postJson = (body) => fetch(`${baseUrl}/api/companies`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('главная страница отдаётся', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /<title>Lead Finder<\/title>/);
});

test('стили, скрипт страницы и общий код отдаются с правильным типом', async () => {
  const files = [
    ['/style.css', /text\/css/],
    ['/app.js', /javascript/],
    ['/shared/normalize.js', /javascript/],
    ['/shared/link-kinds.js', /javascript/],
    ['/shared/parse-card.js', /javascript/],
  ];
  for (const [url, type] of files) {
    const response = await fetch(baseUrl + url);
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get('content-type'), type, url);
  }
});

test('файлы вне public/ и shared/ недоступны', async () => {
  for (const url of ['/..%2Fpackage.json', '/%2e%2e/package.json', '/shared/..%2F..%2Fpackage.json', '/nope.html']) {
    const response = await fetch(baseUrl + url);
    assert.equal(response.status, 404, url);
  }
});

test('API: добавление, список, отказ без названия, дубль', async () => {
  let response = await fetch(`${baseUrl}/api/companies`);
  assert.deepEqual(await response.json(), { companies: [] });

  response = await postJson({
    name: 'Автосервис «Мотор»',
    phone: '8 916 123-45-67',
    card_url: 'https://2gis.ru/kazan/firm/123456',
    website: 'taplink.cc/motor',
    other_links: 'vk.com/motor\nt.me/motor',
  });
  assert.equal(response.status, 201);
  const { company } = await response.json();
  assert.equal(company.phone, '+79161234567');
  assert.equal(company.source, '2gis');
  assert.equal(company.other_links, 'https://vk.com/motor\nhttps://t.me/motor');

  response = await postJson({ name: '', phone: '+79161234567' });
  assert.equal(response.status, 400);
  assert.ok((await response.json()).fields.name);

  response = await postJson({ name: 'Мотор', card_url: '2gis.ru/kazan/firm/123456' });
  assert.equal(response.status, 409);
  const duplicate = await response.json();
  assert.equal(duplicate.existing.id, company.id);
  assert.match(duplicate.error, /уже есть в базе/);

  response = await fetch(`${baseUrl}/api/companies`);
  assert.equal((await response.json()).companies.length, 1);
});

test('API: не JSON и битый JSON отклоняются', async () => {
  let response = await fetch(`${baseUrl}/api/companies`, { method: 'POST', body: 'name=Test' });
  assert.equal(response.status, 415);

  response = await fetch(`${baseUrl}/api/companies`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ name: ',
  });
  assert.equal(response.status, 400);
});

test('запрос с чужим именем хоста отклоняется', async () => {
  const { port } = server.address();
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/companies', headers: { Host: 'evil.example:3001' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});
