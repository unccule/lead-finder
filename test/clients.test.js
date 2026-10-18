// Этап 5: работа с клиентами — статусы, даты контакта, история, правка компании, экспорт CSV.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createServer } from '../src/server.js';
import { addCompany, deleteCompanies, getStatusHistory, listCompanies, saveSiteCheck, updateCompany } from '../src/companies.js';
import { addDays, contactReminder, normalizeDate } from '../shared/statuses.js';
import { companiesToCsv, csvFileName } from '../shared/export-csv.js';
import { assessCompany } from '../shared/hotness.js';

const NOW = new Date(2026, 9, 18, 12, 0); // 18 октября 2026, полдень по часам компьютера
let db;
beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => { db.close(); });

const add = (data) => addCompany(db, { city: 'Ставрополь', ...data }).company;

test('даты: календарь и ДД.ММ.ГГГГ понимаются, несуществующие — нет', () => {
  assert.equal(normalizeDate('2026-10-21'), '2026-10-21');
  assert.equal(normalizeDate('21.10.2026'), '2026-10-21');
  assert.equal(normalizeDate(''), '');
  assert.equal(normalizeDate('31.02.2026'), null);
  assert.equal(normalizeDate('завтра'), null);
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
});

test('напоминания: просрочено / сегодня / позже; у клиентов и отказов напоминаний нет', () => {
  const today = '2026-10-18';
  assert.equal(contactReminder({ status: 'contacted', next_contact_at: '2026-10-17' }, today).state, 'overdue');
  assert.equal(contactReminder({ status: 'replied', next_contact_at: today }, today).label, 'связаться сегодня');
  assert.equal(contactReminder({ status: 'meeting', next_contact_at: '2026-10-25' }, today).label, 'связаться 25.10.2026');
  assert.equal(contactReminder({ status: 'client', next_contact_at: '2026-10-17' }, today), null);
  assert.equal(contactReminder({ status: 'new', next_contact_at: null }, today), null);
});

test('новая компания — статус «Новый», без даты контакта', () => {
  const company = add({ name: 'Ромашка' });
  assert.equal(company.status, 'new');
  assert.equal(company.next_contact_at, null);
});

test('«Написал» без даты — напомнить через 3 дня; своя дата важнее; «Отказ» убирает дату', () => {
  const company = add({ name: 'Ромашка', phone: '+79161112233' });
  let result = updateCompany(db, company.id, { status: 'contacted' }, { now: NOW });
  assert.equal(result.company.status, 'contacted');
  assert.equal(result.company.next_contact_at, '2026-10-21');

  result = updateCompany(db, company.id, { status: 'replied', next_contact_at: '25.10.2026' }, { now: NOW });
  assert.equal(result.company.next_contact_at, '2026-10-25');

  result = updateCompany(db, company.id, { status: 'refused' }, { now: NOW });
  assert.equal(result.company.next_contact_at, null);
  assert.deepEqual(getStatusHistory(db, company.id).map((h) => h.label), ['Написал', 'Ответил', 'Отказ']);
});

test('правка: можно прислать одно поле, остальные не меняются; ошибки — понятные', () => {
  const company = add({ name: 'Ромашка', phone: '8 916 111-22-33', note: 'старая' });
  let result = updateCompany(db, company.id, { note: 'Перезвонить после обеда' });
  assert.equal(result.company.note, 'Перезвонить после обеда');
  assert.equal(result.company.phone, '+79161112233');
  assert.equal(result.company.name, 'Ромашка');

  result = updateCompany(db, company.id, { name: '  ', status: 'boss', next_contact_at: '32.13.2026' });
  assert.equal(result.reason, 'invalid');
  assert.deepEqual(Object.keys(result.errors).sort(), ['name', 'next_contact_at', 'status']);
  assert.equal(updateCompany(db, 9999, { note: 'x' }).reason, 'not_found');
});

test('правка не может сделать компанию дублем другой, но сама себе она не дубль', () => {
  const romashka = add({ name: 'Ромашка', phone: '+79161112233' });
  const motor = add({ name: 'Мотор', phone: '+79161112244' });
  assert.equal(updateCompany(db, romashka.id, { name: 'Ромашка', phone: '+7 916 111-22-33' }).ok, true);
  const result = updateCompany(db, motor.id, { name: 'ромашка', phone: '8 916 111 22 33' });
  assert.equal(result.reason, 'duplicate');
  assert.match(result.message, /Изменения не сохранены/);
});

test('поменялся сайт — старая проверка сайта сбрасывается, иначе остаётся', () => {
  const company = add({ name: 'Ромашка', website: 'romashka.ru' });
  saveSiteCheck(db, company.id, { checked_at: 'x', status: 'ok', https: true, mobile: true });
  assert.ok(updateCompany(db, company.id, { note: 'заметка' }).company.site_check);
  assert.equal(updateCompany(db, company.id, { website: 'romashka-new.ru' }).company.site_check, null);
});

test('удалили компанию — её история статусов удалилась тоже', () => {
  const company = add({ name: 'Ромашка' });
  updateCompany(db, company.id, { status: 'contacted' });
  deleteCompanies(db, [company.id]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM status_history').get().n, 0);
});

test('API: карточка компании с историей, правка, 404 для несуществующей', async (t) => {
  const server = createServer({ db });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/companies`;
  const company = add({ name: 'Ромашка' });

  let response = await fetch(`${base}/${company.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'meeting' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).company.status, 'meeting');

  response = await fetch(`${base}/${company.id}`);
  const card = await response.json();
  assert.equal(card.company.name, 'Ромашка');
  assert.deepEqual(card.history.map((h) => h.label), ['Встреча']);

  assert.equal((await fetch(`${base}/9999`)).status, 404);
  assert.equal((await fetch(`${base}/abc`)).status, 404, 'не число — такого адреса нет');
  response = await fetch(`${base}/${company.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '' }),
  });
  assert.equal(response.status, 400);
});

test('CSV для Excel: BOM, «;», кавычки, телефон с плюсом, защита от формул', () => {
  add({ name: 'Кафе «Компот»; лучшее', phone: '+79097707232', note: 'Строка 1\nСтрока 2 "в кавычках"', rating: '4,7' });
  add({ name: '=HYPERLINK("http://evil")', note: '-скидка' });
  const companies = listCompanies(db);
  const assessments = new Map(companies.map((c) => [c.id, assessCompany(c, { now: NOW })]));
  const csv = companiesToCsv(companies, assessments);

  assert.ok(csv.startsWith('﻿'), 'BOM в начале');
  assert.ok(csv.endsWith('\r\n'));
  const [header] = csv.slice(1).split('\r\n');
  assert.equal(header.split(';')[0], 'Горячесть');
  assert.equal(header.split(';').length, 19);
  assert.match(csv, /"Кафе «Компот»; лучшее"/, 'значение с «;» — в кавычках');
  assert.match(csv, /"Строка 1\nСтрока 2 ""в кавычках"""/, 'кавычки удвоены, перенос строки внутри кавычек');
  assert.match(csv, /"=""\+79097707232"""/, 'телефон как ="+7…", чтобы Excel не съел плюс');
  assert.match(csv, /;4,7;/, 'рейтинг с запятой для русского Excel');
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil""\)"/, 'формула из данных обезврежена апострофом');
  assert.match(csv, /;'-скидка;/);
  assert.match(csv, /нет сайта \(\+60\)/, 'причины без «+» в начале ячейки');
  assert.equal(csvFileName(NOW), 'lead-finder-2026-10-18.csv');
});
