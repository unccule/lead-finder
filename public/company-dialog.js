// Карточка компании: окно, где можно поправить любые поля, статус, дату следующего контакта и заметку.
// Используется встроенный в браузер элемент <dialog> — он сам затемняет фон и закрывается по Esc.
import { request } from '/api.js';
import { FIELDS, validateCompany } from '/shared/validate-company.js';
import { STATUSES } from '/shared/statuses.js';

const EXTRA_FIELDS = ['status', 'next_contact_at'];

/**
 * Подключает карточку. onSaved(company) вызывается после успешного сохранения.
 * Возвращает { open(id) }.
 */
export function initCompanyDialog({ onSaved }) {
  const dialog = document.getElementById('company-dialog');
  const form = document.getElementById('dlg-form');
  const title = document.getElementById('dlg-title');
  const history = document.getElementById('dlg-history');
  const message = document.getElementById('dlg-message');
  const saveButton = form.querySelector('button[type="submit"]');
  const field = (name) => form.elements.namedItem(name);
  let currentId = null;

  field('status').append(...STATUSES.map(({ id, label }) => new Option(label, id)));
  for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', save);
  form.addEventListener('input', (event) => {
    if (event.target.name) clearError(event.target.name);
  });

  async function open(id) {
    const { ok, data } = await request('GET', `/api/companies/${Number(id)}`);
    if (!ok) return { ok: false, error: data.error };

    currentId = data.company.id;
    clearErrors();
    showMessage('');
    title.textContent = data.company.name;
    for (const name of [...Object.keys(FIELDS), ...EXTRA_FIELDS]) {
      const value = data.company[name];
      field(name).value = value === null || value === undefined ? '' : String(value);
    }
    renderHistory(data.company, data.history);
    dialog.showModal();
    field('status').focus();
    return { ok: true };
  }

  async function save(event) {
    event.preventDefault();
    clearErrors();
    showMessage('');
    const input = Object.fromEntries(new FormData(form));

    // Первая проверка — сразу здесь; сервер всё равно проверит заново.
    const check = validateCompany(input);
    if (!check.ok) return showErrors(check.errors);

    saveButton.disabled = true;
    try {
      const { ok, status, data } = await request('PATCH', `/api/companies/${currentId}`, input);
      if (ok) {
        dialog.close();
        onSaved(data.company);
      } else if (status === 409) {
        showMessage(data.error, 'warning');
      } else {
        if (data.fields) showErrors(data.fields);
        showMessage(data.error || 'Не получилось сохранить', 'error');
      }
    } finally {
      saveButton.disabled = false;
    }
  }

  function renderHistory(company, items) {
    const lines = [`Добавлена ${formatDateTime(company.created_at)}`,
      ...items.map((item) => `${formatDateTime(item.changed_at)} — ${item.label}`)];
    const list = document.createElement('ul');
    list.append(...lines.map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }));
    const heading = document.createElement('p');
    heading.className = 'found-title';
    heading.textContent = 'История';
    history.replaceChildren(heading, list);
  }

  function showErrors(errors) {
    let first = null;
    for (const [name, text] of Object.entries(errors)) {
      const box = document.getElementById(`dlg-err-${name}`);
      if (!box || !field(name)) continue;
      box.textContent = text;
      box.hidden = false;
      field(name).setAttribute('aria-invalid', 'true');
      first ??= field(name);
    }
    first?.focus();
  }

  function clearError(name) {
    const box = document.getElementById(`dlg-err-${name}`);
    if (box) {
      box.textContent = '';
      box.hidden = true;
    }
    field(name)?.removeAttribute('aria-invalid');
  }

  function clearErrors() {
    for (const name of [...Object.keys(FIELDS), ...EXTRA_FIELDS]) clearError(name);
  }

  function showMessage(text, kind = '') {
    message.textContent = text;
    message.className = `message dialog-message ${kind}`;
    message.hidden = !text;
  }

  return { open };
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
