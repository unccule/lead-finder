// Черновик персонального предложения. Текст собирается из того, что программа узнала о компании:
// нет сайта / только ВК / сайт не открывается / нет мобильной версии… — и из сферы бизнеса.
// Программа ничего не отправляет: ты копируешь текст, при желании правишь и отправляешь сам.
import { classifyLink } from './link-kinds.js';

/** Что сайт даст бизнесу этой сферы — подставляется в текст предложения. */
// Порядок важен: «барбершоп» должен попасть в красоту раньше, чем «бар» в общепит.
const BENEFITS = [
  [/салон|барбер|парикмах|ногт|маникюр|тату|массаж|красот/i, 'прайс, фото работ мастеров и онлайн-запись'],
  [/ресторан|кафе|кофейн|пекарн|доставк|(^|[\s,])бары?($|[\s,])/i, 'меню с ценами и фото, бронирование столика и заказ доставки'],
  [/шиномонтаж|автосервис|автомойк|детейлинг|авто/i, 'цены на услуги, онлайн-запись на удобное время и кнопку «позвонить»'],
  [/стомат|медиц|клиник|врач/i, 'услуги и цены, информацию о врачах и запись на приём'],
  [/фитнес|спорт/i, 'расписание, абонементы с ценами и запись на пробное занятие'],
  [/ветклиник|зоо/i, 'услуги и цены, запись к ветеринару и контакты'],
  [/гостиниц|хостел|отел/i, 'фото номеров, цены и бронирование без посредников'],
  [/цвет/i, 'каталог букетов с ценами и заказ с доставкой'],
  [/курс|школ|образован/i, 'программу, расписание, цены и запись на занятие'],
  [/магазин/i, 'каталог товаров с ценами, адрес и часы работы'],
];
const DEFAULT_BENEFITS = 'услуги и цены, контакты, кнопку «позвонить» и форму заявки';

/** Почему это важно — по главной проблеме. */
const WHY = {
  none: 'Многие клиенты сначала ищут в Яндексе, смотрят цены и отзывы — и выбирают тех, у кого есть понятный сайт.',
  dead: 'Клиенты, которые переходят по ссылке из карт, видят ошибку и уходят к конкурентам.',
  weak: 'Сейчас больше половины людей заходят с телефона — неудобный или «устаревший» сайт они просто закрывают.',
  ok: 'Хороший сайт можно сделать ещё полезнее: чтобы он приводил заявки, а не просто был.',
};

/**
 * Собирает текст предложения.
 *   company    — компания из базы;
 *   assessment — результат assessCompany (там site.problems с кодами проблем);
 *   sender     — твоя подпись: { sender_name, sender_contact, portfolio_url } (всё необязательно);
 *   variant    — 'short' (мессенджер) или 'long' (почта).
 */
