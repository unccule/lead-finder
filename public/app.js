// Логика страницы: быстрая вставка, загрузка списка, отправка формы, вывод таблицы.
//
// Главное правило безопасности: данные компаний выводим только как ТЕКСТ —
// через textContent или append('строка'), и никогда через innerHTML.
// Тогда даже «<script>…</script>» из скопированной карточки покажется буквами и не выполнится.
import { FIELDS, PHONE_ERROR, validateCompany } from '/shared/validate-company.js';
import { SOURCE_LABELS, normalizePhone, normalizeUrl, parseMapLink } from '/shared/normalize.js';
import { classifyLink, linkKey } from '/shared/link-kinds.js';
import { parseCardText } from '/shared/parse-card.js';
import { SITE_GROUPS } from '/shared/site-status.js';
import { assessCompany, byHotness } from '/shared/hotness.js';
import { initAutoSearch, request } from '/auto-search.js';

const form = document.getElementById('company-form');
const submitButton = form.querySelector('button[type="submit"]');
const formMessage = document.getElementById('form-message');
const cardHint = document.getElementById('card-url-hint');
const cardText = document.getElementById('card-text');
const pasteResult = document.getElementById('paste-result');
const table = document.getElementById('companies-table');
const tbody = document.getElementById('companies-body');
const countLabel = document.getElementById('companies-count');
const listStatus = document.getElementById('list-status');
const filterTabs = document.getElementById('filter-tabs');
const checkButton = document.getElementById('check-sites');
const recheckButton = document.getElementById('recheck-sites');
const checkStatus = document.getElementById('check-status');
const sortSelect = document.getElementById('sort-order');

let companies = [];
let filter = 'all'; // какая вкладка над таблицей выбрана: 'all' или ключ из SITE_GROUPS

// Быстрая вставка: HTML из буфера обмена, результат разбора и короткий итог «что заполнил».
const paste = { html: '', result: null, summary: '' };
// Поле → значение, которое подставила программа. Пока ты его не поменял, следующая вставка
// может его заменить; то, что ты ввёл сам, программа не трогает.
const autoFilled = {};

// Какие поля умеет заполнять быстрая вставка и как они называются в форме.
const FILL_FIELDS = {
  phone: 'Рабочий телефон',
  website: 'Сайт или соцсеть',
  other_links: 'Соцсети и другие ссылки',
  card_url: 'Ссылка на карточку',
};

// form.elements.namedItem('name'), а не form.name: у самой формы тоже есть свойство name.
const field = (name) => form.elements.namedItem(name);

