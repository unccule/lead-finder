// Карточка компании: окно, где можно поправить любые поля, статус, дату следующего контакта и заметку.
// Используется встроенный в браузер элемент <dialog> — он сам затемняет фон и закрывается по Esc.
import { request } from '/api.js';
import { FIELDS, validateCompany } from '/shared/validate-company.js';
import { STATUSES, STATUS_LABELS, formatDateRu } from '/shared/statuses.js';
import { assessCompany } from '/shared/hotness.js';
import { buildOffer } from '/shared/offer.js';

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
  let current = null; // компания, открытая в карточке (как пришла с сервера)

  // ---- Черновик предложения ----
  const offerText = document.getElementById('offer-text');
  const offerStatus = document.getElementById('offer-status');
  const copyMarkButton = document.getElementById('offer-copy-mark');
  const variantButtons = [...dialog.querySelectorAll('[data-variant]')];
  const settingInputs = [...dialog.querySelectorAll('[data-setting]')];
  let variant = 'short';
  let settings = {};
  loadSettings();

  for (const button of variantButtons) {
    button.addEventListener('click', () => {
      variant = button.dataset.variant;
      renderOffer();
    });
  }
  document.getElementById('offer-copy').addEventListener('click', async () => {
    if (await copyOffer()) offerStatus.textContent = 'Скопировано — вставь в мессенджер или письмо.';
  });
  copyMarkButton.addEventListener('click', copyAndMark);
  document.getElementById('settings-save').addEventListener('click', saveSettings);

  async function loadSettings() {
    const { ok, data } = await request('GET', '/api/settings');
    if (!ok) return;
    settings = data.settings;
    for (const input of settingInputs) input.value = settings[input.dataset.setting] ?? '';
  }

  function renderOffer() {
    for (const button of variantButtons) button.setAttribute('aria-pressed', String(button.dataset.variant === variant));
    offerText.value = current ? buildOffer(current, assessCompany(current), settings, { variant }) : '';
    offerStatus.textContent = '';
    // «Отметить „Написал“» нужно только для новых компаний — остальные уже в работе.
    copyMarkButton.hidden = current?.status !== 'new';
  }

  async function copyOffer() {
    try {
      await navigator.clipboard.writeText(offerText.value);
      return true;
    } catch {
      // Запасной способ, если браузер не дал доступ к буферу обмена.
      offerText.select();
      const copied = document.execCommand('copy');
      if (!copied) offerStatus.textContent = 'Не получилось скопировать — выдели текст и нажми Ctrl+C.';
      return copied;
    }
  }

  /** Скопировать текст и сразу поставить статус «Написал» (вместе с правками в карточке, если они есть). */
  async function copyAndMark() {
    if (!(await copyOffer())) return;
    const input = { ...Object.fromEntries(new FormData(form)), status: 'contacted' };
    const { ok, data } = await request('PATCH', `/api/companies/${currentId}`, input);
    if (!ok) {
      offerStatus.textContent = `Текст скопирован, но статус не сохранился: ${data.error || 'ошибка'}`;
      if (data.fields) showErrors(data.fields);
      return;
    }
    dialog.close();
    const next = data.company.next_contact_at ? ` Напомню связаться ${formatDateRu(data.company.next_contact_at)}.` : '';
    onSaved(data.company, `Текст скопирован. ${data.company.name}: статус «${STATUS_LABELS.contacted}».${next}`);
  }

  async function saveSettings() {
    for (const input of settingInputs) clearSettingError(input.dataset.setting);
    const body = Object.fromEntries(settingInputs.map((input) => [input.dataset.setting, input.value]));
    const { ok, data } = await request('PUT', '/api/settings', body);
    if (!ok) {
      for (const [key, text] of Object.entries(data.fields ?? {})) {
        const box = document.getElementById(`set-err-${key}`);
        if (box) {
          box.textContent = text;
          box.hidden = false;
        }
      }
      return;
    }
    settings = data.settings;
    for (const input of settingInputs) input.value = settings[input.dataset.setting] ?? '';
    renderOffer();
    offerStatus.textContent = 'Подпись сохранена и добавлена в текст.';
  }

  function clearSettingError(key) {
    const box = document.getElementById(`set-err-${key}`);
    if (box) {
      box.textContent = '';
      box.hidden = true;
    }
  }

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
    current = data.company;
    clearErrors();
    showMessage('');
    title.textContent = data.company.name;
    for (const name of [...Object.keys(FIELDS), ...EXTRA_FIELDS]) {
      const value = data.company[name];
      field(name).value = value === null || value === undefined ? '' : String(value);
    }
    renderHistory(data.company, data.history);
    renderOffer();
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
