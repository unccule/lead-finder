import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { MIGRATIONS } from '../src/migrations.js';
import { addCompany, listCompanies } from '../src/companies.js';

const LATEST = MIGRATIONS.at(-1).version;

function tempDbFile(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lead-finder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'leads.db');
}

test('база этапа 1 обновляется до этапа 2: записи на месте, у них появляется пустое поле other_links', (t) => {
  const file = tempDbFile(t);

  // База «как после этапа 1»: только первая миграция, запись вставляем напрямую.
  let db = openDatabase(file, { migrations: MIGRATIONS.filter((m) => m.version === 1) });
  db.prepare(`INSERT INTO companies (name, phone, website, name_key, created_at, updated_at)
              VALUES ('Кафе «Ромашка»', '+78432000000', 'https://vk.com/romashka', 'кафе ромашка', 'x', 'x')`).run();
  db.close();

  db = openDatabase(file);
  const [company] = listCompanies(db);
  assert.equal(company.name, 'Кафе «Ромашка»');
  assert.equal(company.phone, '+78432000000');
  assert.equal(company.website, 'https://vk.com/romashka');
  assert.equal(company.other_links, '');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, LATEST);
  db.close();

  const backups = readdirSync(path.join(path.dirname(file), 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^leads-v1-.*\.db$/);
});

test('следующее новое поле тоже добавится без потери данных, копия делается один раз', (t) => {
  const file = tempDbFile(t);

  let db = openDatabase(file);
  addCompany(db, { name: 'Кафе «Ромашка»', phone: '+7 843 200-00-00' });
  db.close();

  // «Новая версия программы»: появилась ещё одна миграция с новым полем.
  const withPriority = [
    ...MIGRATIONS,
    { version: LATEST + 1, name: 'Приоритет', sql: "ALTER TABLE companies ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'" },
  ];
  db = openDatabase(file, { migrations: withPriority });
  const row = db.prepare('SELECT name, phone, priority FROM companies').get();
  assert.deepEqual({ ...row }, { name: 'Кафе «Ромашка»', phone: '+78432000000', priority: 'normal' });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, LATEST + 1);
  db.close();

  // Повторный запуск: миграции уже выполнены, новых копий не появляется, данные на месте.
  db = openDatabase(file, { migrations: withPriority });
  assert.equal(listCompanies(db).length, 1);
  db.close();
  assert.equal(readdirSync(path.join(path.dirname(file), 'backups')).length, 1);
});

test('полная очистка через сервер сначала кладёт резервную копию рядом с базой', async (t) => {
  const { startLeadFinder } = await import('../src/start.js');
  const file = tempDbFile(t);
  const app = await startLeadFinder({ dbFile: file, port: 0 });
  let result;
  try {
    addCompany(app.db, { name: 'Кафе «Ромашка»', phone: '+7 843 200-00-00' });
    const response = await fetch(`${app.url}api/companies/clear`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'all' }),
    });
    result = await response.json();
  } finally {
    // Закрываем сервер и базу сразу: Windows не даёт удалить временную папку с открытым файлом базы.
    app.close();
  }
  assert.equal(result.deleted, 1);
  assert.match(path.basename(result.backup), /^leads-before-clear-.*\.db$/);

  // В копии компания на месте — очистку можно «откатить», подложив этот файл вместо leads.db.
  const backup = openDatabase(result.backup);
  assert.equal(listCompanies(backup)[0].name, 'Кафе «Ромашка»');
  backup.close();
});

test('ошибочная миграция откатывается целиком, база остаётся рабочей', (t) => {
  const file = tempDbFile(t);

  openDatabase(file).close();
  const broken = [...MIGRATIONS, { version: LATEST + 1, name: 'Сломанная', sql: 'ALTER TABLE nope ADD COLUMN x TEXT' }];
  assert.throws(() => openDatabase(file, { migrations: broken }), new RegExp(`Миграция ${LATEST + 1}`));

  const db = openDatabase(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, LATEST);
  db.close();
});
