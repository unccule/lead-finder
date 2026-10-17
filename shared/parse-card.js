// Разбор вставленного текста карточки: ищем телефоны и ссылки и решаем, что куда подставить.
//
// Всё происходит прямо в браузере, без сети. Сам текст никуда не отправляется и не сохраняется:
// в нём могут быть отзывы с именами людей, а такие данные мы не храним.
import { normalizePhone, normalizeUrl, parseMapLink } from './normalize.js';
import { classifyLink, linkKey } from './link-kinds.js';

const MAX_TEXT = 200_000; // защита от случайной вставки огромного текста
const MAX_LINKS = 30;
const MAX_OTHER_LINKS = 10;

// Для поля «Сайт или соцсеть» свой сайт важнее визитки, визитка — соцсети, соцсеть — каталога.
const WEBSITE_PRIORITY = ['site', 'linkpage', 'social', 'directory'];

/**
 * Разбирает текст карточки (и, если есть, HTML из буфера обмена — там видны адреса у иконок соцсетей).
 * Возвращает:
 *   phones      — найденные телефоны в виде +7XXXXXXXXXX, по порядку появления;
 *   links       — [{ url, kind, label, sourceId }] — найденные ссылки с видом (см. link-kinds.js);
 *   phoneHidden — true, если похоже, что телефон в карточке скрыт («Показать телефон», «+7 843 200-…»);
 *   fill        — что подставить в форму: { phone, website, other_links: [...], card_url }.
 */
export function parseCardText(text, { html = '' } = {}) {
  const source = String(text ?? '').slice(0, MAX_TEXT);
  const hrefs = extractHrefs(String(html ?? '').slice(0, MAX_TEXT * 5));

  const phones = unique([
    ...findPhones(source),
    ...hrefs.filter((href) => /^tel:/i.test(href)).map((href) => normalizePhone(safeDecode(href.slice(4)))),
  ].filter(Boolean));

  const links = collectLinks([...hrefs.filter((href) => !/^tel:/i.test(href)), ...findUrls(source)]);

  return {
    phones,
    links,
    phoneHidden: phones.length === 0 && looksLikeHiddenPhone(source),
    fill: pickFields(phones, links),
  };
}

// ---------- Телефоны ----------

// Кусок текста из цифр и «телефонных» разделителей: пробелы, дефисы и тире всех видов, скобки.
// ‒ — «цифровое тире», им 2ГИС разделяет цифры номера.
const PHONE_RUN = /\+?\d[\d    ()\-‐-―]{8,24}\d/g;
// Слова, после которых идёт не телефон, а реквизиты: ИНН 1655123456 — не номер.
const REQUISITES_BEFORE = /(ИНН|ОГРНИП|ОГРН|КПП|БИК|ОКПО|ОКВЭД|р\/с|к\/с|сч[её]т)\D{0,5}$/i;

