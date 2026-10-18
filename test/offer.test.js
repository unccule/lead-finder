// Этап 6: черновик персонального предложения и подпись в настройках.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOffer } from '../shared/offer.js';
import { assessCompany } from '../shared/hotness.js';
import { openDatabase } from '../src/db.js';
import { createServer } from '../src/server.js';
import { addCompany, updateCompany } from '../src/companies.js';
import { getSettings, saveSettings } from '../src/settings.js';

const NOW = new Date(2026, 9, 18);
const SENDER = { sender_name: 'Григорий', sender_contact: 'Telegram @grisha', portfolio_url: 'https://grisha-sites.ru' };
const offer = (company, sender = SENDER, variant = 'short') =>
  buildOffer(company, assessCompany({ other_links: '', ...company }, { now: NOW }), sender, { variant });

test('нет сайта: имя компании, причина, польза для сферы, подпись', () => {
  const text = offer({ name: 'Шиномонтаж 24', category: 'Шиномонтаж', website: '' });
  assert.match(text, /^Здравствуйте! Меня зовут Григорий/);
  assert.match(text, /Нашёл «Шиномонтаж 24» на карте и заметил: сайта у вас нет/);
  assert.match(text, /онлайн-запись на удобное время/);
  assert.match(text, /Telegram @grisha/);
  assert.match(text, /Примеры работ: https:\/\/grisha-sites\.ru/);
});

test('только соцсеть или Taplink — правильные предлоги и формулировки', () => {
  assert.match(offer({ name: 'Компот', category: 'Рестораны и кафе', website: 'https://vk.com/kompot' }), /страница во ВКонтакте/);
  assert.match(offer({ name: 'Магия', category: 'Салоны красоты', website: 'https://t.me/magia' }), /страница в Telegram/);
  assert.match(offer({ name: 'Борода', category: 'Барбершопы', website: 'taplink.cc/boroda' }), /вместо сайта у вас Taplink/);
});

test('мёртвый сайт и проблемы рабочего сайта называются конкретно', () => {
  assert.match(offer({ name: 'Империя', website: 'https://www.imperiyacentr.ru/', site_check: { status: 'dns' } }),
    /ваш сайт imperiyacentr\.ru не открывается — похоже, не продлён домен/);
  const weak = offer({ name: 'Мото', website: 'http://maximotto.com', site_check: { status: 'ok', https: false, mobile: false } });
  assert.match(weak, /нет мобильной версии, а ещё браузер помечает сайт как «Не защищено»/);
});

test('польза подбирается по сфере; «барбершоп» — не бар', () => {
  assert.match(offer({ name: 'Борода', category: 'Барбершопы', website: '' }), /прайс, фото работ мастеров/);
  assert.match(offer({ name: 'Хмель', category: 'Бары', website: '' }), /меню с ценами/);
  assert.match(offer({ name: 'Что-то', category: '', website: '' }), /услуги и цены, контакты/);
});

test('кавычки в названии не удваиваются; без подписи — без пустых строк и «undefined»', () => {
  const text = offer({ name: 'Кафе «Компот»', category: 'Рестораны и кафе', website: '' }, {});
  assert.match(text, /Нашёл Кафе «Компот» на карте/);
  assert.doesNotMatch(text, /undefined|null|««/);
  assert.match(text, /^Здравствуйте! Я делаю сайты/);
  assert.ok(!text.endsWith('\n'));
});

test('подробный вариант — для почты: список замечаний, «почему важно», «С уважением»', () => {
  const text = offer({ name: 'Мото', category: 'Автосервисы', website: 'http://maximotto.com', site_check: { status: 'ok', https: false, mobile: false } },
    SENDER, 'long');
  assert.match(text, /— Сайт неудобно открывать с телефона — нет мобильной версии;\n— Браузер помечает сайт как «Не защищено»\./);
  assert.match(text, /больше половины людей заходят с телефона/);
  assert.match(text, /С уважением,\nГригорий/);
});

test('подпись: сохраняется в базе, ссылка приводится к https://, лишнее игнорируется', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(getSettings(db), { sender_name: '', sender_contact: '', portfolio_url: '' });
  const result = saveSettings(db, { sender_name: ' Григорий ', portfolio_url: 'grisha-sites.ru', hacker: 'x' });
  assert.deepEqual(result.settings, { sender_name: 'Григорий', sender_contact: '', portfolio_url: 'https://grisha-sites.ru' });
  assert.equal(saveSettings(db, { portfolio_url: 'javascript:alert(1)' }).ok, false);
  assert.equal(getSettings(db).portfolio_url, 'https://grisha-sites.ru', 'ошибочное значение не сохранилось');
  db.close();
});

test('API подписи и «Написал» из карточки ставит напоминание, даже если поле даты пустое', async (t) => {
  const db = openDatabase(':memory:');
  const server = createServer({ db });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  let response = await fetch(`${base}/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender_name: 'Григорий' }),
  });
  assert.equal((await response.json()).settings.sender_name, 'Григорий');
  assert.equal((await (await fetch(`${base}/settings`)).json()).settings.sender_name, 'Григорий');

  // Карточка отправляет все поля формы, в том числе пустую дату — напоминание всё равно ставится.
  const company = addCompany(db, { name: 'Ромашка' }).company;
  const result = updateCompany(db, company.id, { name: 'Ромашка', status: 'contacted', next_contact_at: '' }, { now: NOW });
  assert.equal(result.company.next_contact_at, '2026-10-21');
});
