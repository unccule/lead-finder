// Запуск Lead Finder: база данных + сервер.
// Этим пользуются обе «обёртки»: start-leads.cmd (страница в браузере) и приложение Electron.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createServer } from './server.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_DB_FILE = path.join(ROOT, 'data', 'leads.db');

/** Секреты (будущие ключи API) читаем из .env, если файл есть. */
export function loadEnv() {
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/**
 * Открывает базу и запускает сервер на 127.0.0.1 («только этот компьютер»).
 *   port 0 — любой свободный порт: так делает приложение, чтобы не мешать сайту на 3001.
 * Возвращает { url, port, dbFile, db, close() }.
 * Если не получилось (порт занят, база не открылась) — бросает ошибку; что с ней делать, решает обёртка.
 */
export async function startLeadFinder({ dbFile = DEFAULT_DB_FILE, port = 3001, host = '127.0.0.1' } = {}) {
  const db = openDatabase(dbFile);
  const server = createServer({ db, dbFile });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    db.close();
    throw error;
  }

  const actualPort = server.address().port;
  return {
    url: `http://${host}:${actualPort}/`,
    port: actualPort,
    dbFile,
    db,
    close() {
      server.closeAllConnections(); // не ждём «висящих» соединений браузера
      server.close();
      db.close();
    },
  };
}
