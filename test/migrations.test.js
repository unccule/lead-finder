import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { MIGRATIONS } from '../src/migrations.js';
import { addCompany, listCompanies } from '../src/companies.js';

test('новое поле добавляется миграцией без потери данных, перед этим делается копия базы', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lead-finder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'leads.db');

  // «Старая версия программы»: только миграция 1.
  let db = openDatabase(file);
  addCompany(db, { name: 'Кафе «Ромашка»', phone: '+7 843 200-00-00' });
  db.close();

  // «Новая версия»: появилась миграция 2 с новым полем (так будет на следующих этапах).
  const withStatus = [
    ...MIGRATIONS,
    { version: 2, name: 'Статус', sql: "ALTER TABLE companies ADD COLUMN status TEXT NOT NULL DEFAULT 'new'" },
  ];
  db = openDatabase(file, { migrations: withStatus });
  const row = db.prepare('SELECT name, phone, status FROM companies').get();
  assert.deepEqual({ ...row }, { name: 'Кафе «Ромашка»', phone: '+78432000000', status: 'new' });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  db.close();

  const backups = readdirSync(path.join(dir, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^leads-v1-.*\.db$/);

  // Повторный запуск: миграции уже выполнены, новых копий не появляется, данные на месте.
  db = openDatabase(file, { migrations: withStatus });
  assert.equal(listCompanies(db).length, 1);
  db.close();
  assert.equal(readdirSync(path.join(dir, 'backups')).length, 1);
});

test('ошибочная миграция откатывается целиком, база остаётся рабочей', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lead-finder-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'leads.db');

  openDatabase(file).close();
  const broken = [...MIGRATIONS, { version: 2, name: 'Сломанная', sql: 'ALTER TABLE nope ADD COLUMN x TEXT' }];
  assert.throws(() => openDatabase(file, { migrations: broken }), /Миграция 2/);

  const db = openDatabase(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  db.close();
});
