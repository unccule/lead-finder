// Веб-сервер: отдаёт страницу (папки public/ и shared/) и отвечает на запросы API.
//
//   GET  /api/companies     → { companies: [...] }                список, новые сверху
//   POST /api/companies     → 201 { company } | 400 { error, fields } | 409 { error, existing }
//   GET  /api/companies/:id → { company, history }            одна компания + история статусов
//   PATCH /api/companies/:id → 200 { company } | 400 | 404 | 409  изменить (можно прислать одно поле)
//   POST /api/companies/delete { ids }        → { deleted }        выборочно (запоминаются как «не предлагать»)
//   POST /api/companies/clear  { confirm: 'all' } → { deleted, backup }  всё, с резервной копией базы
//   GET  /api/osm/groups    → { groups: [...] }                   сферы для автопоиска
//   POST /api/osm/search    → { search_id, city, total, counts, sample }   найти, но пока не сохранять
//   POST /api/osm/import    → { added, duplicates, invalid }      добавить найденное в базу
//   GET  /api/site-checks   → { running, done, total, current, pending }  ход проверки сайтов
//   POST /api/site-checks   → 202 { started, ... }                запустить проверку сайтов
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addCompanies, addCompany, clearCompanies, companiesToCheck, deleteCompanies, findExisting, getCompany,
  getStatusHistory, isExcluded, listCompanies, updateCompany,
} from './companies.js';
import { backupDatabase } from './db.js';
import { OSM_GROUPS, searchOsm } from './osm.js';
import { checkSite, createSiteCheckJob } from './site-check.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const MAX_BODY_BYTES = 100 * 1024;

// Сервер отвечает, только если к нему обращаются по «домашнему» имени.
// Это защищает от хитрых чужих сайтов, которые пытаются достучаться до localhost через свой домен.
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Ошибка, которую нужно показать человеку: статус ответа + понятный текст. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_DELETE_IDS = 10_000;

/**
 * Создаёт сервер. dbFile — путь к файлу базы (для резервной копии перед очисткой).
 * fetchImpl, lookup и sitePauseMs можно подменить в тестах,
 * чтобы проверять поиск и проверку сайтов без настоящего интернета.
 */
