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
];
