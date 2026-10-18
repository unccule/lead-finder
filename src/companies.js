// Работа с компаниями в базе: список, добавление, изменение, поиск дублей.
import { FIELDS, validateCompany } from '../shared/validate-company.js';
import { SOURCE_LABELS, textKey } from '../shared/normalize.js';
import { classifyLink, linkKey } from '../shared/link-kinds.js';
import { FOLLOW_UP_DAYS, STATUS_LABELS, addDays, isStatus, normalizeDate, todayISO } from '../shared/statuses.js';

// Колонки, которые отдаём наружу. Служебные name_key / address_key остаются внутри.
const PUBLIC_COLUMNS = `id, name, category, city, address, card_url, source, source_id,
  phone, website, other_links, rating, reviews_count, note, site_check, site_checked_at,
  status, next_contact_at, status_changed_at, created_at, updated_at`;

// После этих статусов, если дата следующего контакта не указана, ставим её сами (+3 дня).
const FOLLOW_UP_STATUSES = new Set(['contacted', 'replied', 'meeting']);

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
 * Изменяет компанию. changes — только то, что поменялось: { status: 'contacted' } или все поля формы.
 * Возвращает те же варианты, что addCompany, плюс { ok: false, reason: 'not_found' }.
 *
 * Правила:
 *  • данные проверяются так же, как при добавлении, и не должны совпасть с ДРУГОЙ компанией;
 *  • смена статуса записывается в историю;
 *  • «Написал / Ответил / Встреча» без даты следующего контакта → дата ставится сама: сегодня + 3 дня;
 *  • «Отказ» → дата следующего контакта убирается (напоминать не о чем);
 *  • поменялся сайт → старая проверка сайта сбрасывается.
 */
export function updateCompany(db, id, changes, { now = new Date() } = {}) {
  const current = getCompany(db, id);
  if (!current) return { ok: false, reason: 'not_found' };
  const input = changes !== null && typeof changes === 'object' ? changes : {};

  // Берём текущие значения и накладываем изменения — так можно прислать одно поле.
  const merged = {};
  for (const field of Object.keys(FIELDS)) {
    merged[field] = Object.hasOwn(input, field) ? input[field] : (current[field] ?? '');
  }
  const check = validateCompany(merged);
  const errors = { ...check.errors };

  const status = Object.hasOwn(input, 'status') ? input.status : current.status;
  if (!isStatus(status)) errors.status = 'Неизвестный статус';

  let nextContact = Object.hasOwn(input, 'next_contact_at') ? normalizeDate(input.next_contact_at) : (current.next_contact_at ?? '');
  if (nextContact === null) errors.next_contact_at = 'Дата в виде ДД.ММ.ГГГГ';
  if (Object.keys(errors).length > 0) return { ok: false, reason: 'invalid', errors };

  const statusChanged = status !== current.status;
  if (statusChanged && FOLLOW_UP_STATUSES.has(status) && !nextContact) {
    nextContact = addDays(todayISO(now), FOLLOW_UP_DAYS);
  }
  if (statusChanged && status === 'refused') nextContact = '';

  const data = withKeys(check.data);
  const duplicate = findDuplicate(db, data, { excludeId: id });
  if (duplicate) {
    return {
      ok: false,
      reason: 'duplicate',
      existing: duplicate.company,
      message: `Такая компания уже есть в базе: ${duplicate.company.name} (${duplicate.why}). Изменения не сохранены.`,
    };
  }

  const stamp = now.toISOString();
  const siteChanged = linkKey(data.website) !== linkKey(current.website);
  // SAVEPOINT вместо BEGIN: так изменение можно делать и само по себе, и внутри импорта,
  // который уже открыл свою транзакцию (BEGIN внутри BEGIN SQLite не разрешает).
  db.exec('SAVEPOINT update_company');
  try {
    db.prepare(`
      UPDATE companies SET
        name = $name, category = $category, city = $city, address = $address, card_url = $card_url,
        source = $source, source_id = $source_id, phone = $phone, website = $website, other_links = $other_links,
        rating = $rating, reviews_count = $reviews_count, note = $note, name_key = $name_key, address_key = $address_key,
        status = $status, next_contact_at = $next_contact_at,
        status_changed_at = CASE WHEN $status_changed THEN $stamp ELSE status_changed_at END,
        site_check = CASE WHEN $site_changed THEN NULL ELSE site_check END,
        site_checked_at = CASE WHEN $site_changed THEN NULL ELSE site_checked_at END,
        updated_at = $stamp
      WHERE id = $id
    `).run({
      ...data, id, status, stamp,
      next_contact_at: nextContact || null,
      status_changed: statusChanged ? 1 : 0,
      site_changed: siteChanged ? 1 : 0,
    });
    if (statusChanged) {
      db.prepare('INSERT INTO status_history (company_id, status, changed_at) VALUES (?, ?, ?)').run(id, status, stamp);
    }
    db.exec('RELEASE update_company');
  } catch (error) {
    db.exec('ROLLBACK TO update_company');
    db.exec('RELEASE update_company');
    throw error;
  }
  return { ok: true, company: getCompany(db, id) };
}

