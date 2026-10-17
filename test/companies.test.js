import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { addCompany, listCompanies } from '../src/companies.js';

// Каждый тест получает новую пустую базу в памяти — тесты не мешают друг другу и не трогают data/leads.db.
let db;
beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => { db.close(); });

const romashka2gis = {
  name: 'Кафе «Ромашка»',
  category: 'Рестораны и кафе',
  city: 'Казань',
  address: 'ул. Баумана, 10',
  card_url: 'https://2gis.ru/kazan/firm/70000001012345678',
  phone: '8 (843) 200-00-00',
  website: 'vk.com/romashka_kzn',
  rating: '4,7',
  reviews_count: '1 234',
  note: 'Только страница ВК',
};

test('добавление компании: все поля сохраняются и нормализуются', () => {
  const result = addCompany(db, romashka2gis);
  assert.equal(result.ok, true);

  const { company } = result;
  assert.equal(company.name, 'Кафе «Ромашка»');
  assert.equal(company.category, 'Рестораны и кафе');
  assert.equal(company.city, 'Казань');
  assert.equal(company.source, '2gis');
  assert.equal(company.source_id, '70000001012345678');
  assert.equal(company.phone, '+78432000000');
  assert.equal(company.website, 'https://vk.com/romashka_kzn');
  assert.equal(company.rating, 4.7);
  assert.equal(company.reviews_count, 1234);
  assert.ok(company.created_at);
  assert.equal(listCompanies(db).length, 1);
});

test('список: новые компании сверху', () => {
  addCompany(db, { name: 'Первая' });
  addCompany(db, { name: 'Вторая' });
  addCompany(db, { name: 'Третья' });
  assert.deepEqual(listCompanies(db).map((c) => c.name), ['Третья', 'Вторая', 'Первая']);
});

test('отказ без названия', () => {
  for (const name of [undefined, '', '    ']) {
    const result = addCompany(db, { name, phone: '+7 916 123-45-67' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid');
    assert.match(result.errors.name, /название/i);
  }
  assert.equal(listCompanies(db).length, 0);
});

test('нормализация телефона при сохранении', () => {
  const result = addCompany(db, { name: 'Автосервис', phone: '8 916 123 45 67' });
  assert.equal(result.company.phone, '+79161234567');
});

test('неправильные поля отклоняются с понятными сообщениями', () => {
  const result = addCompany(db, {
    name: 'Салон',
    phone: '22-33-44',
    website: 'javascript:alert(1)',
    rating: '7',
    reviews_count: 'много',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result.errors).sort(), ['phone', 'rating', 'reviews_count', 'website']);
  assert.equal(listCompanies(db).length, 0);
});

test('лишние поля из запроса игнорируются (сервер не доверяет браузеру)', () => {
  const result = addCompany(db, { name: 'Цветы', id: 999, created_at: '2000-01-01', source: 'yandex', name_key: 'взлом' });
  assert.equal(result.ok, true);
  assert.notEqual(result.company.id, 999);
  assert.notEqual(result.company.created_at, '2000-01-01');
  assert.equal(result.company.source, 'other');
});

test('дубль по ID из ссылки 2ГИС — даже с другим названием и телефоном', () => {
  addCompany(db, romashka2gis);
  const result = addCompany(db, {
    name: 'Ромашка, кафе',
    phone: '+7 999 000-00-00',
    card_url: '2gis.ru/kazan/firm/70000001012345678/49.12,55.79',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'duplicate');
  assert.equal(result.existing.name, 'Кафе «Ромашка»');
  assert.match(result.message, /ID карточки в 2ГИС/);
  assert.equal(listCompanies(db).length, 1);
});

test('дубль по ID из ссылки Яндекс Карт', () => {
  addCompany(db, { name: 'Шиномонтаж 24', card_url: 'https://yandex.ru/maps/org/shinomontazh_24/1234567890/' });
  const result = addCompany(db, { name: 'Шиномонтаж', card_url: 'https://yandex.ru/maps/43/kazan/?oid=1234567890&ol=biz' });
  assert.equal(result.reason, 'duplicate');
  assert.match(result.message, /Яндекс Картах|Яндекс Карты/);
});

test('дубль по названию + телефону (запись названия и телефона другая)', () => {
  addCompany(db, { name: 'Кафе «Ромашка»', phone: '+7 (843) 200-00-00' });
  const result = addCompany(db, { name: 'кафе  ромашка', phone: '8 843 2000000' });
  assert.equal(result.reason, 'duplicate');
  assert.match(result.message, /название и телефон/);
});

test('дубль: та же компания из другой карты (другой ID, но то же название и телефон)', () => {
  addCompany(db, romashka2gis);
  const result = addCompany(db, {
    name: 'Кафе Ромашка',
    phone: '+7 843 200-00-00',
    card_url: 'https://yandex.ru/maps/org/romashka/1234567890/',
  });
  assert.equal(result.reason, 'duplicate');
});

test('не дубль: то же название, но другой телефон (разные филиалы)', () => {
  addCompany(db, { name: 'Шиномонтаж', phone: '+7 916 111-11-11' });
  const result = addCompany(db, { name: 'Шиномонтаж', phone: '+7 916 222-22-22' });
  assert.equal(result.ok, true);
});

test('без телефона: дубль по названию + адресу, другой адрес — не дубль', () => {
  addCompany(db, { name: 'Шиномонтаж', address: 'ул. Ленина, 5' });
  assert.equal(addCompany(db, { name: 'шиномонтаж', address: 'ул Ленина 5' }).reason, 'duplicate');
  assert.equal(addCompany(db, { name: 'Шиномонтаж', address: 'ул. Гагарина, 12' }).ok, true);
});

test('без телефона и адреса: дубль по одному названию', () => {
  addCompany(db, { name: 'Барбершоп Борода' });
  const result = addCompany(db, { name: 'барбершоп «Борода»' });
  assert.equal(result.reason, 'duplicate');
  assert.match(result.message, /телефон и адрес не указаны/);
});

test('короткую ссылку не раскрываем: ID нет, дубли проверяются по названию + телефону', () => {
  const result = addCompany(db, { name: 'Автомойка', phone: '+7 916 123-45-67', card_url: 'https://go.2gis.com/abc12' });
  assert.equal(result.company.source, '2gis');
  assert.equal(result.company.source_id, null);
  assert.equal(addCompany(db, { name: 'Автомойка', phone: '89161234567' }).reason, 'duplicate');
});

test('текст с HTML сохраняется как есть — экранирование делает страница при выводе', () => {
  const result = addCompany(db, { name: '<img src=x onerror=alert(1)>' });
  assert.equal(result.company.name, '<img src=x onerror=alert(1)>');
});
