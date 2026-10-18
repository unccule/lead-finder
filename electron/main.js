// Lead Finder как отдельное приложение (Electron).
//
// Electron = Chromium (окно, как у браузера) + Node.js (наш сервер) в одной программе.
// «Главный процесс» (этот файл) запускает тот же сервер, что и start-leads.cmd, но на свободном
// порту, и показывает страницу в собственном окне — без адресной строки и вкладок.
// Страница внутри окна не получает доступа к Node.js и файлам: она общается с сервером так же,
// как в браузере. Так безопаснее — текст из карточек не может «вырваться» в систему.
import { app, BrowserWindow, Menu, clipboard, dialog, shell } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { backupDatabase } from '../src/db.js';
import { DEFAULT_DB_FILE, ROOT, loadEnv, startLeadFinder } from '../src/start.js';

const APP_NAME = 'Lead Finder';
let leadFinder = null; // запущенный сервер и база
let mainWindow = null;

app.setName(APP_NAME);
app.setAppUserModelId('ru.leadfinder.app'); // чтобы Windows группировала окна и значок в панели задач

// Вторая копия программы не нужна: при повторном запуске просто показываем уже открытое окно.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox(`${APP_NAME} не запустился`, `${error.message}\n\nБаза данных: ${databaseFile()}`);
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => leadFinder?.close()); // закрыл окно — выключились и сервер, и база

async function start() {
  loadEnv();
  const dbFile = databaseFile();
  leadFinder = await startLeadFinder({ dbFile, port: 0 }); // 0 = любой свободный порт
  Menu.setApplicationMenu(buildMenu(dbFile));

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    title: APP_NAME,
    icon: path.join(ROOT, 'build', 'icon.png'),
    backgroundColor: '#f3f5f8',
    show: false, // покажем, когда страница нарисуется, — без белой вспышки
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Ссылки на сайты компаний, карточки 2ГИС, телефоны — открываем в обычном браузере / звонилке,
  // а не внутри приложения.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(leadFinder.url)) return;
    event.preventDefault();
    openOutside(url);
  });
  mainWindow.webContents.on('context-menu', (event, params) => showContextMenu(params));

  await mainWindow.loadURL(leadFinder.url);
  if (process.env.LEAD_FINDER_SELFTEST) await selfTest(process.env.LEAD_FINDER_SELFTEST);
}

/**
 * Где лежит база:
 *  • LEADS_DB — если указан явно;
 *  • запуск из папки проекта (npm run app) — data/leads.db, та же база, что у версии в браузере;
 *  • собранная программа — тоже база проекта (путь записан при сборке), если папка проекта на месте;
 *    иначе — %APPDATA%\Lead Finder\leads.db.
 */
function databaseFile() {
  if (process.env.LEADS_DB) return process.env.LEADS_DB;
  if (!app.isPackaged) return DEFAULT_DB_FILE;
  try {
    const info = JSON.parse(readFileSync(path.join(ROOT, 'electron', 'build-info.json'), 'utf8'));
    if (info.projectDataDir && existsSync(info.projectDataDir)) return path.join(info.projectDataDir, 'leads.db');
  } catch {
    // build-info.json нет — значит, собирали без папки проекта рядом
  }
  return path.join(app.getPath('userData'), 'leads.db');
}

function openOutside(url) {
  if (/^(https?|tel|mailto):/i.test(url)) shell.openExternal(url);
}

function buildMenu(dbFile) {
  return Menu.buildFromTemplate([
    {
      label: 'Файл',
      submenu: [
        { label: 'Открыть папку с базой данных', click: () => shell.showItemInFolder(dbFile) },
        { label: 'Сделать резервную копию базы', click: () => makeBackup(dbFile) },
        { type: 'separator' },
        { label: 'Выход', role: 'quit' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { label: 'Отменить', role: 'undo' },
        { label: 'Повторить', role: 'redo' },
        { type: 'separator' },
        { label: 'Вырезать', role: 'cut' },
        { label: 'Копировать', role: 'copy' },
        { label: 'Вставить', role: 'paste' },
        { label: 'Выделить всё', role: 'selectAll' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Обновить', role: 'reload' },
        { type: 'separator' },
        { label: 'Крупнее', role: 'zoomIn' },
        { label: 'Мельче', role: 'zoomOut' },
        { label: 'Обычный размер', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Во весь экран', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Справка',
      submenu: [
        { label: 'О программе', click: showAbout },
        { type: 'separator' },
        { label: 'Инструменты разработчика', role: 'toggleDevTools' },
      ],
    },
  ]);
}

/** Меню по правой кнопке мыши: в Electron его нет «из коробки», а вставлять текст карточек удобно. */
function showContextMenu(params) {
  const items = [];
  if (params.isEditable) {
    items.push(
      { label: 'Вырезать', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Копировать', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Вставить', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Выделить всё', role: 'selectAll' },
    );
  } else if (params.selectionText) {
    items.push({ label: 'Копировать', role: 'copy' });
  }
  if (/^https?:/i.test(params.linkURL)) {
    if (items.length > 0) items.push({ type: 'separator' });
    items.push(
      { label: 'Открыть ссылку в браузере', click: () => shell.openExternal(params.linkURL) },
      { label: 'Копировать ссылку', click: () => clipboard.writeText(params.linkURL) },
    );
  }
  if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

async function makeBackup(dbFile) {
  try {
    const file = backupDatabase(leadFinder.db, dbFile, 'manual');
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: APP_NAME,
      message: 'Резервная копия базы сохранена',
      detail: file,
      buttons: ['Показать в папке', 'Готово'],
    });
    if (response === 0) shell.showItemInFolder(file);
  } catch (error) {
    dialog.showErrorBox('Не получилось сделать копию', error.message);
  }
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: `О программе ${APP_NAME}`,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail: 'Помощник для поиска клиентов на создание сайтов и лендингов.\n\n' +
      `База данных: ${leadFinder.dbFile}\n\n` +
      'Данные автопоиска: © участники OpenStreetMap, лицензия ODbL.',
  });
}

/**
 * Самопроверка сборки (для разработчика): LEAD_FINDER_SELFTEST=путь.png
 * Ждёт, пока страница загрузит список, сохраняет снимок окна и печатает краткую сводку, затем выходит.
 */
async function selfTest(screenshotFile) {
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const summary = await mainWindow.webContents.executeJavaScript(`({
    title: document.title,
    url: location.href,
    companies: document.getElementById('companies-count')?.textContent,
    tabs: [...document.querySelectorAll('#filter-tabs .tab')].map((b) => b.textContent),
    groups: document.querySelectorAll('#osm-groups input').length,
  })`);
  const image = await mainWindow.webContents.capturePage();
  writeFileSync(screenshotFile, image.toPNG());
  console.log(JSON.stringify({ ...summary, dbFile: leadFinder.dbFile, packaged: app.isPackaged, node: process.versions.node }));
  app.quit();
}
