// Экспорт списка компаний в CSV для Excel.
//
// Формат, который русский Excel открывает двойным кликом без мастера импорта:
//  • UTF-8 с BOM (невидимый символ в начале) — иначе кириллица превратится в «кракозябры»;
//  • разделитель «;» — в русском Excel запятая занята под дробные числа;
//  • строки разделены CRLF, как принято в Windows.
import { SOURCE_LABELS } from './normalize.js';
import { STATUS_LABELS, formatDateRu, todayISO } from './statuses.js';

const BOM = '﻿';

/** Столбцы: [заголовок, как получить значение, особый вид]. assessment — результат assessCompany. */
const COLUMNS = [
  ['Горячесть', (c, a) => a.score],
  ['Уровень', (c, a) => a.level.label],
  // Баллы в конце («нет сайта (+60)»): ячейка, начинающаяся с «+», выглядела бы для Excel как формула.
  ['Почему', (c, a) => a.reasons.filter((r) => r.points > 0).map((r) => `${r.text} (+${r.points})`).join('; ')],
  ['Статус', (c) => STATUS_LABELS[c.status] ?? ''],
  ['Следующий контакт', (c) => formatDateRu(c.next_contact_at)],
  ['Название', (c) => c.name],
  ['Сфера', (c) => c.category],
  ['Город', (c) => c.city],
  ['Адрес', (c) => c.address],
  ['Телефон', (c) => c.phone, 'phone'],
  ['Сайт или соцсеть', (c) => c.website],
  ['Другие ссылки', (c) => String(c.other_links ?? '').split('\n').filter(Boolean).join(' ')],
  ['Состояние сайта', (c, a) => a.site.label],
  ['Ссылка на карточку', (c) => c.card_url],
  ['Источник', (c) => SOURCE_LABELS[c.source] ?? ''],
  ['Рейтинг', (c) => (c.rating === null || c.rating === undefined ? '' : String(c.rating).replace('.', ','))],
  ['Отзывов', (c) => c.reviews_count ?? ''],
  ['Заметка', (c) => c.note],
  ['Добавлена', (c) => (c.created_at ? formatDateRu(todayISO(new Date(c.created_at))) : '')],
];

/**
 * companies — компании в нужном порядке, assessments — Map(id → assessCompany(компания)).
 * Возвращает готовый текст файла.
 */
export function companiesToCsv(companies, assessments) {
  const rows = [
    COLUMNS.map(([header]) => csvCell(header)),
    ...companies.map((company) => COLUMNS.map(([, get, kind]) => csvCell(get(company, assessments.get(company.id)), kind))),
  ];
  return BOM + rows.map((cells) => cells.join(';')).join('\r\n') + '\r\n';
}

/** Имя файла: lead-finder-2026-10-18.csv */
export function csvFileName(now = new Date()) {
  return `lead-finder-${todayISO(now)}.csv`;
}

function csvCell(value, kind) {
  let text = value === null || value === undefined ? '' : String(value);
  // Телефон как формула ="+79161234567": Excel покажет его текстом и не потеряет «+»
  // (иначе он превратит номер в число 79161234567 или даже в 7,92E+10).
  if (kind === 'phone' && /^\+\d+$/.test(text)) text = `="${text}"`;
  // Защита от «формул-ловушек»: текст из карточки, начинающийся с = + - @, Excel принял бы за формулу.
  else if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  // Если внутри есть ; кавычки или перенос строки — берём значение в кавычки, а кавычки удваиваем.
  if (/[;"\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}
