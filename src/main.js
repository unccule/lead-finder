// Точка входа версии «в браузере»: запускает Lead Finder на http://localhost:3001.
// Запуск: двойной клик по start-leads.cmd или команда npm start.
// (Отдельное приложение запускается через electron/main.js — см. README.)
import { DEFAULT_DB_FILE, loadEnv, startLeadFinder } from './start.js';

loadEnv();
const PORT = Number(process.env.PORT) || 3001;
const DB_FILE = process.env.LEADS_DB || DEFAULT_DB_FILE;

let leadFinder;
try {
  leadFinder = await startLeadFinder({ dbFile: DB_FILE, port: PORT });
} catch (error) {
  if (error.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} уже занят. Скорее всего, Lead Finder уже запущен в другом окне —`);
    console.error(`тогда просто открой http://localhost:${PORT} в браузере.`);
  } else {
    console.error(`Не получилось запустить Lead Finder. База данных: ${DB_FILE}`);
    console.error(`Причина: ${error.message}`);
    console.error('Проверь, что папка доступна для записи и путь к ней не слишком длинный.');
  }
  process.exit(1);
}

console.log(`Lead Finder работает: http://localhost:${leadFinder.port}`);
console.log(`База данных: ${DB_FILE}`);
console.log('Чтобы остановить — закрой это окно или нажми Ctrl+C.');

process.on('SIGINT', () => {
  console.log('\nОстанавливаю Lead Finder…');
  leadFinder.close();
  process.exit(0);
});
