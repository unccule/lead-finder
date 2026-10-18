// Этап 7: загрузка списка компаний из файла CSV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFile, parseCsv, rowsToCompanies } from '../shared/import-csv.js';
import { companiesToCsv } from '../shared/export-csv.js';
import { assessCompany } from '../shared/hotness.js';
import { openDatabase } from '../src/db.js';
import { createServer } from '../src/server.js';
import { addCompany, importCompanies, listCompanies, updateCompany } from '../src/companies.js';

const NOW = new Date(2026, 9, 18, 12);

test('CSV: кавычки, «;» и переносы строк внутри, CRLF, BOM, пустые строки', () => {
  const text = '﻿Название;Заметка\r\n"Кафе ""Ромашка""; лучшее";"строка 1\nстрока 2"\r\n\r\nМотор;\r\n';
  assert.deepEqual(parseCsv(text), [
    ['Название', 'Заметка'],
    ['Кафе "Ромашка"; лучшее', 'строка 1\nстрока 2'],
    ['Мотор', ''],
  ]);
});

test('CSV: разделитель определяется сам — «;», «,» или табуляция', () => {
  assert.deepEqual(parseCsv('Название,Телефон\nМотор,8 918 111-22-33'), [['Название', 'Телефон'], ['Мотор', '8 918 111-22-33']]);
  assert.deepEqual(parseCsv('Название\tГород\nМотор\tСтаврополь'), [['Название', 'Город'], ['Мотор', 'Ставрополь']]);
});

test('кодировка: UTF-8 и старая windows-1251 (так сохраняет русский Excel)', () => {
  const utf8 = new TextEncoder().encode('Название\nКафе');
  assert.equal(decodeFile(utf8), 'Название\nКафе');
  const cp1251 = new Uint8Array([0xca, 0xe0, 0xf4, 0xe5]); // «Кафе» в windows-1251
  assert.equal(decodeFile(cp1251), 'Кафе');
});

test('столбцы узнаются по разным названиям; посторонние (личные данные) не загружаются', () => {
  const rows = parseCsv('Наименование,Телефоны,Адрес,Директор,ИНН,Сфера\n' +
    'ООО Ромашка,"8 918 111-22-33, 8 900 000-00-00","ул. Ленина, 5",Иванов Иван,2634000000,Кафе');
  const { companies, columns, ignored, error } = rowsToCompanies(rows);
  assert.equal(error, '');
  assert.deepEqual(Object.keys(columns).sort(), ['address', 'category', 'name', 'phone']);
  assert.deepEqual(ignored, ['Директор', 'ИНН']);
  assert.deepEqual(companies, [{ row: 2, name: 'ООО Ромашка', phone: '8 918 111-22-33', address: 'ул. Ленина, 5', category: 'Кафе' }]);
});

test('без столбца с названием — понятная ошибка', () => {
  const { error } = rowsToCompanies(parseCsv('Телефон;Адрес\n+79161112233;ул. Мира, 1'));
  assert.match(error, /Не нашёл столбец с названием/);
  assert.match(rowsToCompanies([]).error, /пустой/);
});

test('«круг»: выгрузил в CSV → загрузил в пустую базу → те же компании, статусы и даты контакта', () => {
  const source = openDatabase(':memory:');
  const kompot = addCompany(source, {
    name: 'Кафе «Компот»; центр', phone: '+79097707232', website: 'vk.com/kompot', other_links: 't.me/kompot\nhipolink.me/kompot',
    rating: '4,7', reviews_count: '214', note: '=не формула', city: 'Ставрополь', card_url: 'https://2gis.ru/stavropol/firm/123',
  }).company;
  updateCompany(source, kompot.id, { status: 'replied', next_contact_at: '25.10.2026' }, { now: NOW });
  addCompany(source, { name: 'Мотор', address: 'ул. Мира, 1' });
  const companies = listCompanies(source);
  const csv = companiesToCsv(companies, new Map(companies.map((c) => [c.id, assessCompany(c, { now: NOW })])));
  source.close();

  const target = openDatabase(':memory:');
  const parsed = rowsToCompanies(parseCsv(decodeFile(new TextEncoder().encode(csv))));
  const summary = importCompanies(target, parsed.companies, { now: NOW });
  assert.deepEqual(summary, { added: 2, duplicates: 0, invalid: 0, problems: [] });

  const restored = listCompanies(target).find((c) => c.name === 'Кафе «Компот»; центр');
  assert.equal(restored.phone, '+79097707232');
  assert.equal(restored.website, 'https://vk.com/kompot');
  assert.equal(restored.other_links, 'https://t.me/kompot\nhttps://hipolink.me/kompot');
  assert.equal(restored.rating, 4.7);
  assert.equal(restored.reviews_count, 214);
  assert.equal(restored.note, '=не формула', 'апостроф защиты от формул снят');
  assert.equal(restored.source_id, '123');
  assert.equal(restored.status, 'replied');
  assert.equal(restored.next_contact_at, '2026-10-25');

  // Повторная загрузка того же файла — только дубли.
  assert.deepEqual(importCompanies(target, parsed.companies), { added: 0, duplicates: 2, invalid: 0, problems: [] });
  target.close();
});

test('API: строки с ошибками пропускаются, номер строки как в Excel', async (t) => {
  const db = openDatabase(':memory:');
  const server = createServer({ db });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    db.close();
  });
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/companies/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const { companies } = rowsToCompanies(parseCsv('Название;Телефон\nМотор;8 918 111-22-33\n;8 900 000-00-00\nВолна;12345'));
  const response = await post({ companies });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.added, 1);
  assert.equal(result.invalid, 2);
  assert.deepEqual(result.problems.map((p) => p.row), [3, 4]);
  assert.match(result.problems[0].error, /название/i);
  assert.match(result.problems[1].error, /номер/i);

  assert.equal((await post({ companies: [] })).status, 400);
  assert.equal((await post({})).status, 400);
});
