// Фильтры над таблицей: поиск по тексту, статус, горячесть, сфера + напоминание «связаться сегодня».
import { FINAL_STATUSES, STATUSES, contactReminder } from '/shared/statuses.js';

/**
 * Подключает фильтры. onChange() вызывается, когда что-то поменялось и таблицу надо перерисовать.
 * Возвращает { apply, update }.
 */
export function initFilters({ onChange }) {
  const text = document.getElementById('filter-text');
  const status = document.getElementById('filter-status');
  const level = document.getElementById('filter-level');
  const category = document.getElementById('filter-category');
  const reset = document.getElementById('filter-reset');
  const reminders = document.getElementById('reminders');

  const separator = new Option('──────────', '');
  separator.disabled = true;
  status.append(separator, ...STATUSES.map(({ id, label }) => new Option(label, id)));

  let timer = null;
  text.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 200); // ждём паузу в наборе, а не перерисовываем на каждую букву
  });
  for (const select of [status, level, category]) select.addEventListener('change', onChange);
  reset.addEventListener('click', () => {
    text.value = '';
    status.value = '';
    level.value = '';
    category.value = '';
    onChange();
  });
  reminders.addEventListener('click', () => {
    status.value = 'due';
    onChange();
  });

  return {
    /** Оставляет только компании, подходящие под фильтры. */
    apply(companies, assessments, today) {
      const query = text.value.trim().toLowerCase();
      return companies.filter((company) =>
        matchesText(company, query) &&
        matchesStatus(company, status.value, today) &&
        (!level.value || assessments.get(company.id).level.id === level.value) &&
        (!category.value || company.category === category.value));
    },

    /** Обновляет список сфер, напоминание и кнопку «сбросить» под текущие данные. */
    update(companies, today) {
      const chosen = category.value;
      const categories = [...new Set(companies.map((c) => c.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
      category.replaceChildren(new Option('Все сферы', ''), ...categories.map((name) => new Option(name, name)));
      category.value = categories.includes(chosen) ? chosen : '';

      let overdue = 0;
      let dueToday = 0;
      for (const company of companies) {
        const reminder = contactReminder(company, today);
        if (reminder?.state === 'overdue') overdue += 1;
        if (reminder?.state === 'today') dueToday += 1;
      }
      reminders.hidden = overdue + dueToday === 0;
      reminders.textContent = `🔔 Связаться сегодня: ${dueToday}` + (overdue > 0 ? ` · просрочено: ${overdue}` : '') + ' — показать';
      reminders.classList.toggle('has-overdue', overdue > 0);

      reset.hidden = !(text.value.trim() || status.value || level.value || category.value);
    },
  };
}

function matchesText(company, query) {
  if (!query) return true;
  const haystack = [company.name, company.category, company.city, company.address, company.phone,
    company.website, company.other_links, company.note].join(' ').toLowerCase();
  if (haystack.includes(query)) return true;
  // Номер можно искать как угодно: «8 918 111», «918-111», «+7918111».
  const digits = query.replace(/\D/g, '');
  if (digits.length >= 3 && /^[\d\s+()-]+$/.test(query)) {
    const phone = company.phone.replace(/\D/g, '');
    return phone.includes(digits) || phone.includes(digits.replace(/^8/, '7'));
  }
  return false;
}

function matchesStatus(company, value, today) {
  if (!value) return true;
  if (value === 'active') return !FINAL_STATUSES.has(company.status);
  if (value === 'due') return ['overdue', 'today'].includes(contactReminder(company, today)?.state);
  return company.status === value;
}
