// Миграции — пронумерованный список изменений структуры базы.
//
// Как это работает: внутри файла базы SQLite хранит число user_version — номер последней
// выполненной миграции. При запуске программа выполняет только те миграции, номер которых больше.
// Старые строки при этом не трогаются, поэтому данные не теряются.
//
// Правила, чтобы ничего не сломать:
//  • уже выполненную миграцию НЕ меняем — пишем новую с номером +1;
//  • новое поле добавляем так: ALTER TABLE companies ADD COLUMN status TEXT NOT NULL DEFAULT 'new';
//  • перед миграциями существующая база копируется в data/backups/ (см. db.js).

export const MIGRATIONS = [
  {
    version: 1,
    name: 'Таблица компаний',
    // Пустые текстовые поля храним как '' (а не NULL): меньше проверок в коде.
    // NULL оставляем там, где «не указано» отличается от нуля: рейтинг, число отзывов, ID карточки.
    sql: `
      CREATE TABLE companies (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL,
        category      TEXT    NOT NULL DEFAULT '',
        city          TEXT    NOT NULL DEFAULT '',
        address       TEXT    NOT NULL DEFAULT '',
        card_url      TEXT    NOT NULL DEFAULT '',  -- ссылка на карточку в 2ГИС / Яндекс Картах
        source        TEXT    NOT NULL DEFAULT 'other',  -- '2gis' | 'yandex' | 'other'
        source_id     TEXT,                         -- ID организации из ссылки (если есть)
        phone         TEXT    NOT NULL DEFAULT '',  -- всегда в виде +7XXXXXXXXXX
        website       TEXT    NOT NULL DEFAULT '',  -- сайт или соцсеть
        rating        REAL,
        reviews_count INTEGER,
        note          TEXT    NOT NULL DEFAULT '',
        name_key      TEXT    NOT NULL,             -- служебное: название для поиска дублей
        address_key   TEXT    NOT NULL DEFAULT '',  -- служебное: адрес для поиска дублей
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL
      );

      -- Одна карточка 2ГИС/Яндекса — одна строка. Это «страховка» на уровне самой базы.
      CREATE UNIQUE INDEX companies_source_id ON companies (source, source_id)
        WHERE source_id IS NOT NULL;

      CREATE INDEX companies_name_key ON companies (name_key);
    `,
  },
  {
    version: 2,
    name: 'Поле «Соцсети и другие ссылки»',
    // Ссылки храним текстом, по одной на строку. У старых записей поле будет пустым.
    sql: `ALTER TABLE companies ADD COLUMN other_links TEXT NOT NULL DEFAULT ''`,
  },
  {
    version: 3,
    name: 'Результат проверки сайта',
    // Результат храним одним «пакетом» в формате JSON (https, мобильная версия, год в ©…).
    // Когда появятся новые признаки, таблицу менять не придётся.
    sql: `
      ALTER TABLE companies ADD COLUMN site_check TEXT;
      ALTER TABLE companies ADD COLUMN site_checked_at TEXT;
    `,
  },
  {
    version: 4,
    name: 'Список «не предлагать снова»',
    // Компании, которые ты удалил выборочно: автопоиск их больше не добавляет.
    // Храним только то, по чему узнаём компанию (те же правила, что для дублей).
    sql: `
      CREATE TABLE excluded (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT 'other',
        source_id   TEXT,
        phone       TEXT NOT NULL DEFAULT '',
        name_key    TEXT NOT NULL,
        address_key TEXT NOT NULL DEFAULT '',
        excluded_at TEXT NOT NULL
      );
      CREATE INDEX excluded_name_key ON excluded (name_key);
    `,
  },
  {
    version: 5,
    name: 'Работа с клиентами: статус, дата следующего контакта, история',
    sql: `
      ALTER TABLE companies ADD COLUMN status TEXT NOT NULL DEFAULT 'new'; -- см. shared/statuses.js
      ALTER TABLE companies ADD COLUMN next_contact_at TEXT;              -- дата 'ГГГГ-ММ-ДД' или NULL
      ALTER TABLE companies ADD COLUMN status_changed_at TEXT;

      -- Каждая смена статуса — отдельная строка: видно, когда написал, когда ответили.
      -- ON DELETE CASCADE: удалили компанию — её история удалится сама.
      CREATE TABLE status_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id  INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
        status      TEXT    NOT NULL,
        changed_at  TEXT    NOT NULL
      );
      CREATE INDEX status_history_company ON status_history (company_id);
    `,
  },
  {
    version: 6,
    name: 'Настройки (подпись для предложений)',
    // Храним в базе, а не в браузере: у программы при каждом запуске новый адрес (порт),
    // и браузерное хранилище каждый раз было бы пустым.
    sql: 'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  },
];
