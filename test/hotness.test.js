// «Горячесть» 0–100 с причинами.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCompany, byHotness } from '../shared/hotness.js';

const NOW = new Date('2026-10-18T12:00:00Z');
const assess = (company) => assessCompany({ id: 1, website: '', phone: '', other_links: '', ...company }, { now: NOW });
const texts = (assessment) => assessment.reasons.map((r) => (r.points > 0 ? `+${r.points} ${r.text}` : r.text));

test('нет сайта, есть телефон — горячий (главная цель поиска)', () => {
  const result = assess({ phone: '+79181112233' });
  assert.equal(result.score, 70);
  assert.deepEqual(result.level, { id: 'hot', label: 'Горячий' });
  assert.deepEqual(texts(result), ['+60 нет сайта', '+10 есть рабочий телефон']);
});

test('нет сайта и нет телефона — тёплый: до компании сложнее достучаться', () => {
  const result = assess({});
  assert.equal(result.score, 60);
  assert.equal(result.level.id, 'warm');
});

test('вместо сайта только ВКонтакте — горячий, и можно написать в ВК', () => {
  const result = assess({ website: 'https://vk.com/sinichka', phone: '+79054664477' });
  assert.equal(result.score, 75);
  assert.deepEqual(texts(result), ['+60 вместо сайта — только ВКонтакте', '+10 есть рабочий телефон', '+5 можно написать: ВКонтакте']);
  assert.equal(result.site.group, 'none');
});

test('Taplink вместо сайта и Telegram в других ссылках', () => {
  const result = assess({ website: 'https://taplink.cc/boroda', other_links: 'https://t.me/boroda' });
  assert.deepEqual(texts(result), ['+60 вместо сайта — только Taplink', '+5 можно написать: Telegram']);
});

test('домен умер — самый горячий случай: за сайт уже платили', () => {
  const result = assess({ website: 'https://imperiyacentr.ru', phone: '+78652000000', site_check: { status: 'dns' } });
  assert.equal(result.score, 75);
  assert.equal(texts(result)[0], '+65 домен сайта не существует или не продлён');
});

test('рабочий сайт с проблемами: баллы за каждую проблему', () => {
  const result = assess({
    website: 'http://maximotto.com',
    phone: '+78652231150',
    site_check: { status: 'ok', https: false, mobile: false },
  });
  assert.equal(result.score, 50);
  assert.equal(result.level.id, 'warm');
  assert.deepEqual(texts(result), ['+25 нет мобильной версии', '+15 нет HTTPS — браузер пишет «Не защищено»', '+10 есть рабочий телефон']);
});

test('проблемы рабочего сайта в сумме не больше 70 — не «перевешивают» мёртвый сайт', () => {
  const result = assess({
    website: 'romashka.tilda.ws',
    site_check: { status: 'ok', https: false, mobile: false, free_host: 'Tilda', copyright_year: 2014, response_ms: 9000 },
  });
  const sitePoints = result.reasons.reduce((sum, r) => sum + r.points, 0);
  assert.equal(sitePoints, 70);
  assert.ok(result.reasons.some((r) => r.text === 'медленно открывается' && r.points === 0), 'причина видна, но баллы уже набраны');
});

test('хороший сайт — холодный, причина «сайт в порядке»', () => {
  const result = assess({ website: 'https://harlemstv.ru', phone: '+7', site_check: { status: 'ok', https: true, mobile: true } });
  assert.equal(result.score, 10);
  assert.equal(result.level.id, 'cold');
  assert.ok(texts(result).includes('сайт в порядке'));
});

test('сайт ещё не проверен — немного баллов и подсказка проверить', () => {
  const result = assess({ website: 'https://romashka.ru' });
  assert.equal(result.score, 15);
  assert.match(texts(result)[0], /не проверен/);
});

test('отзывы и рейтинг добавляют баллы, итог не больше 100', () => {
  const result = assess({
    website: 'https://vk.com/romashka', phone: '+7', reviews_count: 230, rating: 4.8,
  });
  assert.deepEqual(texts(result).slice(-3), ['+10 много отзывов (230) — бизнес живой', '+5 можно написать: ВКонтакте', '+5 высокий рейтинг 4,8 — дорожат репутацией']);
  assert.equal(result.score, 90);

  const capped = assess({
    website: 'https://imperiyacentr.ru', phone: '+7', other_links: 'vk.com/x', reviews_count: 500, rating: 5,
    site_check: { status: 'dns' },
  });
  assert.equal(capped.score, 95);
  assert.ok(capped.score <= 100);
});

test('сортировка «сначала горячие»: по баллам, при равенстве — новые выше', () => {
  const companies = [
    { id: 1, website: 'https://harlemstv.ru', site_check: { status: 'ok', https: true, mobile: true } },
    { id: 2, website: '', phone: '+7' },
    { id: 3, website: 'https://vk.com/a', phone: '+7' },
    { id: 4, website: '', phone: '+7' },
  ];
  const assessments = new Map(companies.map((c) => [c.id, assessCompany({ other_links: '', ...c }, { now: NOW })]));
  assert.deepEqual([...companies].sort(byHotness(assessments)).map((c) => c.id), [3, 4, 2, 1]);
});