export function createServer({ db, dbFile, fetchImpl = fetch, lookup, sitePauseMs } = {}) {
  const siteJob = createSiteCheckJob({
    db,
    check: (url) => checkSite(url, { fetchImpl, ...(lookup && { lookup }) }),
    ...(sitePauseMs !== undefined && { pauseMs: sitePauseMs }),
  });
  // Последний результат автопоиска живёт в памяти, пока ты решаешь, что из него добавить.
  const osm = { running: false, last: null };

  const routes = {
    '/api/companies': {
      GET: (req, res) => sendJson(res, 200, { companies: listCompanies(db) }),
      POST: async (req, res) => {
        const result = addCompany(db, await readJson(req));
        if (result.ok) return sendJson(res, 201, { company: result.company });
        if (result.reason === 'invalid') return sendJson(res, 400, { error: 'Проверь отмеченные поля', fields: result.errors });
        return sendJson(res, 409, { error: result.message, existing: result.existing });
      },
    },

    '/api/companies/:id': {
      GET: (req, res, { id }) => {
        const company = getCompany(db, id);
        if (!company) throw new HttpError(404, 'Такой компании нет — возможно, её уже удалили');
        sendJson(res, 200, { company, history: getStatusHistory(db, id) });
      },
      PATCH: async (req, res, { id }) => {
        const result = updateCompany(db, id, await readJson(req));
        if (result.ok) return sendJson(res, 200, { company: result.company });
        if (result.reason === 'not_found') throw new HttpError(404, 'Такой компании нет — возможно, её уже удалили');
        if (result.reason === 'invalid') return sendJson(res, 400, { error: 'Проверь отмеченные поля', fields: result.errors });
        return sendJson(res, 409, { error: result.message, existing: result.existing });
      },
    },

    '/api/companies/delete': {
      POST: async (req, res) => {
        const { ids } = await readJson(req);
        const valid = Array.isArray(ids) && ids.length <= MAX_DELETE_IDS && ids.every((id) => Number.isInteger(id) && id > 0);
        if (!valid || ids.length === 0) throw new HttpError(400, 'Не выбраны компании для удаления');
        sendJson(res, 200, deleteCompanies(db, ids));
      },
    },

    '/api/companies/clear': {
      POST: async (req, res) => {
        // Явное подтверждение в самом запросе: случайный запрос не сотрёт всю базу.
        const { confirm } = await readJson(req);
        if (confirm !== 'all') throw new HttpError(400, 'Нужно подтверждение полной очистки');
        // Сначала копия базы — если очистка была ошибкой, всё можно вернуть.
        const backup = dbFile && dbFile !== ':memory:' ? backupDatabase(db, dbFile, 'before-clear') : null;
        sendJson(res, 200, { ...clearCompanies(db), backup });
      },
    },

    '/api/osm/groups': {
      GET: (req, res) => sendJson(res, 200, {
        groups: OSM_GROUPS.map(({ id, label, default: checked }) => ({ id, label, default: checked })),
      }),
    },

    '/api/osm/search': {
      POST: async (req, res) => {
        const { city, groups } = await readJson(req);
        if (typeof city !== 'string' || !city.trim() || city.length > 100) throw new HttpError(400, 'Укажи город');
        if (osm.running) throw new HttpError(409, 'Поиск уже идёт — дождись результата');

        osm.running = true;
        try {
          const found = await searchOsm(
            { city: city.trim(), groups: Array.isArray(groups) ? groups.filter((g) => typeof g === 'string') : [] },
            { fetchImpl },
          );
          for (const item of found.items) {
            item.in_base = findExisting(db, toCompanyInput(item)) !== null;
            // Удалял её выборочно — значит, она тебе не нужна: не предлагаем снова.
            item.excluded = !item.in_base && isExcluded(db, toCompanyInput(item));
          }
          osm.last = { id: randomUUID(), city: found.city, items: found.items, skipped: found.skipped };
          sendJson(res, 200, searchSummary(osm.last));
        } finally {
          osm.running = false;
        }
      },
    },

    '/api/osm/import': {
      POST: async (req, res) => {
        const { search_id: searchId, include } = await readJson(req);
        if (!osm.last || osm.last.id !== searchId) {
          throw new HttpError(410, 'Результаты поиска устарели (например, программу перезапускали). Запусти поиск ещё раз.');
        }
        const wanted = new Set(Array.isArray(include) ? include : []);
        const chosen = osm.last.items.filter((item) =>
          !item.in_base && !item.excluded && wanted.has(item.site_kind === 'site' ? 'with_site' : 'no_site'));

        const summary = addCompanies(db, chosen.map(toCompanyInput));
        for (const item of chosen) item.in_base = true; // повторное нажатие не добавит их снова

        // Добавили компании с сайтами — сразу запускаем их проверку в фоне.
        const check = summary.added > 0 && wanted.has('with_site') ? siteJob.start('new') : null;
        sendJson(res, 200, { ...summary, site_check_started: Boolean(check?.started) });
      },
    },

    '/api/site-checks': {
      GET: (req, res) => sendJson(res, 200, { ...siteJob.status(), pending: companiesToCheck(db, 'new').length }),
      POST: async (req, res) => {
        const { scope } = await readJson(req);
        const state = siteJob.start(scope === 'all' ? 'all' : 'new');
        sendJson(res, 202, state);
      },
    },
  };

  return http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, routes);
    } catch (error) {
      if (error.status) {
        if (!res.headersSent) sendJson(res, error.status, { error: error.message });
        return;
      }
      console.error('Ошибка при обработке запроса:', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера. Подробности — в окне Lead Finder.' });
      else res.end();
    }
  });
}

