// Запросы к нашему серверу из страницы.

/** Запрос к серверу. Возвращает { ok, status, data } и никогда не бросает исключение. */
export async function request(method, url, body) {
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'Нет связи с сервером. Проверь, что Lead Finder запущен.' } };
  }
}