form.addEventListener('submit', onSubmit);
form.addEventListener('reset', onReset);
form.addEventListener('input', onFormInput);
cardText.addEventListener('paste', (event) => {
  // Кроме текста, браузер кладёт в буфер HTML — в нём видны адреса у иконок соцсетей и tel:-ссылки.
  paste.html = event.clipboardData?.getData('text/html') ?? '';
});
const analyzeSoon = debounce(analyzeCardText, 300);
cardText.addEventListener('input', (event) => {
  analyzeSoon();
  // Вставку (Ctrl+V) разбираем сразу, а набор текста руками — когда пауза в печати.
  if (event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') analyzeSoon.flush();
});
field('card_url').addEventListener('input', updateCardHint);
field('phone').addEventListener('blur', onPhoneBlur);
sortSelect.addEventListener('change', renderTable);
checkButton.addEventListener('click', () => startSiteChecks('new'));
recheckButton.addEventListener('click', () => startSiteChecks('all'));

initAutoSearch({
  onImported: async (summary) => {
    filter = 'all';
    await loadCompanies();
    if (summary.site_check_started) watchSiteChecks();
  },
});
updateCardHint();
loadCompanies().then(refreshSiteChecks);

// ---------- Загрузка и сохранение ----------

async function loadCompanies() {
  try {
    const response = await fetch('/api/companies');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    companies = (await response.json()).companies;
    renderTable();
  } catch {
    listStatus.textContent = 'Не получилось загрузить список. Проверь, что окно Lead Finder открыто, и обнови страницу.';
    listStatus.classList.add('is-error');
  }
}

async function onSubmit(event) {
  event.preventDefault();

  // Текст вставки ещё не разобран (нажали «Сохранить» сразу после ввода)? Сначала разбираем
  // и показываем результат, а сохранить даём следующим нажатием — подтверждение за тобой.
  if (analyzeSoon.flush()) {
    showMessage('Заполнил поля из вставленного текста — проверь их и нажми «Сохранить» ещё раз.', 'warning');
    return;
  }

  clearErrors();
  showMessage('');

  // В отправку попадают только поля с атрибутом name. У поля быстрой вставки его нет.
  const input = Object.fromEntries(new FormData(form));

  // Первая проверка — здесь, в браузере: мгновенно показываем, что исправить.
  // Сервер всё равно проверит данные заново: он не доверяет тому, что пришло из браузера.
  const check = validateCompany(input);
  if (!check.ok) {
    showErrors(check.errors);
    return;
  }

  submitButton.disabled = true;
  try {
    const response = await fetch('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const result = await response.json().catch(() => ({}));

    if (response.status === 201) {
      onSaved(result.company);
    } else if (response.status === 409) {
      showMessage(result.error, 'warning');
      highlightRow(result.existing?.id);
    } else {
      if (result.fields) showErrors(result.fields);
      showMessage(result.error || `Сервер ответил ошибкой ${response.status}`, 'error');
    }
  } catch {
    showMessage('Нет связи с сервером. Проверь, что окно Lead Finder открыто, и попробуй ещё раз.', 'error');
  } finally {
    submitButton.disabled = false;
  }
}

function onSaved(company) {
  companies.unshift(company);
  renderTable();
  highlightRow(company.id);

  // Город и сферу оставляем: обычно подряд добавляешь компании из одного города и одной сферы.
  const keep = { city: field('city').value, category: field('category').value };
  form.reset(); // очищает и поле быстрой вставки
  field('city').value = keep.city;
  field('category').value = keep.category;

  showMessage(`Сохранено: ${company.name}`, 'success');
  cardText.focus(); // следующую карточку можно сразу вставлять
}

function onReset() {
  analyzeSoon.cancel();
  clearErrors();
  showMessage('');
  paste.html = '';
  paste.result = null;
  paste.summary = '';
  for (const name of Object.keys(autoFilled)) forgetAutofill(name);
  renderPasteResult();
  setTimeout(updateCardHint); // значения полей очищаются сразу после события reset
}

function onFormInput(event) {
  const name = event.target.name;
  if (!name || !Object.hasOwn(FIELDS, name)) return; // поле вставки разбирается отдельно
  clearError(name);
  // Поправил подставленное значение руками — теперь это твоё значение, вставка его не тронет.
  if (Object.hasOwn(autoFilled, name) && event.target.value !== autoFilled[name]) forgetAutofill(name);
  if (paste.result) renderPasteResult();
}

// ---------- Быстрая вставка ----------

function analyzeCardText() {
  if (!cardText.value.trim()) {
    paste.html = '';
    paste.result = null;
    paste.summary = '';
    renderPasteResult();
    return;
  }
  paste.result = parseCardText(cardText.value, { html: paste.html });
  paste.summary = applyFill(paste.result.fill);
  renderPasteResult();
}

/** Подставляет найденное в форму. Возвращает короткий итог для показа. */
function applyFill(fill) {
  const filled = [];
  const kept = [];
  for (const [name, title] of Object.entries(FILL_FIELDS)) {
    const value = Array.isArray(fill[name]) ? fill[name].join('\n') : (fill[name] ?? '');
    const input = field(name);
    const current = input.value.trim();

    // Пишем в поле, только если оно пустое или его заполнила прошлая вставка.
    if (current === '' || input.value === autoFilled[name]) {
      input.value = value;
      clearError(name);
      if (value) {
        autoFilled[name] = value;
        input.classList.add('is-autofilled');
        filled.push(title);
      } else {
        forgetAutofill(name);
      }
    } else if (value && current !== value) {
      kept.push(title);
    }
  }
  updateCardHint();

  const parts = [filled.length > 0
    ? `Заполнил: ${filled.join(', ')}. Проверь подсвеченные поля.`
    : 'Новых данных для полей не нашёл.'];
  if (kept.length > 0) parts.push(`Поля, которые ты заполнил сам, не трогал: ${kept.join(', ')}.`);
  return parts.join(' ');
}

function forgetAutofill(name) {
  delete autoFilled[name];
  field(name).classList.remove('is-autofilled');
}

function renderPasteResult() {
  const result = paste.result;
  pasteResult.hidden = !result;
  if (!result) {
    pasteResult.replaceChildren();
    return;
  }

  const nothingFound = result.phones.length === 0 && result.links.length === 0;
  const blocks = [textElement('p', nothingFound ? 'Не нашёл ни телефонов, ни ссылок.' : paste.summary, 'paste-summary')];
  if (result.phoneHidden) {
    blocks.push(textElement('p',
      'Похоже, телефон в карточке скрыт. Нажми в карточке «Показать телефон» и скопируй текст ещё раз.',
      'paste-warning'));
  }
  if (result.phones.length > 0) blocks.push(foundGroup('Телефоны', result.phones.map(phoneItem)));
  if (result.links.length > 0) blocks.push(foundGroup('Ссылки', result.links.map(linkItem)));
  pasteResult.replaceChildren(...blocks);
}

function foundGroup(title, items) {
  const group = document.createElement('div');
  const list = document.createElement('ul');
  list.className = 'found-list';
  list.append(...items);
  group.append(textElement('p', title, 'found-title'), list);
  return group;
}

function phoneItem(phone) {
  const inForm = normalizePhone(field('phone').value) === phone;
  return foundItem(
    textElement('span', phone, 'found-value'),
    inForm ? foundStatus('в форме') : actionButton('Подставить', () => setField('phone', phone)),
  );
}

function linkItem(link) {
  const badge = link.kind === 'map' ? `${link.label} · ID ${link.sourceId}` : link.kind === 'site' ? 'Сайт' : link.label;
  const parts = [
    textElement('span', badge, `badge ${link.kind}`),
    externalLink(link.url, shortUrl(link.url), 'found-value'),
  ];

  const place = linkPlace(link.url);
  if (place) parts.push(foundStatus(`в поле «${place}»`));

  if (link.kind === 'map') {
    if (!place) parts.push(actionButton('В «Ссылку на карточку»', () => setField('card_url', link.url)));
  } else {
    if (place !== FILL_FIELDS.website) parts.push(actionButton('В «Сайт»', () => makeMainLink(link.url)));
    if (!place) parts.push(actionButton('В «Другие ссылки»', () => addOtherLink(link.url)));
  }
  return foundItem(...parts);
}

/** В каком поле формы сейчас стоит эта ссылка ('' — ни в каком). */
function linkPlace(url) {
  const key = linkKey(url);
  if (key === linkKey(field('website').value)) return FILL_FIELDS.website;
  if (key === linkKey(field('card_url').value)) return FILL_FIELDS.card_url;
  if (otherLinks().some((other) => linkKey(other) === key)) return FILL_FIELDS.other_links;
  return '';
}

function otherLinks() {
  return field('other_links').value.split(/\s+/).filter(Boolean);
}

/** Делает ссылку основной («Сайт»), а прежнюю основную переносит в «Другие ссылки». */
function makeMainLink(url) {
  const previous = field('website').value.trim();
  const others = otherLinks().filter((other) => linkKey(other) !== linkKey(url));
  if (previous && linkKey(previous) !== linkKey(url)) others.unshift(previous);
  setField('other_links', others.join('\n'));
  setField('website', url);
}

function addOtherLink(url) {
  setField('other_links', [...otherLinks(), url].join('\n'));
}

/** Значение, выбранное тобой кнопкой, считается твоим: следующая вставка его не заменит. */
function setField(name, value) {
  field(name).value = value;
  forgetAutofill(name);
  clearError(name);
  if (name === 'card_url') updateCardHint();
  renderPasteResult();
}

function foundItem(...parts) {
  const item = document.createElement('li');
  item.className = 'found-item';
  item.append(...parts);
  return item;
}

function foundStatus(text) {
  return textElement('span', `✓ ${text}`, 'found-status');
}

function actionButton(text, onClick) {
  const button = textElement('button', text, 'btn-small');
  button.type = 'button'; // обычная кнопка, а не «отправить форму»
  button.addEventListener('click', onClick);
  return button;
}

// ---------- Подсказки в форме ----------

function onPhoneBlur() {
  const input = field('phone');
  const phone = normalizePhone(input.value);
  if (phone === null) {
    showErrors({ phone: PHONE_ERROR }, { focus: false });
  } else if (phone && phone !== input.value) {
    input.value = phone; // сразу показываем, в каком виде номер сохранится
    forgetAutofill('phone');
  }
}

function updateCardHint() {
  const value = field('card_url').value.trim();
  if (!value) {
    cardHint.textContent = 'Скопируй адрес карточки из браузера — источник и ID определятся сами.';
    return;
  }
  const url = normalizeUrl(value);
  if (!url) {
    cardHint.textContent = 'Пока не похоже на ссылку.';
    return;
  }
  const { source, sourceId } = parseMapLink(url);
  if (source === 'other') {
    cardHint.textContent = 'Источник: другое (не 2ГИС и не Яндекс Карты).';
  } else if (sourceId) {
    cardHint.textContent = `Источник: ${SOURCE_LABELS[source]} · ID организации ${sourceId}`;
  } else {
    cardHint.textContent = `Источник: ${SOURCE_LABELS[source]} · в ссылке нет ID (короткая ссылка?), ` +
      'поэтому дубли проверю по названию и телефону.';
  }
}

function showErrors(errors, { focus = true } = {}) {
  let first = null;
  for (const name of Object.keys(FIELDS)) {
    if (!errors[name]) continue;
    const box = document.getElementById(`err-${name}`);
    box.textContent = errors[name];
    box.hidden = false;
    field(name).setAttribute('aria-invalid', 'true');
    first ??= field(name);
  }
  if (focus && first) {
    first.focus();
    showMessage('Проверь отмеченные поля', 'error');
  }
}

function clearError(name) {
  const box = document.getElementById(`err-${name}`);
  box.textContent = '';
  box.hidden = true;
  field(name).removeAttribute('aria-invalid');
}

function clearErrors() {
  for (const name of Object.keys(FIELDS)) clearError(name);
}

function showMessage(text, kind = '') {
  formMessage.textContent = text;
  formMessage.className = `message ${kind}`;
  formMessage.hidden = !text;
}

// ---------- Проверка сайтов ----------

let watchTimer = null; // пока идёт проверка, раз в 2 секунды спрашиваем сервер о ходе работы
let lastDone = -1;

async function startSiteChecks(scope) {
  const { ok, data } = await request('POST', '/api/site-checks', { scope });
  if (!ok) {
    checkStatus.textContent = data.error;
    return;
  }
  if (!data.running && data.total === 0) {
    checkStatus.textContent = scope === 'all' ? 'Сайтов для проверки нет.' : 'Новых сайтов для проверки нет.';
    return;
  }
  watchSiteChecks();
}

function watchSiteChecks() {
  watchTimer ??= setInterval(refreshSiteChecks, 2000);
  refreshSiteChecks();
}

async function refreshSiteChecks() {
  const { ok, data } = await request('GET', '/api/site-checks');
  if (!ok) return;

  checkButton.textContent = data.pending > 0 ? `Проверить сайты (${data.pending})` : 'Проверить сайты';
  checkButton.disabled = data.running;
  recheckButton.disabled = data.running;

  if (data.running) {
    watchTimer ??= setInterval(refreshSiteChecks, 2000); // проверку запустили до обновления страницы
    const now = data.current ? ` — сейчас ${shortUrl(data.current)}` : '';
    checkStatus.textContent = `Проверяю сайты: ${data.done} из ${data.total}${now}. Между сайтами пауза 1,5 с.`;
    if (data.done !== lastDone) {
      lastDone = data.done;
      await loadCompanies(); // свежие результаты сразу видны в таблице
    }
    return;
  }

  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
    lastDone = -1;
    checkStatus.textContent = `Проверка закончена: ${data.done} из ${data.total}.`;
    await loadCompanies();
  } else if (data.pending > 0) {
    checkStatus.textContent = `Ещё не проверено сайтов: ${data.pending}.`;
  }
}

// ---------- Таблица ----------

function renderTable() {
  // Горячесть считаем один раз на компанию и дальше берём из этой «таблички».
  const assessments = new Map(companies.map((company) => [company.id, assessCompany(company)]));
  renderTabs(assessments);

  const visible = filter === 'all'
    ? [...companies]
    : companies.filter((company) => assessments.get(company.id).site.group === filter);
  // Список с сервера уже идёт «новые сверху», поэтому для этого порядка ничего делать не нужно.
  if (sortSelect.value === 'hot') visible.sort(byHotness(assessments));

  countLabel.textContent = String(companies.length);
  table.hidden = visible.length === 0;
  listStatus.hidden = visible.length > 0;
  listStatus.textContent = companies.length === 0
    ? 'Пока пусто. Найди компании автопоиском или добавь вручную через форму выше.'
    : 'В этой вкладке пока никого нет.';
  tbody.replaceChildren(...visible.map((company) => companyRow(company, assessments.get(company.id))));
}

/** Вкладки «Все · Без сайта · Сайт с проблемами · …» с количеством в каждой. */
function renderTabs(assessments) {
  const counts = { all: companies.length };
  for (const { site } of assessments.values()) counts[site.group] = (counts[site.group] ?? 0) + 1;

  filterTabs.replaceChildren(...[['all', 'Все'], ...Object.entries(SITE_GROUPS)].map(([key, label]) => {
    const button = textElement('button', `${label} · ${counts[key] ?? 0}`, 'tab');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(filter === key));
    button.addEventListener('click', () => {
      filter = key;
      renderTable();
    });
    return button;
  }));
}

