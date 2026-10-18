// Выбор компаний галочками и удаление: выборочно и весь список сразу.
import { request } from '/api.js';

/**
 * Подключает выбор и удаление. reload() — перечитать список компаний с сервера.
 * Возвращает два помощника для таблицы:
 *   checkbox(company)            — галочка для строки;
 *   afterRender(visible, all)    — вызвать после перерисовки таблицы (видимые и все компании).
 */
export function initSelection({ reload }) {
  const selected = new Set(); // id отмеченных компаний
  let visibleIds = [];
  let total = 0;

  const bar = document.getElementById('selection-bar');
  const countLabel = document.getElementById('selection-count');
  const selectAll = document.getElementById('select-all');
  const message = document.getElementById('list-message');

  selectAll.addEventListener('change', () => {
    // «Выбрать все» — только те, что видны в текущей вкладке.
    for (const id of visibleIds) {
      if (selectAll.checked) selected.add(id);
      else selected.delete(id);
    }
    for (const box of document.querySelectorAll('#companies-body input[type="checkbox"]')) {
      box.checked = selected.has(Number(box.dataset.id));
    }
    updateBar();
  });
  document.getElementById('clear-selection').addEventListener('click', () => {
    selected.clear();
    for (const box of document.querySelectorAll('#companies-body input[type="checkbox"]')) box.checked = false;
    updateBar();
  });
  document.getElementById('delete-selected').addEventListener('click', deleteSelected);
  document.getElementById('clear-all').addEventListener('click', clearAll);
  document.getElementById('clear-excluded').addEventListener('click', clearExcludedList);
  const rememberBox = document.getElementById('delete-remember');
  const excludedInfo = document.getElementById('excluded-info');
  const excludedCount = document.getElementById('excluded-count');
  refreshExcluded();

  async function deleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const remember = rememberBox.checked;
    const ok = window.confirm(`Удалить выбранные компании (${ids.length})?\n\n` + (remember
      ? 'Автопоиск больше не будет их предлагать (это можно отменить: внизу таблицы — «Список «не предлагать снова» → очистить»).'
      : 'Автопоиск сможет предложить их снова.'));
    if (!ok) return;
    const { ok: done, data } = await request('POST', '/api/companies/delete', { ids, remember });
    if (!done) return showMessage(data.error || 'Не получилось удалить', 'error');
    selected.clear();
    showMessage(`Удалено компаний: ${data.deleted}.` + (remember ? ' Автопоиск больше не будет их предлагать.' : ''), 'success');
    await reload();
    await refreshExcluded();
  }

  /** Показать, сколько компаний в «не предлагать снова» (внизу таблицы). */
  async function refreshExcluded() {
    const { ok, data } = await request('GET', '/api/excluded');
    if (!ok) return;
    excludedCount.textContent = String(data.count);
    excludedInfo.hidden = data.count === 0;
  }

  async function clearExcludedList() {
    const ok = window.confirm(`Очистить список «не предлагать снова» (${excludedCount.textContent})?\n\n` +
      'Компании в таблице не удалятся. Автопоиск снова сможет предлагать всех, кого ты удалял раньше.');
    if (!ok) return;
    const { ok: done, data } = await request('POST', '/api/excluded/clear', { confirm: 'all' });
    if (!done) return showMessage(data.error || 'Не получилось очистить список', 'error');
    showMessage(`Список «не предлагать снова» очищен (${data.cleared}). Автопоиск снова предложит этих компаний.`, 'success');
    await refreshExcluded();
  }

  async function clearAll() {
    if (total === 0) {
      // Компаний нет, но мог остаться список «не предлагать снова» — его чистит отдельная кнопка.
      return showMessage('Список компаний и так пуст.' + (excludedInfo.hidden ? ''
        : ' Чтобы автопоиск снова предлагал удалённых раньше — нажми «очистить» у списка «не предлагать снова».'), 'warning');
    }
    const ok = window.confirm(`Удалить ВСЕ компании (${total}) из списка?\n\n` +
      'Перед удалением программа сохранит резервную копию базы — если передумаешь, данные можно вернуть.\n' +
      'Список «не предлагать снова» тоже очистится: начнёшь с нуля.');
    if (!ok) return;
    const { ok: done, data } = await request('POST', '/api/companies/clear', { confirm: 'all' });
    if (!done) return showMessage(data.error || 'Не получилось очистить список', 'error');
    selected.clear();
    showMessage(`Список очищен, удалено компаний: ${data.deleted}.` +
      (data.backup ? ` Резервная копия: ${data.backup}` : ''), 'success');
    await reload();
    await refreshExcluded();
  }

  function updateBar() {
    bar.hidden = selected.size === 0;
    countLabel.textContent = `Выбрано: ${selected.size}`;
    const visibleSelected = visibleIds.filter((id) => selected.has(id)).length;
    selectAll.checked = visibleIds.length > 0 && visibleSelected === visibleIds.length;
    selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.length;
  }

  function showMessage(text, kind) {
    message.textContent = text;
    message.className = `message ${kind}`;
    message.hidden = false;
  }

  return {
    refreshExcluded,
    checkbox(company) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.id = String(company.id);
      box.checked = selected.has(company.id);
      box.setAttribute('aria-label', `Выбрать: ${company.name}`);
      box.addEventListener('change', () => {
        if (box.checked) selected.add(company.id);
        else selected.delete(company.id);
        updateBar();
      });
      return box;
    },
    afterRender(visible, all) {
      visibleIds = visible.map((company) => company.id);
      total = all.length;
      // Отмеченные, которых больше нет в списке (удалены), забываем.
      const existing = new Set(all.map((company) => company.id));
      for (const id of selected) if (!existing.has(id)) selected.delete(id);
      updateBar();
    },
  };
}
