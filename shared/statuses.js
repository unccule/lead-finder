// Статусы работы с клиентом и даты контактов. Общий код для сервера и страницы.

/** Статусы по порядку воронки: от «нашёл» до «клиент» или «отказ». */
export const STATUSES = [
  { id: 'new', label: 'Новый' },
  { id: 'contacted', label: 'Написал' },
  { id: 'replied', label: 'Ответил' },
  { id: 'meeting', label: 'Встреча' },
  { id: 'client', label: 'Клиент' },
  { id: 'refused', label: 'Отказ' },
];
export const STATUS_LABELS = Object.fromEntries(STATUSES.map(({ id, label }) => [id, label]));

/** Через сколько дней напомнить связаться снова, если дата не указана (после «Написал» и т. п.). */
export const FOLLOW_UP_DAYS = 3;
/** Статусы, после которых связываться дальше не нужно — напоминаний нет. */
export const FINAL_STATUSES = new Set(['client', 'refused']);

export function isStatus(value) {
  return Object.hasOwn(STATUS_LABELS, value);
}

/** Сегодняшняя дата по часам компьютера: 'ГГГГ-ММ-ДД'. */
export function todayISO(now = new Date()) {
  return toISODate(now);
}

export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return toISODate(new Date(y, m - 1, d + days));
}

/**
 * Дата из поля формы → 'ГГГГ-ММ-ДД'. Принимает '2026-10-21' (поле-календарь) и '21.10.2026'.
 * Пусто → ''. Не дата → null.
 */
export function normalizeDate(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) ?? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (!match) return null;
  const [y, m, d] = text.includes('-') ? [match[1], match[2], match[3]] : [match[3], match[2], match[1]];
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  // 31.02 превратился бы в 3 марта — такие «даты» не принимаем.
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return null;
  return toISODate(date);
}

/** '2026-10-21' → '21.10.2026' */
export function formatDateRu(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * Когда связаться: { state, label } или null, если напоминать не о чем.
 *   state: 'overdue' (просрочено) | 'today' | 'later'
 */
export function contactReminder(company, today = todayISO()) {
  if (!company.next_contact_at || FINAL_STATUSES.has(company.status)) return null;
  if (company.next_contact_at < today) return { state: 'overdue', label: `просрочено: ${formatDateRu(company.next_contact_at)}` };
  if (company.next_contact_at === today) return { state: 'today', label: 'связаться сегодня' };
  return { state: 'later', label: `связаться ${formatDateRu(company.next_contact_at)}` };
}

function toISODate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
