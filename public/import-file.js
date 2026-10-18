// Загрузка списка компаний из файла CSV: выбрать файл → посмотреть, что распознано → загрузить.
// Файл читается здесь, в браузере; на сервер уходят только данные компаний из понятных столбцов.
import { request } from '/api.js';
import { decodeFile, parseCsv, rowsToCompanies } from '/shared/import-csv.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FIELD_TITLES = {
  name: 'название', category: 'сфера', city: 'город', address: 'адрес', phone: 'телефон', website: 'сайт',
  other_links: 'другие ссылки', card_url: 'ссылка на карточку', rating: 'рейтинг', reviews_count: 'отзывы',
  note: 'заметка', status: 'статус', next_contact_at: 'дата контакта',
};

/** onImported() вызывается после загрузки, чтобы обновить таблицу. */
export function initImportFile({ onImported }) {
  const input = document.getElementById('import-file');
  const box = document.getElementById('import-result');

  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = ''; // чтобы тот же файл можно было выбрать ещё раз
    if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) {
      return show([text('p', 'Это файл Excel. Открой его в Excel и сохрани как CSV: «Файл → Сохранить как → CSV UTF-8». Потом загрузи CSV.', 'paste-warning')]);
    }
    if (file.size > MAX_FILE_BYTES) return show([text('p', 'Файл больше 5 МБ — раздели его на части.', 'paste-warning')]);

    const parsed = rowsToCompanies(parseCsv(decodeFile(new Uint8Array(await file.arrayBuffer()))));
    if (parsed.error) return show([text('p', `${file.name}: ${parsed.error}`, 'paste-warning')]);
    preview(file.name, parsed);
  });

  function preview(fileName, parsed) {
    const recognized = Object.entries(parsed.columns).map(([field, title]) => `${title} → ${FIELD_TITLES[field]}`);
    const blocks = [
      text('p', `${fileName}: строк с компаниями — ${parsed.companies.length}.`, 'osm-place'),
      text('p', `Распознаны столбцы: ${recognized.join(', ')}.`),
    ];
    if (parsed.ignored.length > 0) {
      blocks.push(text('p', `Не загружаю (храним только данные компании): ${parsed.ignored.join(', ')}.`, 'hint'));
    }
    const count = parsed.companies.length;
    const button = text('button', `Загрузить ${count} ${plural(count, 'компанию', 'компании', 'компаний')}`, 'btn-primary');
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      const { ok, data } = await request('POST', '/api/companies/import', { companies: parsed.companies });
      if (!ok) {
        button.disabled = false;
        return show([...blocks, text('p', data.error || 'Не получилось загрузить', 'paste-warning')]);
      }
      const result = [text('p', `Готово: добавлено ${data.added}, уже были в базе ${data.duplicates}` +
        (data.invalid > 0 ? `, пропущено из-за ошибок ${data.invalid}.` : '.'), 'paste-summary')];
      if (data.problems.length > 0) {
        const list = document.createElement('ul');
        list.className = 'problem-list';
        list.append(...data.problems.map((problem) => text('li', `строка ${problem.row}: ${problem.error}`)));
        result.push(list);
      }
      show(result);
      onImported();
    });
    blocks.push(button);
    show(blocks);
  }

  function show(blocks) {
    box.replaceChildren(...blocks);
    box.hidden = false;
  }
}

/** Русское склонение после числа: 1 компанию, 3 компании, 5 компаний, 21 компанию, 12 компаний. */
function plural(n, one, few, many) {
  const last = n % 10;
  const lastTwo = n % 100;
  if (last === 1 && lastTwo !== 11) return one;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return few;
  return many;
}

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}
