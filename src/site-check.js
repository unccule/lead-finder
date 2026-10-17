// Проверка сайта компании.
//
// Правила вежливости (из ТЗ):
//  • открываем только СОБСТВЕННЫЕ сайты компаний — соцсети, карты, Taplink не трогаем;
//  • только главную страницу, один запрос (+ переходы по переадресации, не больше 3);
//  • таймаут 10 секунд, страницу читаем не больше 3 МБ;
//  • между разными сайтами пауза 1,5 секунды;
//  • адреса внутренней сети (127.0.0.1, 192.168.…) не открываем никогда — защита от «ссылки-ловушки».
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { classifyLink, linkKey } from '../shared/link-kinds.js';
import { normalizeUrl } from '../shared/normalize.js';
import { companiesToCheck, saveSiteCheck } from './companies.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; LeadFinder/0.1; site check)';
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 3;
const PAUSE_MS = 1_500;

// Признаки конструкторов и движков сайтов: где искать — в HTML и заголовках ответа.
const PLATFORMS = [
  ['Tilda', /tildacdn\.com|data-tilda-|\btilda\.ws\b/i],
  ['Wix', /wixstatic\.com|static\.parastorage\.com|x-wix-/i],
  ['1С-Битрикс', /\/bitrix\/(?:js|templates|cache|components)\/|bitrix site manager|bx\.setcsslist/i],
  ['WordPress', /\/wp-content\/|\/wp-includes\/|content="wordpress/i],
  ['Joomla', /content="joomla|\/media\/jui\/|\/components\/com_/i],
  ['OpenCart', /catalog\/view\/theme\/|route=common\/home/i],
  ['uCoz', /\bucoz\.(?:ru|net|com)\b|\/\.s\/src\//i],
  ['Nethouse', /nethouse\.ru/i],
  ['Flexbe', /flexbe/i],
  ['uKit', /\bukit\.(?:com|me)\b|static\.ukit/i],
  ['Craftum', /craftum/i],
  ['LPgenerator', /lpgenerator/i],
  ['Taplink', /taplink\.(?:cc|ru|st)/i],
  ['InSales', /insales/i],
  ['Shopify', /cdn\.shopify\.com/i],
  ['Webasyst', /\/wa-data\/|webasyst/i],
  ['MODX', /modx/i],
  ['Drupal', /drupal/i],
  ['Mobirise', /mobirise/i],
  ['Google Sites', /sites\.google\.com/i],
];

// Сайт на бесплатном адресе конструктора (romashka.tilda.ws) — выглядит несерьёзно, повод предложить свой.
const FREE_HOSTS = [
  ['Яндекс Бизнес', /\.clients\.site$/],
  ['Tilda', /\.tilda\.ws$/],
  ['Wix', /\.wixsite\.com$/],
  ['Nethouse', /\.nethouse\.ru$/],
  ['uCoz', /\.(ucoz\.(ru|net|com)|narod\.ru|at\.ua|my1\.ru)$/],
  ['Platforma LP', /\.plp7\.ru$/],
  ['uKit', /\.ukit\.me$/],
  ['Craftum', /\.craftum\.io$/],
  ['Google Sites', /^sites\.google\.com$/],
];

// Заглушки регистраторов и «домен продаётся» — сайта по сути нет.
const PARKED = /домен\s+[^<]{0,80}(?:зарегистрирован|припаркован|продается|продаётся)|domain\s+(?:is\s+)?(?:for\s+sale|parked)|sedoparking|parkingcrew|bodis\.com|parking\.reg\.ru|this domain (?:may be|is) for sale/i;

/**
 * Проверяет главную страницу сайта. Возвращает объект с результатом (его и храним в базе):
 *   status: 'ok' | 'parked' | 'http_error' | 'redirect_away' | 'timeout' | 'dns' | 'refused' | 'reset'
 *           | 'tls' | 'error' | 'blocked' | 'not_site'
 *   https, mobile, response_ms, page_bytes, copyright_year, platform, title, http_status, final_url, note,
 *   free_host — название конструктора, если сайт на его бесплатном адресе (romashka.tilda.ws)
 */
export async function checkSite(rawUrl, { fetchImpl = fetch, lookup = dnsLookup, timeoutMs = TIMEOUT_MS, now = () => new Date() } = {}) {
  const base = {
    checked_at: now().toISOString(), url: '', status: 'error', http_status: null, final_url: '', https: false,
    mobile: null, response_ms: null, page_bytes: null, copyright_year: null, platform: '', title: '', note: '',
  };

  const href = normalizeUrl(rawUrl);
  if (!href) return { ...base, status: 'not_site', note: 'Это не ссылка' };
  const kind = classifyLink(href);
  if (kind.kind !== 'site') return { ...base, url: href, status: 'not_site', note: `Это не сайт, а ${kind.label}` };

  // Только главная страница: путь, параметры и якорь отбрасываем.
  const home = new URL(href);
  home.pathname = '/';
  home.search = '';
  home.hash = '';
  base.url = home.href;

  const freeHost = FREE_HOSTS.find(([, pattern]) => pattern.test(home.hostname))?.[0] ?? '';
  if (freeHost) base.free_host = freeHost;

  const context = { fetchImpl, lookup, timeoutMs, year: now().getFullYear() };
  const first = await openPage(home, context);

  // https:// не открылся (сертификат, отказ, обрыв)? Пробуем ту же главную по http:// — так её откроет и браузер.
  if (home.protocol === 'https:' && ['tls', 'refused', 'reset'].includes(first.status)) {
    const plain = new URL(home);
    plain.protocol = 'http:';
    const second = await openPage(plain, context);
    if (second.status !== 'ok' && second.status !== 'parked') return { ...base, ...first };
    return { ...base, ...second, note: joinNotes(`HTTPS не работает: ${first.note}`, second.note) };
  }

  // Главная отвечает 404, а в карточке указана конкретная страница (часто так у филиалов сетей:
  // site.ru/salons/stavropol)? Проверяем эту страницу — ещё один запрос, не больше.
  const cardPage = new URL(href);
  cardPage.hash = '';
  if (first.status === 'http_error' && [404, 410].includes(first.http_status) && cardPage.href !== home.href) {
    const second = await openPage(cardPage, context);
    if (second.status === 'ok' || second.status === 'parked') {
      return { ...base, ...second, note: joinNotes('Главная отвечает 404, проверил страницу из карточки', second.note) };
    }
  }
  return { ...base, ...first };
}

/** Открывает страницу, проходя не больше MAX_REDIRECTS переадресаций. */
async function openPage(startUrl, { fetchImpl, lookup, timeoutMs, year }) {
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  let current = startUrl;
  try {
    for (let hop = 0; ; hop++) {
      if (await isPrivateHost(current.hostname, lookup)) {
        return { status: 'blocked', final_url: current.href, note: 'Адрес ведёт во внутреннюю сеть — такие не открываю' };
      }
      const response = await fetchImpl(current.href, {
        redirect: 'manual', // переадресации проходим сами: так видно, куда ведёт сайт
        signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ru,en;q=0.8' },
      });

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        if (hop >= MAX_REDIRECTS) return { status: 'error', final_url: current.href, note: 'Слишком много переадресаций' };
        const next = new URL(location, current);
        const nextKind = classifyLink(next.href);
        if (nextKind.kind !== 'site') {
          // Сайт отправляет на ВК, Taplink и т. п. — туда не идём, это и есть ответ.
          return { status: 'redirect_away', final_url: next.href, https: current.protocol === 'https:',
            response_ms: Date.now() - started, note: `Сайт переадресует на ${nextKind.label}` };
        }
        current = next;
        continue;
      }

      const { text, bytes } = await readLimited(response, MAX_BYTES);
      const page = {
        http_status: response.status,
        final_url: current.href,
        https: current.protocol === 'https:',
        response_ms: Date.now() - started,
        page_bytes: bytes,
      };
      if (!response.ok) return { ...page, status: 'http_error', note: httpNote(response.status) };
      const facts = analyzeHtml(text, response.headers, year);
      if (PARKED.test(text)) return { ...page, ...facts, status: 'parked', note: 'Вместо сайта — заглушка регистратора' };
      return { ...page, ...facts, status: 'ok' };
    }
  } catch (error) {
    return { final_url: current.href, response_ms: Date.now() - started, ...networkError(error) };
  }
}

/** Что можно понять по HTML главной страницы. */
export function analyzeHtml(html, headers = new Headers(), currentYear = new Date().getFullYear()) {
  const viewport = /<meta\b[^>]*\bname\s*=\s*["']?viewport\b[^>]*>/i.exec(html)?.[0] ?? '';
  const headerText = ['x-powered-by', 'x-powered-cms', 'x-generator', 'server', 'set-cookie', 'link']
    .map((name) => headers.get(name) ?? '').join(' ');

  let platform = PLATFORMS.find(([, pattern]) => pattern.test(html) || pattern.test(headerText))?.[0] ?? '';
  if (!platform) {
    const generator = /<meta\b[^>]*\bname\s*=\s*["']?generator["']?[^>]*\bcontent\s*=\s*["']([^"']{1,60})/i.exec(html);
    platform = generator ? generator[1].trim() : '';
  }

  const title = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html)?.[1] ?? '';
  return {
    mobile: /width\s*=\s*device-width/i.test(viewport),
    copyright_year: copyrightYear(html, currentYear),
    platform,
    title: decodeBasicEntities(title).replace(/\s+/g, ' ').trim().slice(0, 120),
  };
}

/** Самый поздний год рядом со знаком ©: «© 2014–2019 Ромашка» → 2019. Год из будущего не берём. */
function copyrightYear(html, currentYear) {
  const pattern = /(?:©|&copy;|&#169;|\(c\)|copyright)[^0-9<]{0,40}((?:19|20)\d{2})(?:\s*(?:-|–|—|&ndash;|&mdash;)\s*((?:19|20)\d{2}))?/gi;
  let best = null;
  for (const match of html.matchAll(pattern)) {
    for (const year of [match[1], match[2]].filter(Boolean).map(Number)) {
      if (year <= currentYear && (best === null || year > best)) best = year;
    }
  }
  return best;
}

/** Читает не больше maxBytes и раскодирует текст в правильной кодировке (бывает и windows-1251). */
async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', bytes: 0 };
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks);
  const head = buffer.subarray(0, 4096).toString('latin1');
  const charset = (/charset=["']?([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8').toLowerCase();
  let text;
  try {
    text = new TextDecoder(charset).decode(buffer);
  } catch {
    text = new TextDecoder('utf-8').decode(buffer);
  }
  return { text, bytes };
}

function networkError(error) {
  const code = error?.cause?.code ?? error?.code ?? '';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return { status: 'timeout', note: 'Сайт не ответил за 10 секунд' };
  }
  if (code === 'ENOTFOUND') return { status: 'dns', note: 'Домен не найден — сайта нет или домен не продлён' };
  if (code === 'ECONNREFUSED') return { status: 'refused', note: 'Сервер сайта не принимает подключения' };
  if (code === 'ECONNRESET') return { status: 'reset', note: 'Сервер сайта обрывает соединение' };
  if (/CERT|SSL|TLS/i.test(code)) return { status: 'tls', note: 'Проблема с сертификатом HTTPS — браузер покажет «Небезопасно»' };
  return { status: 'error', note: `Сайт не открылся (${code || error?.message || 'неизвестная ошибка'})` };
}

function httpNote(status) {
  if ([401, 403, 405, 406, 429, 503].includes(status)) {
    return `Сайт ответил ${status} — возможно, защита от ботов. Открой его сам и посмотри`;
  }
  if (status === 404) return 'Главная страница не найдена (404)';
  if (status >= 500) return `Сайт сломан: ошибка сервера ${status}`;
  return `Сайт ответил ошибкой ${status}`;
}

async function isPrivateHost(hostname, lookup) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  return addresses.some(isPrivateAddress);
}

function isPrivateAddress(address) {
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return ip === '::1' || ip === '::' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

function decodeBasicEntities(text) {
  return text.replace(/&(amp|quot|#39|lt|gt|nbsp|laquo|raquo);/g, (all, name) =>
    ({ amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>', nbsp: ' ', laquo: '«', raquo: '»' })[name] ?? all);
}

function joinNotes(...notes) {
  return notes.filter(Boolean).join('. ');
}

/**
 * Фоновая проверка сайтов по очереди. Пока идёт, страница спрашивает status() и показывает прогресс.
 *   scope 'new' — только ещё не проверенные, 'all' — все сайты заново.
 */
export function createSiteCheckJob({ db, check = checkSite, pauseMs = PAUSE_MS, wait = sleep }) {
  const state = { running: false, total: 0, done: 0, current: '', finished_at: null };

  async function run(targets) {
    const results = new Map(); // один сайт у нескольких компаний (филиалы) проверяем один раз
    let requested = false;
    for (const company of targets) {
      state.current = company.website;
      const key = linkKey(company.website).split('/')[0];
      let result = results.get(key);
      if (!result) {
        if (requested) await wait(pauseMs); // пауза между сайтами — не нагружаем чужие серверы
        result = await check(company.website);
        requested = true;
        results.set(key, result);
      }
      saveSiteCheck(db, company.id, result);
      state.done += 1;
    }
  }

  return {
    status: () => ({ ...state }),
    start(scope = 'new') {
      if (state.running) return { started: false, ...state };
      const targets = companiesToCheck(db, scope);
      Object.assign(state, { running: true, total: targets.length, done: 0, current: '', finished_at: null });
      run(targets)
        .catch((error) => console.error('Проверка сайтов остановилась из-за ошибки:', error))
        .finally(() => Object.assign(state, { running: false, current: '', finished_at: new Date().toISOString() }));
      return { started: true, ...state };
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
