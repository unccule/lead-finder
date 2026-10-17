// Итог по сайту компании: к какой группе она относится и какие проблемы найдены.
// Используется для вкладок-фильтров над таблицей, а на этапе «горячести» — для подсчёта баллов.
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
 *   problems — понятные причины, почему компании нужен (новый) сайт.
 */
export function siteStatus(company, { now = new Date() } = {}) {
  if (!company.website) return { group: 'none', label: 'Сайта нет', problems: ['нет сайта'] };

  const kind = classifyLink(company.website);
  if (kind.kind !== 'site') {
    return { group: 'none', label: `Только ${kind.label}`, problems: [`вместо сайта — ${kind.label}`] };
  }

  const check = company.site_check;
  if (!check) return { group: 'unchecked', label: 'Сайт не проверен', problems: [] };

  switch (check.status) {
    case 'ok':
      break;
    case 'parked':
      return problem('Заглушка вместо сайта', 'вместо сайта — заглушка регистратора');
    case 'dns':
      return problem('Домен не существует', 'домен сайта не существует или не продлён');
    case 'redirect_away':
      return problem(check.note || 'Переадресует на соцсеть', (check.note || 'сайт переадресует на соцсеть').toLowerCase());
    case 'timeout':
      return problem('Не открывается', 'сайт не открывается (не ответил за 10 секунд)');
    case 'refused':
    case 'reset':
    case 'tls':
      return problem('Не открывается', (check.note || 'сайт не открывается').toLowerCase());
    case 'http_error':
      // 403/429/503 часто означают защиту от ботов: сайт может нормально открываться у людей.
      if ([401, 403, 405, 406, 429, 503].includes(check.http_status)) {
        return { group: 'unchecked', label: 'Проверь вручную', problems: [] };
      }
      return problem('Сайт с ошибкой', `сайт отвечает ошибкой ${check.http_status}`);
    case 'blocked':
    case 'not_site':
      return { group: 'unchecked', label: 'Не проверялся', problems: [] };
    default:
      return problem('Не открывается', 'сайт не открылся у программы — проверь вручную');
  }

  const problems = [];
  if (check.free_host) problems.push(`сайт на бесплатном адресе конструктора (${check.free_host})`);
  if (!check.https) problems.push('нет HTTPS — браузер пишет «Не защищено»');
  if (check.mobile === false) problems.push('нет мобильной версии');
  if (check.copyright_year && check.copyright_year <= now.getFullYear() - OLD_YEARS) {
    problems.push(`© ${check.copyright_year} — сайт давно не обновляли`);
  }
  if (check.response_ms > SLOW_MS) problems.push('медленно открывается');

  return problems.length > 0
    ? { group: 'problem', label: 'Есть проблемы', problems }
    : { group: 'ok', label: 'Сайт в порядке', problems: [] };
}

function problem(label, reason) {
  return { group: 'problem', label, problems: [reason] };
}
