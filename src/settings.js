// Настройки программы. Пока это только твоя подпись для предложений: имя, контакты, портфолио.
import { normalizeUrl } from '../shared/normalize.js';

/** Какие настройки есть и их максимальная длина. Всё остальное в запросе игнорируется. */
export const SETTING_KEYS = { sender_name: 100, sender_contact: 200, portfolio_url: 500 };

export function getSettings(db) {
  const settings = Object.fromEntries(Object.keys(SETTING_KEYS).map((key) => [key, '']));
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    if (Object.hasOwn(SETTING_KEYS, key)) settings[key] = value;
  }
  return settings;
}

/** Сохраняет настройки. Возвращает { ok: true, settings } или { ok: false, errors }. */
export function saveSettings(db, input) {
  const raw = input !== null && typeof input === 'object' ? input : {};
  const values = {};
  const errors = {};
  for (const [key, maxLength] of Object.entries(SETTING_KEYS)) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = String(raw[key] ?? '').trim();
    if (value.length > maxLength) errors[key] = `Слишком длинно: максимум ${maxLength} символов`;
    values[key] = value;
  }
  if (values.portfolio_url) {
    const url = normalizeUrl(values.portfolio_url);
    if (url === null) errors.portfolio_url = 'Это не похоже на ссылку. Пример: mysite.ru или t.me/mychannel';
    else values.portfolio_url = url;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  for (const [key, value] of Object.entries(values)) upsert.run(key, value);
  return { ok: true, settings: getSettings(db) };
}
