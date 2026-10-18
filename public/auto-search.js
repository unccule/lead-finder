// Панель «Автопоиск»: город + сферы → поиск в OpenStreetMap → итоги → «Добавить в базу».
// Как и везде, данные выводим только как текст (textContent), без innerHTML.
import { request } from '/api.js';

/**
 * Подключает панель. onImported(summary) вызывается после добавления компаний в базу,
 * чтобы основная страница обновила таблицу и показала ход проверки сайтов.
 */
export function initAutoSearch({ onImported }) {
  const form = document.getElementById('osm-form');
  const groupsBox = document.getElementById('osm-groups');
  const submitButton = form.querySelector('button[type="submit"]');
  const status = document.getElementById('osm-status');
  const result = document.getElementById('osm-result');
  let search = null; // последний результат поиска с сервера

  loadGroups();
  form.addEventListener('submit', onSearch);

  async function loadGroups() {
    const { ok, data } = await request('GET', '/api/osm/groups');
    if (!ok) {
      showStatus('Не получилось загрузить список сфер. Обнови страницу.', 'error');
      return;
    }
    groupsBox.replaceChildren(...data.groups.map((group) => {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'groups';
      input.value = group.id;
      input.checked = group.default;
      const label = document.createElement('label');
      label.append(input, group.label);
      return label;
    }));
  }

  async function onSearch(event) {
    event.preventDefault();
    const city = form.elements.namedItem('city').value.trim();
    const groups = [...form.querySelectorAll('input[name="groups"]:checked')].map((input) => input.value);
    if (!city) return showStatus('Укажи город', 'error');
    if (groups.length === 0) return showStatus('Выбери хотя бы одну сферу', 'error');

    result.hidden = true;
    submitButton.disabled = true;
    // Поиск идёт до минуты: показываем, что программа не зависла, — с секундомером.
    const started = Date.now();
    const tick = () => showStatus(
      `Ищу компании в OpenStreetMap… ${Math.round((Date.now() - started) / 1000)} с. Обычно это занимает до минуты.`);
    tick();
    const timer = setInterval(tick, 1000);
    try {
      const { ok, data } = await request('POST', '/api/osm/search', { city, groups });
      if (!ok) return showStatus(data.error || 'Поиск не удался', 'error');
      search = data;
      showStatus('');
      renderResult();
    } finally {
      clearInterval(timer);
      submitButton.disabled = false;
    }
  }

  function renderResult() {
    const { city, total, counts, sample } = search;
    const blocks = [
      textElement('p', `Город: ${city.display}`, 'osm-place'),
      textElement('p', `Найдено компаний: ${total}. Новых без своего сайта: ${counts.new_no_site}, ` +
        `новых со своим сайтом: ${counts.new_with_site}, уже в базе: ${counts.in_base}.`),
    ];
    if (counts.excluded > 0) {
      blocks.push(textElement('p', `Не предлагаю снова ${counts.excluded}: ты удалял их из списка раньше.`, 'hint'));
    }
    if (counts.skipped_no_contacts > 0) {
      blocks.push(textElement('p', `Пропущено ${counts.skipped_no_contacts}: в OpenStreetMap у них нет ни телефона, ` +
        'ни ссылки, ни адреса (например, просто «Автомойка») — с ними не связаться и их не найти.', 'hint'));
    }

    const noSite = checkbox(`Без своего сайта (${counts.new_no_site})`, counts.new_no_site > 0);
    const withSite = checkbox(`Со своим сайтом (${counts.new_with_site}) — программа проверит, хорош ли сайт`,
      counts.new_with_site > 0);
    const choice = document.createElement('div');
    choice.className = 'checks';
    choice.append(noSite.label, withSite.label);
    blocks.push(choice);

    if (sample.length > 0) {
      const list = document.createElement('ul');
      list.className = 'sample-list';
      list.append(...sample.map((item) => textElement('li',
        [item.name, item.category, item.address, item.phone, item.website ? `только ${shortUrl(item.website)}` : '']
          .filter(Boolean).join(' · '))));
      blocks.push(textElement('p', 'Примеры без своего сайта:', 'found-title'), list);
    }

    const importButton = textElement('button', 'Добавить в базу', 'btn-primary');
    importButton.type = 'button';
    importButton.disabled = counts.new_no_site + counts.new_with_site === 0;
    importButton.addEventListener('click', async () => {
      const include = [noSite.input.checked && 'no_site', withSite.input.checked && 'with_site'].filter(Boolean);
      if (include.length === 0) return showStatus('Отметь, кого добавить', 'error');
      importButton.disabled = true;
      const { ok, data } = await request('POST', '/api/osm/import', { search_id: search.search_id, include });
      if (!ok) {
        importButton.disabled = false;
        return showStatus(data.error || 'Не получилось добавить', 'error');
      }
      result.hidden = true;
      const parts = [`Добавлено в базу: ${data.added}.`];
      if (data.duplicates > 0) parts.push(`Уже были в базе: ${data.duplicates}.`);
      if (data.invalid > 0) parts.push(`Пропущено с ошибками в данных: ${data.invalid}.`);
      if (data.site_check_started) parts.push('Запустил проверку сайтов — ход виден над таблицей.');
      showStatus(parts.join(' '), 'success');
      onImported(data);
    });
    blocks.push(importButton);

    result.replaceChildren(...blocks);
    result.hidden = false;
  }

  function showStatus(text, kind = '') {
    status.textContent = text;
    status.className = `message ${kind}`;
    status.hidden = !text;
  }
}

function checkbox(text, checked) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  const label = document.createElement('label');
  label.append(input, text);
  return { input, label };
}

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function shortUrl(url) {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
}
