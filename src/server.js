// Веб-сервер: отдаёт страницу (папки public/ и shared/) и отвечает на запросы API.
//
//   GET  /api/companies  → { companies: [...] }            список, новые сверху
//   POST /api/companies  → 201 { company }                 сохранено
//                          400 { error, fields }           ошибки в полях
//                          409 { error, existing }         дубль
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addCompany, listCompanies } from './companies.js';

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

export function createServer({ db }) {
  return http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, db);
    } catch (error) {
      console.error('Ошибка при обработке запроса:', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера. Подробности — в окне Lead Finder.' });
      else res.end();
    }
  });
}

async function handleRequest(req, res, db) {
  setSecurityHeaders(res);

  if (!ALLOWED_HOSTS.has(hostnameOf(req.headers.host))) {
    return sendJson(res, 403, { error: 'Доступ только с этого компьютера (localhost)' });
  }

  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/api/companies') {
    if (req.method === 'GET') return sendJson(res, 200, { companies: listCompanies(db) });
    if (req.method === 'POST') return createCompany(req, res, db);
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Этот метод здесь не поддерживается' });
  }

  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Нет такого адреса API' });

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(pathname, req, res);

  res.setHeader('Allow', 'GET, HEAD');
  return sendJson(res, 405, { error: 'Этот метод здесь не поддерживается' });
}

async function createCompany(req, res, db) {
  // Требуем JSON. Обычная HTML-форма с чужого сайта не умеет отправлять такой запрос,
  // а fetch с чужого сайта браузер не пропустит без нашего разрешения (CORS).
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return sendJson(res, 415, { error: 'Ожидаются данные в формате JSON' });
  }

  const body = await readBody(req);
  if (body === null) return sendJson(res, 413, { error: 'Слишком большой запрос' });

  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'Не получилось прочитать данные: это не JSON' });
  }

  const result = addCompany(db, input);
  if (result.ok) return sendJson(res, 201, { company: result.company });
  if (result.reason === 'invalid') return sendJson(res, 400, { error: 'Проверь отмеченные поля', fields: result.errors });
  return sendJson(res, 409, { error: result.message, existing: result.existing });
}

/** Читает тело запроса. Возвращает null, если оно больше MAX_BODY_BYTES. */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  return size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString('utf8');
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
