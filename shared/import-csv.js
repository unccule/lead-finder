// Импорт списка компаний из файла CSV (в том числе сохранённого из Excel и нашего же экспорта).
// Работает в браузере: файл читается на твоём компьютере, на сервер уходят только данные компаний.
import { STATUSES } from './statuses.js';

/** Какие столбцы мы понимаем и как они могут называться в таблице. Всё остальное не загружается. */
const COLUMN_NAMES = {
  name: ['название', 'наименование', 'компания', 'организация', 'name', 'company', 'title'],
  category: ['сфера', 'категория', 'рубрика', 'вид деятельности', 'category', 'rubric'],
  city: ['город', 'city'],
  address: ['адрес', 'address'],
  phone: ['телефон', 'телефоны', 'рабочий телефон', 'phone', 'tel'],
  website: ['сайт', 'сайт или соцсеть', 'website', 'site', 'url'],
  other_links: ['другие ссылки', 'соцсети', 'соцсети и другие ссылки', 'social'],
  card_url: ['ссылка на карточку', 'карточка', 'ссылка', 'ссылка 2гис', 'card', 'link'],
  rating: ['рейтинг', 'rating'],
  reviews_count: ['отзывов', 'отзывы', 'число отзывов', 'кол-во отзывов', 'reviews'],
  note: ['заметка', 'заметки', 'комментарий', 'примечание', 'note', 'comment'],
  status: ['статус', 'status'],
  next_contact_at: ['следующий контакт', 'дата контакта', 'next contact'],
};
export const MAX_IMPORT_ROWS = 5000;

const STATUS_BY_LABEL = Object.fromEntries(STATUSES.flatMap(({ id, label }) => [[label.toLowerCase(), id], [id, id]]));

/**
 * Байты файла → текст. Excel в русской Windows часто сохраняет CSV в старой кодировке windows-1251,
 * поэтому сначала пробуем UTF-8, а если это не он — windows-1251.
 */
export function decodeFile(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

/**
 * Текст CSV → строки таблицы (массивы ячеек). Разделитель (; , или табуляция) определяется сам.
 * Понимает кавычки: "текст; с точкой с запятой", "кавычка "" внутри", переносы строк внутри кавычек.
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^﻿/, '');
  const delimiter = detectDelimiter(source);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ''));
}

/**
 * Строки таблицы → компании для загрузки.
 * Возвращает { companies: [{ ...поля, row }], columns: { поле: 'Заголовок' }, ignored: ['Заголовок', …], error }.
 */
export function rowsToCompanies(rows) {
  if (rows.length === 0) return { companies: [], columns: {}, ignored: [], error: 'Файл пустой' };
  const [header, ...data] = rows;
  const columns = {};
  const indexes = {};
  const ignored = [];
  header.forEach((title, index) => {
    const key = headerKey(title);
    const field = Object.keys(COLUMN_NAMES).find((name) => COLUMN_NAMES[name].includes(key));
    if (field && !(field in indexes)) {
      indexes[field] = index;
      columns[field] = title.trim();
    } else if (title.trim()) {
      ignored.push(title.trim());
    }
  });
  if (!('name' in indexes)) {
    return { companies: [], columns, ignored, error: 'Не нашёл столбец с названием компании («Название», «Компания» или «Организация»)' };
  }
  if (data.length > MAX_IMPORT_ROWS) {
    return { companies: [], columns, ignored, error: `Слишком много строк: ${data.length}. За один раз — не больше ${MAX_IMPORT_ROWS}.` };
  }

  const companies = data.map((cells, i) => {
    const company = { row: i + 2 }; // номер строки как в Excel: 1 — заголовок
    for (const [field, index] of Object.entries(indexes)) company[field] = cleanCell(cells[index] ?? '');
    if (company.phone) company.phone = firstPhone(company.phone);
    if (company.status) company.status = STATUS_BY_LABEL[company.status.toLowerCase()] ?? '';
    return company;
  });
  return { companies, columns, ignored, error: '' };
}

function detectDelimiter(text) {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ';';
}

function headerKey(title) {
  return String(title).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .replace(/^ссылка 2 гис$/, 'ссылка 2гис');
}

/** Убираем «защитные» приёмы из нашего экспорта: ="+7…" и апостроф перед «=», «+», «-», «@». */
function cleanCell(value) {
  let text = String(value).trim();
  const formula = /^="(.*)"$/.exec(text);
  if (formula) text = formula[1];
  if (/^'[=+\-@]/.test(text)) text = text.slice(1);
  return text;
}

/** «8 918 111-22-33, 8 900 000-00-00» → первый номер. */
function firstPhone(value) {
  const parts = value.split(/[;,]|\s{2,}/).map((part) => part.trim()).filter(Boolean);
  return parts.find((part) => part.replace(/\D/g, '').length >= 10) ?? value;
}
