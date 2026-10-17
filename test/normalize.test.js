import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, normalizeUrl, parseMapLink, textKey } from '../shared/normalize.js';

test('телефон: разные записи приводятся к +7XXXXXXXXXX', () => {
  const variants = [
    '+7 (916) 123-45-67',
    '8 916 123 45 67',
    '8(916)1234567',
    '7 916 123-45-67',
    '9161234567',
    '+7-916-123-45-67',
  ];
  for (const raw of variants) {
    assert.equal(normalizePhone(raw), '+79161234567', raw);
  }
  assert.equal(normalizePhone('+7 (843) 200-00-00 доб. 123'), '+78432000000');
  assert.equal(normalizePhone('8 800 555-35-35'), '+78005553535');
});

test('телефон: пустое поле — пустая строка, мусор — null', () => {
  assert.equal(normalizePhone(''), '');
  assert.equal(normalizePhone('   '), '');
  assert.equal(normalizePhone('22-33-44'), null, 'нет кода города');
  assert.equal(normalizePhone('+380 44 123 4567'), null, 'не российский номер');
  assert.equal(normalizePhone('+8 916 123 45 67'), null);
  assert.equal(normalizePhone('+7 916 123-45-67, +7 495 123-45-67'), null, 'два номера сразу');
});

test('ссылки: добавляется https://, опасные схемы отклоняются', () => {
  assert.equal(normalizeUrl('vk.com/romashka'), 'https://vk.com/romashka');
  assert.equal(normalizeUrl('http://romashka.ru'), 'http://romashka.ru');
  assert.equal(normalizeUrl('кафе.рф'), 'https://кафе.рф');
  assert.equal(normalizeUrl('site.ru:8080/menu'), 'https://site.ru:8080/menu');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('mailto:info@romashka.ru'), null);
  assert.equal(normalizeUrl('просто текст'), null);
  assert.equal(normalizeUrl('localhost'), null);
  assert.equal(normalizeUrl('https://user:pass@romashka.ru'), null);
});

test('ссылка на карточку: 2ГИС и ID организации', () => {
  assert.deepEqual(parseMapLink('https://2gis.ru/kazan/firm/70000001012345678'),
    { source: '2gis', sourceId: '70000001012345678' });
  assert.deepEqual(parseMapLink('2gis.ru/moscow/search/кафе/firm/4504127908538012/37.6,55.7'),
    { source: '2gis', sourceId: '4504127908538012' });
  assert.deepEqual(parseMapLink('https://go.2gis.com/abc12'), { source: '2gis', sourceId: null });
});

test('ссылка на карточку: Яндекс Карты и ID организации', () => {
  assert.deepEqual(parseMapLink('https://yandex.ru/maps/org/romashka/1234567890/'),
    { source: 'yandex', sourceId: '1234567890' });
  assert.deepEqual(parseMapLink('https://yandex.ru/maps/43/kazan/org/kafe_24/1234567890/reviews/'),
    { source: 'yandex', sourceId: '1234567890' });
  assert.deepEqual(parseMapLink('https://yandex.ru/maps/43/kazan/?ll=49.1%2C55.7&mode=search&oid=1234567890&ol=biz&z=17'),
    { source: 'yandex', sourceId: '1234567890' });
  assert.deepEqual(parseMapLink('https://yandex.ru/maps/-/CDabcXYZ'), { source: 'yandex', sourceId: null });
});

test('ссылка на карточку: всё остальное — «другое»', () => {
  assert.deepEqual(parseMapLink('https://romashka.ru'), { source: 'other', sourceId: null });
  assert.deepEqual(parseMapLink('https://yandex.ru/search/?text=кафе'), { source: 'other', sourceId: null });
  assert.deepEqual(parseMapLink('https://evil2gis.ru/firm/123'), { source: 'other', sourceId: null });
  assert.deepEqual(parseMapLink('https://2gis.ru.evil.com/firm/123'), { source: 'other', sourceId: null });
  assert.deepEqual(parseMapLink(''), { source: 'other', sourceId: null });
});

test('ключ для сравнения названий: регистр, кавычки, ё и пробелы не важны', () => {
  assert.equal(textKey('Кафе «Ромашка»'), textKey('  кафе   ромашка '));
  assert.equal(textKey('Ёлки-Палки'), textKey('елки палки'));
});
