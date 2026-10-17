// Определяет, что за ссылка: собственный сайт компании, соцсеть, Taplink, карты или каталог.
// Это важно для «горячести»: «только страница ВК» или «только Taplink» — значит, сайта у компании нет.
// Файл общий для сервера и страницы, сеть не использует: смотрим только на сам адрес.
import { SOURCE_LABELS, normalizeUrl, parseMapLink } from './normalize.js';

/** Виды ссылок и как их называть человеку. */
export const LINK_KINDS = {
  site: 'Сайт',
  social: 'Соцсеть',
  linkpage: 'Визитка',
  map: 'Карты',
  directory: 'Каталог',
  short: 'Короткая ссылка',
  service: 'Служебная',
};

// Порядок важен: правила проверяются сверху вниз, первое подходящее побеждает.
const RULES = [
  // Мини-страницы «всё в одном» вместо сайта.
  { kind: 'linkpage', label: 'Taplink', domains: ['taplink.cc', 'taplink.ru', 'taplink.at', 'taplink.ws'] },
  { kind: 'linkpage', label: 'Hipolink', domains: ['hipolink.me', 'hipolink.net'] },
  { kind: 'linkpage', label: 'Linktree', domains: ['linktr.ee'] },
  { kind: 'linkpage', label: 'mssg.me', domains: ['mssg.me'] },
  { kind: 'linkpage', label: 'Lnk.Bio', domains: ['lnk.bio'] },
  { kind: 'linkpage', label: 'Bio.link', domains: ['bio.link'] },

  // Соцсети и мессенджеры.
  { kind: 'social', label: 'ВКонтакте', domains: ['vk.com', 'vk.ru', 'vkontakte.ru', 'vk.me'] },
  { kind: 'social', label: 'Одноклассники', domains: ['ok.ru', 'odnoklassniki.ru'] },
  { kind: 'social', label: 'Telegram', domains: ['t.me', 'telegram.me', 'telegram.dog'] },
  { kind: 'social', label: 'WhatsApp', domains: ['wa.me', 'whatsapp.com', 'wa.link'] },
  { kind: 'social', label: 'Viber', domains: ['viber.com', 'viber.click'] },
  { kind: 'social', label: 'MAX', domains: ['max.ru'] },
  { kind: 'social', label: 'Instagram', domains: ['instagram.com', 'instagr.am'] },
  { kind: 'social', label: 'Facebook', domains: ['facebook.com', 'fb.com', 'fb.me'] },
  { kind: 'social', label: 'YouTube', domains: ['youtube.com', 'youtu.be'] },
  { kind: 'social', label: 'RuTube', domains: ['rutube.ru'] },
  { kind: 'social', label: 'Дзен', domains: ['dzen.ru', 'zen.yandex.ru'] },
  { kind: 'social', label: 'TikTok', domains: ['tiktok.com'] },
  { kind: 'social', label: 'X (Twitter)', domains: ['twitter.com', 'x.com'] },
  { kind: 'social', label: 'Pinterest', domains: ['pinterest.com', 'pinterest.ru'] },

  // Каталоги, агрегаторы, маркетплейсы и онлайн-запись: страница компании есть, но это не её сайт.
  { kind: 'directory', label: 'Авито', domains: ['avito.ru'] },
  { kind: 'directory', label: 'Zoon', domains: ['zoon.ru'] },
  { kind: 'directory', label: 'Yell', domains: ['yell.ru'] },
  { kind: 'directory', label: 'Flamp', domains: ['flamp.ru'] },
  { kind: 'directory', label: 'Профи.ру', domains: ['profi.ru'] },
  { kind: 'directory', label: 'Яндекс Услуги', domains: ['uslugi.yandex.ru'] },
  { kind: 'directory', label: 'YCLIENTS', domains: ['yclients.com', 'yclients.ru'] },
  { kind: 'directory', label: 'DIKIDI', domains: ['dikidi.net', 'dikidi.ru', 'dikidi.app'] },
  { kind: 'directory', label: 'Booksy', domains: ['booksy.com'] },
  { kind: 'directory', label: 'Restoclub', domains: ['restoclub.ru'] },
  { kind: 'directory', label: 'Tripadvisor', domains: ['tripadvisor.ru', 'tripadvisor.com'] },
  { kind: 'directory', label: 'Яндекс Еда', domains: ['eda.yandex.ru', 'eda.yandex'] },
  { kind: 'directory', label: 'Delivery Club', domains: ['delivery-club.ru'] },
  { kind: 'directory', label: 'Купер', domains: ['kuper.ru'] },
  { kind: 'directory', label: 'Яндекс Маркет', domains: ['market.yandex.ru'] },
  { kind: 'directory', label: 'Ozon', domains: ['ozon.ru'] },
  { kind: 'directory', label: 'Wildberries', domains: ['wildberries.ru'] },
  { kind: 'directory', label: 'ПроДокторов', domains: ['prodoctorov.ru'] },
  { kind: 'directory', label: 'НаПоправку', domains: ['napopravku.ru'] },
  { kind: 'directory', label: 'СберЗдоровье', domains: ['sberhealth.ru'] },
  { kind: 'directory', label: 'Отзовик', domains: ['otzovik.com'] },
  { kind: 'directory', label: 'Auto.ru', domains: ['auto.ru'] },
  { kind: 'directory', label: 'Дром', domains: ['drom.ru'] },
  { kind: 'directory', label: 'HeadHunter', domains: ['hh.ru'] },

  // Сокращатели ссылок: куда ведут — не знаем (раскрывать их не ходим).
  { kind: 'short', label: 'Короткая ссылка', domains: ['clck.ru', 'vk.cc', 'bit.ly', 'goo.su', 'tinyurl.com', 'u.to', 'cutt.ly'] },
];

