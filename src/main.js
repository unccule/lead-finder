// Точка входа: открывает базу и запускает сервер на http://localhost:3001.
// Запуск: двойной клик по start-leads.cmd или команда npm start.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createServer } from './server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Секреты (будущие ключи API) читаем из .env, если файл есть.
const ENV_FILE = path.join(ROOT, '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const PORT = Number(process.env.PORT) || 3001;
// 127.0.0.1 — «только этот компьютер»: с телефона или чужого ноутбука в той же Wi-Fi сети не зайти.
const HOST = '127.0.0.1';
const DB_FILE = process.env.LEADS_DB || path.join(ROOT, 'data', 'leads.db');

let db;
try {
  db = openDatabase(DB_FILE);
} catch (error) {
  console.error(`Не получилось открыть базу данных: ${DB_FILE}`);
  console.error(`Причина: ${error.message}`);
  console.error('Проверь, что папка доступна для записи и путь к ней не слишком длинный.');
  process.exit(1);
}
const server = createServer({ db });

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} уже занят. Скорее всего, Lead Finder уже запущен в другом окне —`);
    console.error(`тогда просто открой http://localhost:${PORT} в браузере.`);
  } else {
    console.error('Сервер не запустился:', error);
  }
  db.close();
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`Lead Finder работает: http://localhost:${PORT}`);
  console.log(`База данных: ${DB_FILE}`);
  console.log('Чтобы остановить — закрой это окно или нажми Ctrl+C.');
});

process.on('SIGINT', () => {
  console.log('\nОстанавливаю Lead Finder…');
  server.close();
  db.close();
  process.exit(0);
});
