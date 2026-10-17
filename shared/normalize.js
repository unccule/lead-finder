// Функции, которые приводят данные к одному виду.
// Этот файл подключают и сервер, и страница в браузере, поэтому здесь только чистый
// JavaScript: без модулей node:… и без обращения к странице.

/** Как показывать источник человеку. */
export const SOURCE_LABELS = {
  '2gis': '2ГИС',
  yandex: 'Яндекс Карты',
  other: 'Другое',
};

/**
 * Телефон → '+7XXXXXXXXXX'.
 * Возвращает '' для пустого поля и null, если номер распознать не удалось.
 *   '8 (916) 123-45-67'        → '+79161234567'
 *   '+7 495 123-45-67 доб. 12' → '+74951234567' (добавочный отбрасываем)
 */
export function normalizePhone(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '';

  const main = text.split(/доб|ext|#/i)[0].trim();
  const digits = main.replace(/\D/g, '');
  const hasPlus = main.startsWith('+');

  if (digits.length === 11 && digits.startsWith('7')) return '+' + digits;
  // «8» в начале — российская междугородняя восьмёрка. Но «+8…» — это уже не она.
  if (digits.length === 11 && digits.startsWith('8') && !hasPlus) return '+7' + digits.slice(1);
  if (digits.length === 10 && !hasPlus) return '+7' + digits;
  return null;
}

/**
 * Ссылка → адрес с http(s)://. Возвращает '' для пустого поля и null, если это не ссылка на сайт.
 *   'vk.com/romashka' → 'https://vk.com/romashka'
 * Другие схемы (javascript:, mailto:, file:) не пропускаем: такую «ссылку» опасно
 * показывать на странице — клик по javascript:… выполнил бы чужой код.
 */
export function normalizeUrl(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '';
  if (/\s/.test(text)) return null;

  let candidate = text;
  if (!/^https?:\/\//i.test(candidate)) {
    // «что-то:» в начале — это чужая схема. Исключение — «site.ru:8080» (после двоеточия цифры порта).
    if (/^[a-z][a-z\d+.-]*:(?!\d)/i.test(candidate)) return null;
    candidate = 'https://' + candidate.replace(/^\/+/, '');
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!url.hostname.includes('.') || url.hostname.endsWith('.')) return null;
  if (url.username || url.password) return null; // логин и пароль внутри ссылки не храним
  // Возвращаем текст как его ввели (только с добавленным https://), а не url.href:
  // href превратил бы «кафе.рф» в нечитаемое «xn--80aswg.xn--p1ai».
  return candidate;
}

// Домены 2ГИС и Яндекса в разных странах. Проверяем «конец» адреса целиком,
// чтобы «evil2gis.ru» или «2gis.ru.evil.com» не сошли за настоящий 2ГИС.
const DGIS_HOST = /(^|\.)2gis\.(ru|com|kz|kg|uz|by|ae|am|az|ge|cy|cz|it|cl)$/;
const YANDEX_HOST = /(^|\.)(yandex\.(ru|com|kz|by|uz|az|tj|tm|md|com\.tr|com\.am|com\.ge|ee|lt|lv|fr|co\.il)|ya\.ru)$/;

/**
 * Определяет источник по ссылке на карточку и достаёт ID организации, если он есть в самой ссылке.
 *   https://2gis.ru/kazan/firm/70000001012345678         → { source: '2gis',   sourceId: '70000001012345678' }
 *   https://yandex.ru/maps/org/romashka/1234567890/      → { source: 'yandex', sourceId: '1234567890' }
 *   https://yandex.ru/maps/43/kazan/?oid=1234567890&...  → { source: 'yandex', sourceId: '1234567890' }
 *   https://go.2gis.com/abc12                            → { source: '2gis',   sourceId: null }
 * Сеть не используется: короткие ссылки не раскрываем (на сайты карт программа не ходит),
 * поэтому у них просто нет ID.
 */
export function parseMapLink(raw) {
  const href = normalizeUrl(raw);
  if (!href) return { source: 'other', sourceId: null };

  const url = new URL(href);
  const host = url.hostname;

  if (DGIS_HOST.test(host)) {
    const match = url.pathname.match(/\/firm\/(\d+)/);
    return { source: '2gis', sourceId: match ? match[1] : null };
  }

  const isYandexMaps = YANDEX_HOST.test(host) &&
    (host.startsWith('maps.') || /^\/(maps|profile)(\/|$)/.test(url.pathname));
  if (isYandexMaps) {
    const match = url.pathname.match(/\/org\/(?:[^/]+\/)?(\d+)/);
    const oid = url.searchParams.get('oid') ?? '';
    const sourceId = match ? match[1] : /^\d+$/.test(oid) ? oid : null;
    return { source: 'yandex', sourceId };
  }

  return { source: 'other', sourceId: null };
}

/**
 * «Ключ» для сравнения названий и адресов: без регистра, кавычек, знаков и лишних пробелов, ё = е.
 *   'Кафе «Ромашка»' и 'кафе ромашка' → одинаковый ключ 'кафе ромашка'
 */
export function textKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
