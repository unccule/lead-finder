// «Горячесть» клиента 0–100: насколько компании нужен сайт и насколько легко до неё достучаться.
// Каждый балл объясняется причиной — так видно, почему у компании 75, а не 40,
// и потом эти же причины пойдут в текст персонального предложения.
//
// Правила подсчёта собраны в таблицах ниже: чтобы поменять вес причины, достаточно поправить число.
import { classifyLink } from './link-kinds.js';
import { siteStatus } from './site-status.js';

/** Баллы за состояние сайта (по коду проблемы из site-status.js). */
const SITE_POINTS = {
  dns: 65,           // платили за сайт, а домен умер — знают цену сайта и уже его лишились
  parked: 65,
  not_opening: 60,
  redirect_away: 60,
  http_error: 55,
  only_link: { social: 60, linkpage: 60, directory: 55, short: 50, map: 50, service: 50 },
  no_site: 60,       // главная цель поиска: с телефоном это уже «горячий» (60 + 10)
  free_host: 25,
  no_mobile: 25,
  no_https: 15,
  old_copyright: 15,
  slow: 10,
};
const MAX_FOR_SITE_PROBLEMS = 70; // у работающего сайта проблемы не должны «перевесить» мёртвый сайт
const UNCHECKED_POINTS = 15;

/** Уровни горячести. */
export const HEAT_LEVELS = [
  { id: 'hot', label: 'Горячий', min: 70 },
  { id: 'warm', label: 'Тёплый', min: 40 },
  { id: 'cold', label: 'Холодный', min: 0 },
];

/**
 * Оценивает компанию. Возвращает:
 *   score   — 0–100;
 *   level   — { id, label } из HEAT_LEVELS;
 *   reasons — [{ points, text }] по убыванию баллов (points = 0 — просто пояснение);
 *   site    — итог по сайту из siteStatus (для вкладок и подписи в таблице).
 */
export function assessCompany(company, { now = new Date() } = {}) {
  const site = siteStatus(company, { now });
  const reasons = [];

  // 1. Сайт — главное.
  if (site.group === 'unchecked') {
    reasons.push(reason(UNCHECKED_POINTS, 'сайт ещё не проверен — нажми «Проверить сайты»'));
  } else if (site.group === 'ok') {
    reasons.push(reason(0, 'сайт в порядке'));
  } else {
    let sitePoints = 0;
    for (const problem of site.problems) {
      const rule = SITE_POINTS[problem.code];
      const points = typeof rule === 'object' ? (rule[problem.kind] ?? 50) : (rule ?? 0);
      const allowed = Math.min(points, Math.max(0, MAX_FOR_SITE_PROBLEMS - sitePoints));
      sitePoints += allowed;
      reasons.push(reason(allowed, problem.text));
    }
  }

  // 2. Можно ли связаться.
  if (company.phone) reasons.push(reason(10, 'есть рабочий телефон'));
  const messenger = messengerLabel(company);
  if (messenger) reasons.push(reason(5, `можно написать: ${messenger}`));

  // 3. Живой ли бизнес: отзывы и рейтинг (есть у компаний, добавленных из карточек 2ГИС и Яндекса).
  if (company.reviews_count >= 50) reasons.push(reason(10, `много отзывов (${company.reviews_count}) — бизнес живой`));
  else if (company.reviews_count >= 10) reasons.push(reason(5, `есть отзывы (${company.reviews_count})`));
  if (company.rating >= 4.5) {
    reasons.push(reason(5, `высокий рейтинг ${String(company.rating).replace('.', ',')} — дорожат репутацией`));
  }

  const score = Math.max(0, Math.min(100, reasons.reduce((sum, item) => sum + item.points, 0)));
  reasons.sort((a, b) => b.points - a.points);
  const level = HEAT_LEVELS.find((item) => score >= item.min);
  return { score, level: { id: level.id, label: level.label }, reasons, site };
}

/**
 * Порядок «сначала горячие»: по баллам, при равенстве — новые выше.
 * assessments — Map(id → результат assessCompany), чтобы не считать одно и то же дважды.
 */
export function byHotness(assessments) {
  return (a, b) => assessments.get(b.id).score - assessments.get(a.id).score || b.id - a.id;
}

/** Соцсеть или мессенджер, куда можно написать: из основной ссылки или из «других ссылок». */
function messengerLabel(company) {
  const links = [company.website, ...String(company.other_links ?? '').split('\n')].filter(Boolean);
  const found = links.map((url) => classifyLink(url)).find((link) => link.kind === 'social');
  return found?.label ?? '';
}

function reason(points, text) {
  return { points, text };
}