/** История статусов компании: [{ status, label, changed_at }], старые сверху. */
export function getStatusHistory(db, id) {
  return db.prepare('SELECT status, changed_at FROM status_history WHERE company_id = ? ORDER BY id').all(id)
    .map((row) => ({ status: row.status, label: STATUS_LABELS[row.status] ?? row.status, changed_at: row.changed_at }));
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

/**
 * Импорт строк из файла (shared/import-csv.js). Каждая строка — как заполненная форма:
 * та же проверка и защита от дублей. Если в файле есть статус и дата контакта (наш экспорт) —
 * они тоже восстанавливаются. Возвращает { added, duplicates, invalid, problems: [{ row, error }] }.
 */
export function importCompanies(db, rows, { now = new Date() } = {}) {
  const summary = { added: 0, duplicates: 0, invalid: 0, problems: [] };
  const note = (row, error) => {
    if (summary.problems.length < 20) summary.problems.push({ row, error });
  };
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const input = row !== null && typeof row === 'object' ? row : {};
      const result = addCompany(db, input);
      if (result.reason === 'duplicate') {
        summary.duplicates += 1;
        continue;
      }
      if (!result.ok) {
        summary.invalid += 1;
        note(input.row, Object.values(result.errors)[0]);
        continue;
      }
      summary.added += 1;
      if (isStatus(input.status) && (input.status !== 'new' || input.next_contact_at)) {
        const status = updateCompany(db, result.company.id,
          { status: input.status, ...(input.next_contact_at ? { next_contact_at: input.next_contact_at } : {}) }, { now });
        if (!status.ok) note(input.row, 'компания добавлена, но статус или дата контакта не распознаны');
      }
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

/** Удалял ли ты такую компанию выборочно (список «не предлагать снова»)? */
export function isExcluded(db, input) {
  const check = validateCompany(input);
  if (!check.ok) return false;
  return findDuplicate(db, withKeys(check.data), { table: 'excluded', columns: 'id, name' }) !== null;
}

/**
 * Выборочное удаление. Удалённые запоминаются в списке «не предлагать снова»,
 * чтобы автопоиск не добавил их обратно. Возвращает { deleted }.
 */
export function deleteCompanies(db, ids) {
  const select = db.prepare('SELECT name, source, source_id, phone, name_key, address_key FROM companies WHERE id = ?');
  const remember = db.prepare(`INSERT INTO excluded (name, source, source_id, phone, name_key, address_key, excluded_at)
    VALUES ($name, $source, $source_id, $phone, $name_key, $address_key, $now)`);
  const remove = db.prepare('DELETE FROM companies WHERE id = ?');
  const now = new Date().toISOString();

  let deleted = 0;
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const company = select.get(id);
      if (!company) continue; // уже удалена (например, в другом окне)
      remember.run({ ...company, now });
      remove.run(id);
      deleted += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { deleted };
}

/** Полная очистка: все компании и список «не предлагать снова» — начинаешь с нуля. Возвращает { deleted }. */
export function clearCompanies(db) {
  db.exec('BEGIN');
  try {
    const { changes } = db.prepare('DELETE FROM companies').run();
    db.prepare('DELETE FROM excluded').run();
    db.exec('COMMIT');
    return { deleted: Number(changes) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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
 * table/columns — где искать: в компаниях или в списке «не предлагать снова» (те же правила).
 */
function findDuplicate(db, data, { table = 'companies', columns = PUBLIC_COLUMNS, excludeId = 0 } = {}) {
  // excludeId — при изменении компании она не должна считаться «дублем» самой себя.
  const find = (where, ...params) => {
    const row = db.prepare(`SELECT ${columns} FROM ${table} WHERE (${where}) AND id != ? ORDER BY id LIMIT 1`)
      .get(...params, excludeId);
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
