import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCardText } from '../shared/parse-card.js';
import { classifyLink, linkKey } from '../shared/link-kinds.js';

// Пример в стиле 2ГИС: цифры телефона разделены «цифровым тире» (‒), рядом ИНН, цены, e-mail.
const DGIS_TEXT = `Ромашка
Кафе
4.7
128 оценок
ул. Баумана, 10, Казань
Ежедневно с 10:00 до 22:00
+7 (843) 200‒00‒00
8 917 111-22-33
romashka-kafe.ru
vk.com/romashka_kzn
info@romashka-kafe.ru
ИНН 1655123456
ОГРН 1161690012345
Средний чек 1 500 ₽
Открыто до 22:00, 17.10.2026`;

test('вид ссылки: сайт, соцсети, Taplink, карты, каталоги', () => {
  const cases = {
    'romashka-kafe.ru': 'site',
    'https://www.кафе.рф/menu': 'site',
    'vk.com/romashka': 'social',
    'https://t.me/romashka': 'social',
    'wa.me/79161234567': 'social',
    'https://taplink.cc/romashka': 'linkpage',
    'hipolink.me/romashka': 'linkpage',
    'https://2gis.ru/kazan/firm/70000001012345678': 'map',
    'https://yandex.ru/maps/org/romashka/1234567890/': 'map',
    'https://maps.app.goo.gl/abc': 'map',
    'https://n123.yclients.com/company/1': 'directory',
    'avito.ru/kazan/predlozheniya_uslug/remont_123': 'directory',
    'https://clck.ru/abc': 'short',
    'https://yandex.ru/search/?text=кафе': 'service',
  };
  for (const [url, kind] of Object.entries(cases)) {
    assert.equal(classifyLink(url).kind, kind, url);
  }
  assert.equal(classifyLink('vk.com/romashka').label, 'ВКонтакте');
  assert.equal(classifyLink('https://www.кафе.рф/menu').label, 'кафе.рф');
});

test('ключ ссылки: http/https, www и слэш в конце не важны', () => {
  assert.equal(linkKey('http://www.Romashka.ru/'), linkKey('romashka.ru'));
  assert.notEqual(linkKey('vk.com/romashka'), linkKey('vk.com/romashka2'));
});

test('телефоны: находит все номера по порядку, ИНН, ОГРН, цены и даты не принимает за телефон', () => {
  const { phones } = parseCardText(DGIS_TEXT);
  assert.deepEqual(phones, ['+78432000000', '+79171112233']);
});

test('телефоны: одинаковые номера в разной записи считаются одним', () => {
  const { phones } = parseCardText('+7 (843) 200-00-00\n8 843 200 00 00\n+78432000000');
  assert.deepEqual(phones, ['+78432000000']);
});

test('телефоны: цифры внутри ссылок не считаются номером', () => {
  const { phones } = parseCardText('https://yandex.ru/maps/org/kafe/81234567890/\nhttps://2gis.ru/kazan/firm/70000001012345678');
  assert.deepEqual(phones, []);
});

test('ссылки: сайт отдельно от соцсетей, e-mail не считается сайтом', () => {
  const { links } = parseCardText(DGIS_TEXT);
  assert.deepEqual(links.map((l) => [l.kind, l.url]), [
    ['site', 'https://romashka-kafe.ru'],
    ['social', 'https://vk.com/romashka_kzn'],
  ]);
});

test('заполнение: свой сайт — в «Сайт», соцсети — в «Другие ссылки», первый телефон — в форму', () => {
  const { fill } = parseCardText(DGIS_TEXT);
  assert.deepEqual(fill, {
    phone: '+78432000000',
    website: 'https://romashka-kafe.ru',
    other_links: ['https://vk.com/romashka_kzn'],
  });
});

