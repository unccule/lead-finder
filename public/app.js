// Логика страницы: загрузка списка, отправка формы, вывод таблицы.
//
// Главное правило безопасности: данные компаний выводим только как ТЕКСТ —
// через textContent или append('строка'), и никогда через innerHTML.
// Тогда даже «<script>…</script>» из скопированной карточки покажется буквами и не выполнится.
import { FIELDS, PHONE_ERROR, validateCompany } from '/shared/validate-company.js';
import { SOURCE_LABELS, normalizePhone, normalizeUrl, parseMapLink } from '/shared/normalize.js';

const form = document.getElementById('company-form');
const submitButton = form.querySelector('button[type="submit"]');
const formMessage = document.getElementById('form-message');
const cardHint = document.getElementById('card-url-hint');
const table = document.getElementById('companies-table');
const tbody = document.getElementById('companies-body');
const countLabel = document.getElementById('companies-count');
const listStatus = document.getElementById('list-status');

let companies = [];

// form.elements.namedItem('name'), а не form.name: у самой формы тоже есть свойство name.
const field = (name) => form.elements.namedItem(name);

form.addEventListener('submit', onSubmit);
form.addEventListener('reset', () => {
  clearErrors();
  showMessage('');
  setTimeout(updateCardHint); // значения полей очищаются сразу после события reset
});
field('card_url').addEventListener('input', updateCardHint);
field('phone').addEventListener('blur', onPhoneBlur);
for (const name of Object.keys(FIELDS)) {
  field(name).addEventListener('input', () => clearError(name));
}

updateCardHint();
loadCompanies();

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
  clearErrors();
  showMessage('');

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
  form.reset();
  field('city').value = keep.city;
  field('category').value = keep.category;

  showMessage(`Сохранено: ${company.name}`, 'success');
  field('name').focus();
}

// ---------- Подсказки в форме ----------

function onPhoneBlur() {
  const input = field('phone');
  const phone = normalizePhone(input.value);
  if (phone === null) {
    showErrors({ phone: PHONE_ERROR }, { focus: false });
  } else if (phone) {
    input.value = phone; // сразу показываем, в каком виде номер сохранится
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

// ---------- Таблица ----------

function renderTable() {
  countLabel.textContent = String(companies.length);
  table.hidden = companies.length === 0;
  listStatus.hidden = companies.length > 0;
  listStatus.textContent = 'Пока пусто. Добавь первую компанию через форму выше.';
  tbody.replaceChildren(...companies.map(companyRow));
}

function companyRow(company) {
  const row = document.createElement('tr');
  row.dataset.id = String(company.id);

  const cardLabel = company.source === 'other' ? 'Ссылка' : SOURCE_LABELS[company.source];
  const noteCell = cell('Заметка', company.note);
  noteCell.classList.add('note');

  row.append(
    cell('Добавлена', formatDate(company.created_at)),
    cell('Компания', textElement('strong', company.name), company.category && textElement('span', company.category, 'sub')),
    cell('Адрес', [company.city, company.address].filter(Boolean).join(', ')),
    cell('Телефон', company.phone && link(`tel:${company.phone}`, company.phone, 'nowrap')),
    cell('Сайт / соцсеть', company.website && externalLink(company.website, shortUrl(company.website))),
    cell('Карточка', company.card_url && externalLink(company.card_url, `${cardLabel} ↗`)),
    cell('Рейтинг', ratingText(company)),
    noteCell,
  );
  return row;
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

function externalLink(url, text) {
  // Ещё одна страховка: ссылкой делаем только http(s)-адреса.
  if (!/^https?:\/\//i.test(url)) return textElement('span', url);
  const a = link(url, text);
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

// ---------- Форматирование ----------

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