function findPhones(text) {
  const phones = [];
  for (const match of text.matchAll(PHONE_RUN)) {
    const raw = match[0];
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    // Цифры внутри ссылки или слова (…/firm/7000…, oid=8123…) — не телефон.
    if (/[\p{L}\p{N}/=?&_.%#-]$/u.test(before)) continue;
    if (REQUISITES_BEFORE.test(before)) continue;
    // Голые 10 цифр подряд без разделителей — скорее ИНН организации, чем телефон.
    if (/^\d{10}$/.test(raw)) continue;
    const phone = normalizePhone(raw);
    if (phone) phones.push(phone);
  }
  return phones;
}

function looksLikeHiddenPhone(text) {
  return /показать (телефон|номер)/i.test(text) ||
    /(\+7|\b8)[\s (]*\d{3}[)\s ]*[\d\s \-‐-―]{0,6}(…|\.\.\.)/.test(text);
}

// ---------- Ссылки ----------

// Адрес с http(s):// — или «голый» домен вроде romashka.ru, vk.com/romashka, кафе.рф.
// Список окончаний домена нужен, чтобы «ул.Ленина» или «т.д.» не приняли за сайт.
const URL_IN_TEXT = new RegExp(
  String.raw`https?:\/\/[^\s<>"'«»]+` + '|' +
  String.raw`(?<![\p{L}\p{N}@._\/-])(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+` +
  String.raw`(?:рф|ru|su|com|net|org|info|biz|pro|me|cc|io|co|ee|online|site|store|shop|club|top|ws|by|kz|uz|ua|app|link|tech|space|website|moscow|life|bio|ai|tv|xyz)` +
  String.raw`(?![\p{L}\p{N}-])(?:\/[^\s<>"'«»]*)?`,
  'giu',
);

function findUrls(text) {
  // Точку, запятую или скобку в конце предложения от адреса отрезаем: «сайт romashka.ru.»
  return [...text.matchAll(URL_IN_TEXT)].map((match) => match[0].replace(/[.,;:!?)\]»"']+$/, ''));
}

/** Достаёт значения href="…" из HTML буфера обмена. Без разбора страницы и без загрузки чего-либо. */
function extractHrefs(html) {
  const hrefs = [];
  for (const match of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = decodeEntities((match[1] ?? match[2] ?? match[3] ?? '').trim());
    if (/^tel:/i.test(value)) hrefs.push(value);
    else if (/^https?:\/\//i.test(value)) hrefs.push(value);
    else if (value.startsWith('//')) hrefs.push(`https:${value}`);
    // Относительные ссылки (/kazan/firm/…), mailto:, javascript: — пропускаем.
  }
  return hrefs;
}

function collectLinks(candidates) {
  const links = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const url = normalizeUrl(unwrapRedirect(candidate));
    if (!url || /\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?)(\?|#|$)/i.test(url)) continue;

    const key = linkKey(url);
    if (seen.has(key)) continue;
    seen.add(key);

    const { kind, label } = classifyLink(url);
    const { sourceId } = parseMapLink(url);
    // Ссылки на карты без ID организации (профили авторов отзывов, поиск) и служебные — не показываем.
    if (kind === 'service' || (kind === 'map' && !sourceId)) continue;

    links.push({ url, kind, label, sourceId: kind === 'map' ? sourceId : null });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

// Карты и соцсети иногда «заворачивают» внешнюю ссылку в свою: link.2gis.ru/…?http://romashka.ru,
// vk.com/away.php?to=… Достаём настоящий адрес прямо из текста ссылки, никуда не заходя.
const REDIRECT_HOST = /(^|\.)(2gis\.[a-z.]+|yandex\.[a-z.]+|vk\.com|instagram\.com|facebook\.com)$/i;

function unwrapRedirect(raw) {
  const href = normalizeUrl(raw);
  if (!href) return raw;
  const url = new URL(href);
  if (!REDIRECT_HOST.test(url.hostname)) return raw;

  const query = safeDecode(url.search.slice(1));
  if (/^https?:\/\//i.test(query)) return query;
  for (const value of url.searchParams.values()) {
    if (/^https?:\/\//i.test(value)) return value;
  }
  return raw;
}

// ---------- Что подставить в форму ----------

/**
 * Из списка ссылок выбирает основную («Сайт или соцсеть») и остальные («Соцсети и другие ссылки»).
 * Используется и быстрой вставкой, и автопоиском. Ссылки на карты и служебные сюда не попадают.
 */
export function pickLinks(urls) {
  const webLinks = collectLinks(urls)
    .filter((link) => WEBSITE_PRIORITY.includes(link.kind))
    .sort((a, b) => WEBSITE_PRIORITY.indexOf(a.kind) - WEBSITE_PRIORITY.indexOf(b.kind));
  return {
    website: webLinks[0]?.url ?? '',
    other_links: webLinks.slice(1, 1 + MAX_OTHER_LINKS).map((link) => link.url),
  };
}

function pickFields(phones, links) {
  const fill = {};
  if (phones.length > 0) fill.phone = phones[0];

  const { website, other_links: otherLinks } = pickLinks(links.map((link) => link.url));
  if (website) {
    fill.website = website;
    fill.other_links = otherLinks;
  }

  // Ссылку на карточку подставляем, только если организация одна. Если в тексте попались
  // «похожие места» с другими ID — выбирать будешь ты.
  const cards = links.filter((link) => link.kind === 'map' && link.sourceId);
  if (unique(cards.map((link) => link.sourceId)).length === 1) fill.card_url = cards[0].url;

  return fill;
}

// ---------- Мелкие помощники ----------

function unique(values) {
  return [...new Set(values)];
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeEntities(value) {
  const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', '#39': "'", '#x27': "'", '#x2f': '/', '#47': '/' };
  return value.replace(/&(#?\w+);/g, (all, name) => entities[name.toLowerCase()] ?? all);
}