test('заполнение: нет сайта — в «Сайт» идёт Taplink (визитка важнее соцсети), соцсеть — в другие', () => {
  const { fill } = parseCardText('Барбершоп Борода\nvk.com/boroda\ntaplink.cc/boroda\n+7 917 000-11-22');
  assert.equal(fill.website, 'https://taplink.cc/boroda');
  assert.deepEqual(fill.other_links, ['https://vk.com/boroda']);
});

test('заполнение: ссылка на карточку с ID попадает в своё поле, а не в «Сайт»', () => {
  const { fill, links } = parseCardText('Шиномонтаж\nhttps://2gis.ru/kazan/firm/70000001012345678\n+7 843 111-22-33');
  assert.equal(fill.card_url, 'https://2gis.ru/kazan/firm/70000001012345678');
  assert.equal(fill.website, undefined);
  assert.equal(links[0].sourceId, '70000001012345678');
});

test('заполнение: несколько разных организаций на картах — карточку не подставляем, выберешь сам', () => {
  const text = 'https://2gis.ru/kazan/firm/111111111\nПохожие места: https://2gis.ru/kazan/firm/222222222';
  const { fill, links } = parseCardText(text);
  assert.equal(fill.card_url, undefined);
  assert.equal(links.filter((l) => l.kind === 'map').length, 2);
});

test('HTML из буфера: tel:-ссылки, иконки соцсетей и «завёрнутые» ссылки 2ГИС', () => {
  const html = `
    <a href="tel:+7%20843%20200-00-00"><svg></svg></a>
    <a href="https://link.2gis.ru/1.2/7D1E/webapi/20240101/project1/7000/null?http://romashka-kafe.ru">romashka-kafe.ru</a>
    <a href='https://t.me/romashka_kzn'><img src="icon.png"></a>
    <a href="https://vk.com/away.php?to=https%3A%2F%2Ftaplink.cc%2Fromashka&amp;cc_key=">Taplink</a>
    <a href="/kazan/firm/70000001012345678/tab/reviews">Отзывы</a>
    <a href="mailto:info@romashka-kafe.ru">почта</a>
    <a href="javascript:alert(1)">x</a>
    <link href="https://2gis.ru/styles.css">`;
  const { phones, links, fill } = parseCardText('Ромашка', { html });
  assert.deepEqual(phones, ['+78432000000']);
  assert.deepEqual(links.map((l) => l.url), [
    'http://romashka-kafe.ru',
    'https://t.me/romashka_kzn',
    'https://taplink.cc/romashka',
  ]);
  assert.equal(fill.website, 'http://romashka-kafe.ru');
});

test('одна и та же ссылка из HTML и из текста не дублируется', () => {
  const html = '<a href="https://www.romashka-kafe.ru/">romashka-kafe.ru</a>';
  const { links } = parseCardText('Сайт: romashka-kafe.ru.', { html });
  assert.equal(links.length, 1);
});

test('ссылки на карты без ID (профили авторов отзывов) и служебные ссылки не показываются', () => {
  const text = 'https://yandex.ru/maps/user/abc123/\nhttps://yandex.ru/search/?text=кафе\nhttps://2gis.ru/kazan';
  assert.deepEqual(parseCardText(text).links, []);
});

test('скрытый телефон: подсказываем нажать «Показать телефон»', () => {
  assert.equal(parseCardText('Автосервис Мотор\nПоказать телефон').phoneHidden, true);
  assert.equal(parseCardText('Автосервис Мотор\n+7 (843) 200‒0…').phoneHidden, true);
  assert.equal(parseCardText('Автосервис Мотор\n+7 (843) 200-00-00').phoneHidden, false);
});

test('пустой или мусорный текст не ломает разбор', () => {
  for (const text of ['', '   ', 'просто слова без контактов', '<script>alert(1)</script>', null, undefined]) {
    const result = parseCardText(text, { html: '<a href=>' });
    assert.deepEqual(result.phones, []);
    assert.deepEqual(result.links, []);
  }
});