// Большие сервисы, которые точно не сайт компании (поиск, почта, госуслуги, справочники юрлиц).
const SERVICE_HOST = /(^|\.)(yandex\.[a-z.]+|ya\.ru|google\.[a-z.]+|goo\.gl|mail\.ru|gosuslugi\.ru|nalog\.ru|nalog\.gov\.ru|rusprofile\.ru|list-org\.com|apple\.com)$/;

/**
 * Вид ссылки: { kind, label }.
 *   'https://vk.com/romashka'          → { kind: 'social',   label: 'ВКонтакте' }
 *   'https://taplink.cc/romashka'      → { kind: 'linkpage', label: 'Taplink' }
 *   'https://2gis.ru/kazan/firm/7000…' → { kind: 'map',      label: '2ГИС' }
 *   'https://romashka-kafe.ru'         → { kind: 'site',     label: 'romashka-kafe.ru' }
 */
export function classifyLink(raw) {
  const href = normalizeUrl(raw);
  if (!href) return { kind: 'service', label: 'Не ссылка' };
  const url = new URL(href);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  const map = parseMapLink(href);
  if (map.source !== 'other') return { kind: 'map', label: SOURCE_LABELS[map.source] };
  if (isGoogleMaps(host, url.pathname)) return { kind: 'map', label: 'Google Карты' };

  for (const rule of RULES) {
    if (rule.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
      return { kind: rule.kind, label: rule.label };
    }
  }

  if (SERVICE_HOST.test(host)) return { kind: 'service', label: host };
  return { kind: 'site', label: decodeHost(href) };
}

/**
 * «Ключ» ссылки для сравнения: без https://, www и слэша в конце, без учёта регистра.
 * 'http://www.Romashka.ru/' и 'romashka.ru' → один ключ 'romashka.ru'. Для не-ссылок — ''.
 */
export function linkKey(raw) {
  const href = normalizeUrl(raw);
  if (!href) return '';
  const url = new URL(href);
  return (url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/+$/, '') + url.search).toLowerCase();
}

function isGoogleMaps(host, pathname) {
  return host === 'maps.app.goo.gl' ||
    /^maps\.google\./.test(host) ||
    (/^(google\.[a-z.]+|goo\.gl)$/.test(host) && pathname.startsWith('/maps'));
}

/** Имя сайта для показа: 'https://www.кафе.рф/menu' → 'кафе.рф' (без перевода в xn--…). */
function decodeHost(href) {
  return href.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#:]/)[0].toLowerCase();
}
