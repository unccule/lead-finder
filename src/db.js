// Открытие базы данных и обновление её структуры (миграции).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

/**
 * Открывает (или создаёт) файл базы и выполняет недостающие миграции.
 * file = ':memory:' — временная база в памяти (используется в тестах).
 */
export function openDatabase(file, { migrations = MIGRATIONS } = {}) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    // Если базу в этот момент пишет другая копия программы (сайт и приложение открыты одновременно),
    // подождать до 5 секунд, а не сразу падать с ошибкой «database is locked».
    db.exec('PRAGMA busy_timeout = 5000');
    migrate(db, file, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function migrate(db, file, migrations) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  const latest = Math.max(0, ...migrations.map((m) => m.version));
  if (current > latest) {
    throw new Error(`База создана более новой версией программы (версия базы ${current}, программа знает до ${latest}).`);
  }

  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;

  // В базе уже есть данные старой версии — сначала делаем резервную копию.
  if (current > 0 && file !== ':memory:') {
    const backup = backupDatabase(db, file, `v${current}`);
    console.log(`Резервная копия базы перед обновлением: ${backup}`);
  }

  for (const migration of pending) {
    // Транзакция: миграция выполняется целиком или не выполняется вовсе.
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${Number(migration.version)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Миграция ${migration.version} («${migration.name}») не выполнилась: ${error.message}`);
    }
  }
}

/**
 * Копия базы в папку backups рядом с ней: leads-<label>-<дата и время>.db. Возвращает путь к копии.
 * label — пометка, зачем копия: 'v3' (перед обновлением), 'before-clear' (перед очисткой), 'manual'.
 */
export function backupDatabase(db, file, label) {
  const dir = path.join(path.dirname(file), 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `${path.basename(file, '.db')}-${label}-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(target); // VACUUM INTO — встроенное в SQLite копирование базы
  return target;
}
