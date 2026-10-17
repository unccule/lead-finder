// Работа с компаниями в базе: список, добавление, поиск дублей.
import { validateCompany } from '../shared/validate-company.js';
import { SOURCE_LABELS, textKey } from '../shared/normalize.js';
import { classifyLink } from '../shared/link-kinds.js';

// Колонки, которые отдаём наружу. Служебные name_key / address_key остаются внутри.
const PUBLIC_COLUMNS = `id, name, category, city, address, card_url, source, source_id,
  phone, website, other_links, rating, reviews_count, note, site_check, site_checked_at, created_at, updated_at`;

/** Все компании, новые сверху. */
export function listCompanies(db) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM companies ORDER BY id DESC`).all().map(toPlain);
}

export function getCompany(db, id) {
  const row = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM companies WHERE id = ?`).get(id);
  return row ? toPlain(row) : null;
}

/**
 * Добавляет компанию. Возвращает один из трёх вариантов:
 *   { ok: true, company }                                 — сохранено
 *   { ok: false, reason: 'invalid', errors }              — данные не прошли проверку
 *   { ok: false, reason: 'duplicate', message, existing } — такая компания уже есть
 */
export function addCompany(db, input) {
  // Сервер проверяет данные сам, даже если браузер их уже проверил:
  // запрос можно отправить и в обход нашей страницы.
  const check = validateCompany(input);
  if (!check.ok) return { ok: false, reason: 'invalid', errors: check.errors };

  const data = withKeys(check.data);
  const duplicate = findDuplicate(db, data);
  if (duplicate) {
    return {
      ok: false,
      reason: 'duplicate',
      existing: duplicate.company,
      message: `Такая компания уже есть в базе: ${duplicate.company.name} (${duplicate.why}). Второй раз не сохраняю.`,
    };
  }

  const now = new Date().toISOString();
  // $name, $phone… — «места для значений». Сами значения передаём отдельно, а не склеиваем
  // в текст запроса: так кавычки и прочие символы из карточки не смогут испортить SQL.
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO companies (name, category, city, address, card_url, source, source_id, phone, website,
                           other_links, rating, reviews_count, note, name_key, address_key, created_at, updated_at)
    VALUES ($name, $category, $city, $address, $card_url, $source, $source_id, $phone, $website,
            $other_links, $rating, $reviews_count, $note, $name_key, $address_key, $now, $now)
  `).run({ ...data, now });

  return { ok: true, company: getCompany(db, lastInsertRowid) };
}

/**
 * Добавляет много компаний сразу (например, найденных автопоиском).
 * Каждая проходит ту же проверку и ту же защиту от дублей, что и форма.
 * Всё внутри одной транзакции: так в сотни раз быстрее, чем сохранять по одной.
 */
export function addCompanies(db, inputs) {
  const summary = { added: 0, duplicates: 0, invalid: 0 };
  db.exec('BEGIN');
  try {
    for (const input of inputs) {
      const result = addCompany(db, input);
      if (result.ok) summary.added += 1;
      else if (result.reason === 'duplicate') summary.duplicates += 1;
      else summary.invalid += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return summary;
}

/** Есть ли уже такая компания в базе (по тем же правилам дублей)? Возвращает её или null. */
export function findExisting(db, input) {
  const check = validateCompany(input);
  if (!check.ok) return null;
  return findDuplicate(db, withKeys(check.data))?.company ?? null;
}

/** Компании, у которых есть собственный сайт для проверки. scope: 'new' — ещё не проверенные, 'all' — все. */
export function companiesToCheck(db, scope = 'new') {
  const where = scope === 'all' ? "website != ''" : "website != '' AND site_checked_at IS NULL";
  return db.prepare(`SELECT id, website FROM companies WHERE ${where} ORDER BY id`).all()
    .map(toPlain)
    .filter((company) => classifyLink(company.website).kind === 'site');
}

/** Сохраняет результат проверки сайта. */
export function saveSiteCheck(db, id, result) {
  const now = new Date().toISOString();
  db.prepare('UPDATE companies SET site_check = ?, site_checked_at = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(result), result.checked_at ?? now, now, id);
}

function withKeys(data) {
  return { ...data, name_key: textKey(data.name), address_key: textKey(data.address) };
}

/**
 * Ищет уже сохранённую такую же компанию. Правила по порядку:
 *  1. в ссылке есть ID организации → та же карточка 2ГИС или Яндекса;
 *  2. есть телефон → то же название + тот же телефон
 *     (так ловится и та же компания, добавленная из другой карты);
 *  3. телефона нет → то же название + тот же адрес, а если нет и адреса — только название.
 * Название и адрес сравниваем по «ключу» (textKey): без регистра, кавычек и лишних пробелов.
 */
function findDuplicate(db, data) {
  const find = (where, ...params) => {
    const row = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM companies WHERE ${where} ORDER BY id LIMIT 1`).get(...params);
    return row ? toPlain(row) : null;
  };

  if (data.source_id) {
    const company = find('source = ? AND source_id = ?', data.source, data.source_id);
    if (company) {
      return { company, why: `совпадает ID карточки в ${SOURCE_LABELS[data.source]}: ${data.source_id}` };
    }
  }

  if (data.phone) {
    const company = find('name_key = ? AND phone = ?', data.name_key, data.phone);
    return company ? { company, why: `совпадают название и телефон ${data.phone}` } : null;
  }

  if (data.address_key) {
    const company = find('name_key = ? AND address_key = ?', data.name_key, data.address_key);
    return company ? { company, why: 'совпадают название и адрес' } : null;
  }

  const company = find('name_key = ?', data.name_key);
  return company ? { company, why: 'совпадает название (телефон и адрес не указаны)' } : null;
}

// node:sqlite отдаёт строки как «голые» объекты без прототипа — превращаем в обычные.
// Результат проверки сайта хранится текстом JSON — сразу превращаем его обратно в объект.
function toPlain(row) {
  const company = { ...row };
  if ('site_check' in company) company.site_check = parseJson(company.site_check);
  return company;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
