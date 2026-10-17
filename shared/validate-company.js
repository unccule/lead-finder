// Проверка данных компании. Один и тот же код работает:
//  • в браузере — чтобы сразу подсказать, что исправить в форме;
//  • на сервере — чтобы ничего плохого не попало в базу, даже если запрос пришёл не из нашей формы.
import { normalizePhone, normalizeUrl, parseMapLink } from './normalize.js';

/** Поля формы (в порядке показа) и их максимальная длина. */
export const FIELDS = {
  name: 200,
  category: 100,
  city: 100,
  card_url: 2000,
  address: 300,
  phone: 60,
  website: 2000,
  rating: 10,
  reviews_count: 15,
  other_links: 4000,
  note: 2000,
};

const MAX_OTHER_LINKS = 10;

export const PHONE_ERROR =
  'Не получилось распознать номер. Нужен российский номер: +7 и 10 цифр, например +7 916 123-45-67. ' +
  'Если номеров несколько — оставь один.';

/**
 * Проверяет и «чистит» данные компании. Возвращает { ok, errors, data }:
 *   errors — { поле: 'понятное сообщение' } (пустой объект, если всё хорошо);
 *   data   — нормализованные значения, готовые к сохранению (null, если есть ошибки).
 * Берём только известные поля: всё лишнее в запросе (id, created_at…) просто игнорируется.
 */
export function validateCompany(input) {
  const raw = input !== null && typeof input === 'object' ? input : {};
  const errors = {};
  const values = {};

  for (const [field, maxLength] of Object.entries(FIELDS)) {
    const value = raw[field];
    values[field] = '';
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number') {
      errors[field] = 'Неверный формат значения';
      continue;
    }
    values[field] = String(value).trim();
    if (values[field].length > maxLength) {
      errors[field] = `Слишком длинно: максимум ${maxLength} символов`;
    }
  }

  if (!values.name && !errors.name) errors.name = 'Укажи название компании';

  const phone = normalizePhone(values.phone);
  if (phone === null) errors.phone ??= PHONE_ERROR;

  const cardUrl = normalizeUrl(values.card_url);
  if (cardUrl === null) {
    errors.card_url ??= 'Это не похоже на ссылку. Скопируй адрес карточки из браузера, например https://2gis.ru/…/firm/…';
  }

  const website = normalizeUrl(values.website);
  if (website === null) {
    errors.website ??= 'Это не похоже на адрес сайта. Пример: romashka-cafe.ru или vk.com/romashka';
  }

  // Соцсети и другие ссылки: по одной на строку (подойдут и пробелы между ними).
  const otherLinks = [];
  for (const token of values.other_links.split(/\s+/).filter(Boolean)) {
    const url = normalizeUrl(token);
    if (!url) {
      errors.other_links ??= `«${token.slice(0, 60)}» не похоже на ссылку. Пиши по одной ссылке на строку.`;
    } else if (url !== website && !otherLinks.includes(url)) {
      otherLinks.push(url);
    }
  }
  if (otherLinks.length > MAX_OTHER_LINKS) errors.other_links ??= `Не больше ${MAX_OTHER_LINKS} ссылок`;

  let rating = null;
  if (values.rating) {
    // Принимаем и «4,7», и «4.7» — на картах пишут с запятой.
    rating = /^\d(?:[.,]\d{1,2})?$/.test(values.rating) ? Number(values.rating.replace(',', '.')) : NaN;
    if (!(rating >= 0 && rating <= 5)) {
      errors.rating ??= 'Рейтинг — число от 0 до 5, например 4,7';
      rating = null;
    }
  }

  let reviewsCount = null;
  if (values.reviews_count) {
    const digits = values.reviews_count.replace(/[\s ]/g, ''); // «1 234» → «1234»
    if (/^\d{1,9}$/.test(digits)) reviewsCount = Number(digits);
    else errors.reviews_count ??= 'Число отзывов — целое число, например 120';
  }

  const ok = Object.keys(errors).length === 0;
  if (!ok) return { ok, errors, data: null };

  const { source, sourceId } = parseMapLink(cardUrl);
  return {
    ok,
    errors,
    data: {
      name: values.name,
      category: values.category,
      city: values.city,
      address: values.address,
      card_url: cardUrl,
      source,
      source_id: sourceId,
      phone,
      website,
      other_links: otherLinks.join('\n'),
      rating,
      reviews_count: reviewsCount,
      note: values.note,
    },
  };
}