function companyRow(company, assessment) {
  const row = document.createElement('tr');
  row.dataset.id = String(company.id);

  const cardLabel = { other: 'Ссылка', osm: 'OSM' }[company.source] ?? SOURCE_LABELS[company.source];
  const noteCell = cell('Заметка', company.note);
  noteCell.classList.add('note');
  const [date] = formatDate(company.created_at).split(', ');

  row.append(
    heatCell(assessment),
    cell('Компания',
      textElement('strong', company.name),
      company.category && textElement('span', company.category, 'sub'),
      textElement('span', `добавлена ${date}`, 'sub')),
    cell('Адрес', [company.city, company.address].filter(Boolean).join(', ')),
    cell('Телефон', company.phone && link(`tel:${company.phone}`, company.phone, 'nowrap')),
    cell('Сайт / соцсети', ...websiteParts(company), siteLine(assessment.site, company.site_check)),
    cell('Карточка', company.card_url && externalLink(company.card_url, `${cardLabel} ↗`)),
    cell('Рейтинг', ratingText(company)),
    noteCell,
  );
  return row;
}

/** Основная ссылка + строка с остальными: «ВКонтакте · Telegram · Taplink». */
function websiteParts(company) {
  const parts = [];
  if (company.website) parts.push(externalLink(company.website, shortUrl(company.website)));
  const others = (company.other_links ?? '').split('\n').filter(Boolean);
  if (others.length > 0) {
    const line = document.createElement('span');
    line.className = 'sub';
    others.forEach((url, index) => {
      if (index > 0) line.append(' · ');
      line.append(externalLink(url, classifyLink(url).label));
    });
    parts.push(line);
  }
  return parts;
}