async function handleRequest(req, res, routes) {
  setSecurityHeaders(res);

  if (!ALLOWED_HOSTS.has(hostnameOf(req.headers.host))) {
    return sendJson(res, 403, { error: 'Доступ только с этого компьютера (localhost)' });
  }

  const { pathname } = new URL(req.url, 'http://localhost');
  const [route, params] = findRoute(routes, pathname);
  if (route) {
    const handler = route[req.method];
    if (handler) return handler(req, res, params);
    res.setHeader('Allow', Object.keys(route).join(', '));
    return sendJson(res, 405, { error: 'Этот метод здесь не поддерживается' });
  }

  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Нет такого адреса API' });

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(pathname, req, res);

  res.setHeader('Allow', 'GET, HEAD');
  return sendJson(res, 405, { error: 'Этот метод здесь не поддерживается' });
}

/**
 * Ищет маршрут по адресу. Точное совпадение ('/api/companies') или шаблон с номером
 * ('/api/companies/:id' подходит к '/api/companies/15' → params = { id: 15 }).
 */
function findRoute(routes, pathname) {
  if (Object.hasOwn(routes, pathname)) return [routes[pathname], {}];
  for (const [pattern, route] of Object.entries(routes)) {
    if (!pattern.includes(':')) continue;
    const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>\\d{1,12})')}$`);
    const match = regex.exec(pathname);
    if (match) return [route, Object.fromEntries(Object.entries(match.groups).map(([key, value]) => [key, Number(value)]))];
  }
  return [null, {}];
}

/** Найденная в OSM компания → данные для addCompany (как будто заполнили форму). */
function toCompanyInput(item) {
  return {
    name: item.name,
    category: item.category,
    city: item.city,
    address: item.address,
    card_url: item.card_url,
    phone: item.phone,
    website: item.website,
    other_links: item.other_links.join('\n'),
  };
}

function searchSummary({ id, city, items, skipped }) {
  const fresh = items.filter((item) => !item.in_base && !item.excluded);
  return {
    search_id: id,
    city: { name: city.name, display: city.display },
    total: items.length,
    counts: {
      new_no_site: fresh.filter((item) => item.site_kind !== 'site').length,
      new_with_site: fresh.filter((item) => item.site_kind === 'site').length,
      in_base: items.filter((item) => item.in_base).length,
      excluded: items.filter((item) => item.excluded).length,
      skipped_no_contacts: skipped,
    },
    // Несколько примеров «без сайта», чтобы глазами убедиться, что нашлось то, что нужно.
    sample: fresh.filter((item) => item.site_kind !== 'site').slice(0, 12)
      .map(({ name, category, address, phone, website, site_kind: siteKind }) =>
        ({ name, category, address, phone, website, site_kind: siteKind })),
  };
}

/**
 * Читает тело запроса как JSON. Требуем Content-Type: application/json: обычная HTML-форма
 * с чужого сайта не умеет отправлять такой запрос, а fetch с чужого сайта браузер не пропустит (CORS).
 */
async function readJson(req) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new HttpError(415, 'Ожидаются данные в формате JSON');

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Слишком большой запрос');

  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Не получилось прочитать данные: это не JSON');
  }
  return data !== null && typeof data === 'object' ? data : {};
}

async function serveStatic(pathname, req, res) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return sendNotFound(res);
  }
  if (relative === '/') relative = '/index.html';

  const [prefix, baseDir] = relative.startsWith('/shared/') ? ['/shared/', SHARED_DIR] : ['/', PUBLIC_DIR];
  const filePath = path.join(baseDir, relative.slice(prefix.length));

  // Защита от «выхода» из папки: адрес вроде /..%2F.env не должен открыть файл вне public/ и shared/.
  if (!filePath.startsWith(baseDir + path.sep)) return sendNotFound(res);

  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  if (!type) return sendNotFound(res);

  let content;
  try {
    content = await readFile(filePath);
  } catch {
    return sendNotFound(res);
  }
  // no-store: браузер не кэширует файлы, после правок достаточно обновить страницу.
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : content);
}

function setSecurityHeaders(res) {
  // Разрешаем странице загружать скрипты и стили только с нашего же сервера.
  // Даже если в данные как-то попадёт <script>, браузер его не выполнит.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function hostnameOf(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return '';
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sendNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Не найдено');
}