export function buildOffer(company, assessment, sender = {}, { variant = 'short' } = {}) {
  // «Ромашка» → «Ромашка»; а «Кафе «Компот»» уже с кавычками — вторые не добавляем.
  const name = /[«»"]/.test(company.name) ? company.name.trim() : `«${company.name.trim()}»`;
  const benefits = benefitsFor(company.category);
  const { observations, kind } = observe(company, assessment);
  const intro = sender.sender_name
    ? `Меня зовут ${sender.sender_name.trim()}, я делаю сайты и лендинги для малого бизнеса.`
    : 'Я делаю сайты и лендинги для малого бизнеса.';
  const signature = signatureLines(sender);

  if (variant === 'long') {
    const lines = [
      'Здравствуйте!',
      '',
      intro,
      '',
      observations.length > 0
        ? `Посмотрел, как ${name} выглядит в интернете, и заметил:`
        : `Посмотрел, как ${name} выглядит в интернете.`,
      ...observations.map((text) => `— ${capitalize(text)};`.replace(/;$/, observations.at(-1) === text ? '.' : ';')),
      '',
      WHY[kind],
      '',
      `Могу сделать для вас современный сайт: ${benefits}. Он будет удобно открываться с телефона, ` +
        'работать по защищённому адресу (https) и находиться в Яндексе и Google.',
      '',
      'Если интересно, пришлю 2–3 примера похожих работ и примерную стоимость. Удобно будет обсудить?',
      ...(signature.length > 0 ? ['', 'С уважением,', ...signature] : []),
    ];
    return lines.join('\n');
  }

  const observation = observations.length > 0
    ? `Нашёл ${name} на карте и заметил: ${observations.slice(0, 2).join(', а ещё ')}.`
    : `Нашёл ${name} на карте.`;
  const lines = [
    `Здравствуйте! ${intro}`,
    observation,
    `Могу сделать для вас современный сайт: ${benefits}, удобный с телефона. ` +
      'Если интересно — пришлю примеры работ и цену.',
    ...(signature.length > 0 ? ['', ...signature] : []),
  ];
  return lines.join('\n');
}

/** Что мы заметили — короткими фразами — и какого рода главная проблема (для фразы «почему важно»). */
function observe(company, assessment) {
  const site = assessment.site;
  const domain = displayDomain(company.website);
  const observations = [];
  let kind = 'ok';

  for (const problem of site.problems) {
    switch (problem.code) {
      case 'no_site':
        observations.push('сайта у вас нет — только карточка на карте');
        kind = 'none';
        break;
      case 'only_link': {
        const label = classifyLink(company.website).label;
        observations.push(problem.kind === 'linkpage'
          ? `вместо сайта у вас ${label} — он выглядит как шаблон и почти не находится в поиске`
          : `вместо сайта у вас только страница ${place(problem.kind, label)}` +
            ' — её почти не показывают поисковики, а новым клиентам неудобно искать цены');
        kind = 'none';
        break;
      }
      case 'dns':
        observations.push(`ваш сайт ${domain} не открывается — похоже, не продлён домен`);
        kind = 'dead';
        break;
      case 'parked':
        observations.push(`по адресу ${domain} вместо сайта открывается заглушка`);
        kind = 'dead';
        break;
      case 'not_opening':
        observations.push(`сайт ${domain} сейчас не открывается`);
        kind = 'dead';
        break;
      case 'http_error':
        observations.push(`сайт ${domain} открывается с ошибкой`);
        kind = 'dead';
        break;
      case 'redirect_away':
        observations.push(`сайт ${domain} перебрасывает на соцсеть вместо своей страницы`);
        kind = 'dead';
        break;
      case 'no_mobile':
        observations.push('сайт неудобно открывать с телефона — нет мобильной версии');
        kind = kind === 'ok' ? 'weak' : kind;
        break;
      case 'free_host':
        observations.push('сайт на бесплатном адресе конструктора — со стороны это выглядит несерьёзно');
        kind = kind === 'ok' ? 'weak' : kind;
        break;
      case 'no_https':
        observations.push('браузер помечает сайт как «Не защищено»');
        kind = kind === 'ok' ? 'weak' : kind;
        break;
      case 'old_copyright':
        observations.push(`сайт давно не обновлялся (внизу стоит © ${company.site_check?.copyright_year ?? 'старый год'})`);
        kind = kind === 'ok' ? 'weak' : kind;
        break;
      case 'slow':
        observations.push('сайт долго загружается');
        kind = kind === 'ok' ? 'weak' : kind;
        break;
      default:
        break;
    }
  }
  return { observations, kind };
}

function benefitsFor(category) {
  return BENEFITS.find(([pattern]) => pattern.test(category ?? ''))?.[1] ?? DEFAULT_BENEFITS;
}

/** Где страница: «во ВКонтакте», «в Telegram», «на Авито». */
function place(kind, label) {
  if (kind === 'directory') return `на ${label}`;
  return label === 'ВКонтакте' ? 'во ВКонтакте' : `в ${label}`;
}

function displayDomain(url) {
  return String(url ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '') || 'ваш сайт';
}

function signatureLines(sender) {
  return [
    sender.sender_name?.trim(),
    sender.sender_contact?.trim(),
    sender.portfolio_url?.trim() ? `Примеры работ: ${sender.portfolio_url.trim()}` : '',
  ].filter(Boolean);
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