/** Ячейка «Горячесть»: балл, уровень и причины — «+60 вместо сайта — только ВКонтакте». */
function heatCell(assessment) {
  const head = document.createElement('span');
  head.className = 'heat-head';
  head.append(
    textElement('span', String(assessment.score), `heat ${assessment.level.id}`),
    textElement('span', assessment.level.label, 'heat-label'),
  );
  const reasons = document.createElement('ul');
  reasons.className = 'reasons';
  reasons.append(...assessment.reasons.map((item) =>
    textElement('li', item.points > 0 ? `+${item.points} ${item.text}` : item.text)));
  return cell('Горячесть', head, reasons);
}

/**
 * Строка под ссылками: «Есть проблемы · WordPress · 0,6 с» или «Сайт в порядке · Tilda · 0,8 с».
 * Сами проблемы с баллами — в столбце «Горячесть», здесь не повторяем.
 */
function siteLine(status, check) {
  const line = document.createElement('span');
  line.className = 'site-line';
  line.append(textElement('span', status.label, `site-badge ${status.group}`));

  const details = [];
  if (status.label === 'Проверь вручную' && check?.note) details.push(check.note);
  if (check && (check.status === 'ok' || check.status === 'parked')) {
    details.push(...[
      check.platform,
      check.response_ms != null && `${(check.response_ms / 1000).toFixed(1).replace('.', ',')} с`,
      check.page_bytes != null && formatBytes(check.page_bytes),
      status.group === 'ok' && check.copyright_year && `© ${check.copyright_year}`,
    ].filter(Boolean));
  }
  if (details.length > 0) line.append(textElement('span', details.join(' · '), 'site-facts'));
  return line;
}

