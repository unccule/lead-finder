// Итог по сайту компании: к какой группе она относится и какие проблемы найдены.
// Используется для вкладок-фильтров над таблицей и для «горячести» (shared/hotness.js).
import { classifyLink } from './link-kinds.js';

/** Группы для фильтров (порядок — как во вкладках). */
export const SITE_GROUPS = {
  none: 'Без сайта',
  problem: 'Сайт с проблемами',
  unchecked: 'Не проверены',
  ok: 'Сайт в порядке',
};

const SLOW_MS = 5_000;
const OLD_YEARS = 3; // «© 2021» в 2026 году — сайт давно не обновляли

/**
 * { group, label, problems } для компании.
 *   group    — ключ из SITE_GROUPS;
 *   label    — короткая подпись для таблицы;
 *   problems — [{ code, text }]: code — для подсчёта баллов, text — понятная причина для человека.
 *
 * Коды проблем:
 *   no_site, only_link (+ kind: social | linkpage | directory | …),
 *   dns, parked, redirect_away, not_opening, http_error,
 *   free_host, no_mobile, no_https, old_copyright (+ age), slow
 */
export function siteStatus(company, { now = new Date() } = {}) {
  if (!company.website) return { group: 'none', label: 'Сайта нет', problems: [issue('no_site', 'нет сайта')] };

  const kind = classifyLink(company.website);
  if (kind.kind !== 'site') {
    return {
      group: 'none',
      label: `Только ${kind.label}`,
      problems: [{ ...issue('only_link', `вместо сайта — только ${kind.label}`), kind: kind.kind }],
    };
  }

  const check = company.site_check;
  if (!check) return { group: 'unchecked', label: 'Сайт не проверен', problems: [] };

  switch (check.status) {
    case 'ok':
      break;
    case 'parked':
      return problem('Заглушка вместо сайта', 'parked', 'вместо сайта — заглушка регистратора');
    case 'dns':
      return problem('Домен не существует', 'dns', 'домен сайта не существует или не продлён');
    case 'redirect_away':
      return problem(check.note || 'Переадресует на соцсеть', 'redirect_away',
        (check.note || 'сайт переадресует на соцсеть').toLowerCase());
    case 'timeout':
      return problem('Не открывается', 'not_opening', 'сайт не открывается (не ответил за 10 секунд)');
    case 'refused':
    case 'reset':
    case 'tls':
      return problem('Не открывается', 'not_opening', (check.note || 'сайт не открывается').toLowerCase());
    case 'http_error':
      // 403/429/503 часто означают защиту от ботов: сайт может нормально открываться у людей.
      if ([401, 403, 405, 406, 429, 503].includes(check.http_status)) {
        return { group: 'unchecked', label: 'Проверь вручную', problems: [] };
      }
      return problem('Сайт с ошибкой', 'http_error', `сайт отвечает ошибкой ${check.http_status}`);
    case 'blocked':
    case 'not_site':
      return { group: 'unchecked', label: 'Не проверялся', problems: [] };
    default:
      return problem('Не открывается', 'not_opening', 'сайт не открылся у программы — проверь вручную');
  }

  const problems = [];
  if (check.free_host) problems.push(issue('free_host', `сайт на бесплатном адресе конструктора (${check.free_host})`));
  if (check.mobile === false) problems.push(issue('no_mobile', 'нет мобильной версии'));
  if (!check.https) problems.push(issue('no_https', 'нет HTTPS — браузер пишет «Не защищено»'));
  const age = check.copyright_year ? now.getFullYear() - check.copyright_year : 0;
  if (age >= OLD_YEARS) {
    problems.push({ ...issue('old_copyright', `© ${check.copyright_year} — сайт давно не обновляли`), age });
  }
  if (check.response_ms > SLOW_MS) problems.push(issue('slow', 'медленно открывается'));

  return problems.length > 0
    ? { group: 'problem', label: 'Есть проблемы', problems }
    : { group: 'ok', label: 'Сайт в порядке', problems: [] };
}

function issue(code, text) {
  return { code, text };
}

function problem(label, code, text) {
  return { group: 'problem', label, problems: [issue(code, text)] };
}