function formatBytes(bytes) {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(bytes / 1000))} КБ`;
}

/** Ячейка таблицы. label — подпись, которую видно на телефоне вместо заголовка столбца. */
function cell(label, ...content) {
  const td = document.createElement('td');
  td.dataset.label = label;
  const body = document.createElement('div');
  const parts = content.filter(Boolean);
  // append('строка') вставляет именно текст — так же безопасно, как textContent.
  if (parts.length > 0) body.append(...parts);
  else body.append(textElement('span', '—', 'muted'));
  td.append(body);
  return td;
}

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function link(href, text, className) {
  const a = textElement('a', text, className);
  a.href = href;
  return a;
}

function externalLink(url, text, className) {
  // Ещё одна страховка: ссылкой делаем только http(s)-адреса.
  if (!/^https?:\/\//i.test(url)) return textElement('span', url, className);
  const a = link(url, text, className);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = url;
  return a;
}

function highlightRow(id) {
  const row = tbody.querySelector(`tr[data-id="${Number(id)}"]`);
  if (!row) return;
  row.classList.remove('flash');
  void row.offsetWidth; // перезапуск анимации, если строку подсвечивают второй раз подряд
  row.classList.add('flash');
}

// ---------- Форматирование и помощники ----------

function formatDate(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** 'https://www.romashka.ru/' → 'romashka.ru' (коротко для таблицы, полный адрес — в подсказке). */
function shortUrl(url) {
  const text = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

function ratingText(company) {
  const parts = [];
  if (company.rating !== null) parts.push(`★ ${String(company.rating).replace('.', ',')}`);
  if (company.reviews_count !== null) parts.push(`${company.reviews_count} отз.`);
  return parts.join(' · ');
}

/**
 * Запускает fn не сразу, а когда ввод затих на ms миллисекунд.
 * flush() — выполнить отложенный запуск прямо сейчас; возвращает true, если он был.
 */
function debounce(fn, ms) {
  let timer = null;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
  debounced.flush = () => {
    if (timer === null) return false;
    debounced.cancel();
    fn();
    return true;
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return debounced;
}
