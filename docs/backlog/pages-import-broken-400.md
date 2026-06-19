# /pages/import отдаёт 400 «Error processing file content» (регресс)

Статус: **диагностируемость починена** (fix #1 применён); корневая причина **не
подтверждена** — на текущем коде локально баг воспроизвести не удалось.
Ниже — что удалось выяснить, главный подозреваемый и что проверить дальше.

## Симптом

На задеплоенном инстансе эндпоинт `POST /pages/import` отдаёт
`400 BadRequest` с телом «Error processing file content». Раньше работал —
похоже на регресс после редеплоя гитмоста.

Через этот эндпоинт грузит контент MCP-инструмент `create_page` (это
единственный эндпоинт, принимающий контент при создании страницы —
см. комментарий в `packages/mcp/src/client.ts:961`).

Что при этом **исправно** (важно для локализации):
- `POST /pages/create` — создание пустой страницы.
- `update_page_json` — запись контента через realtime-коллаборацию (Yjs).

## Где именно бросается ошибка

`apps/server/src/integrations/import/services/import.service.ts:93-97` —
`try/catch` вокруг обработки контента:

```ts
} catch (err) {
  const message = 'Error processing file content';
  this.logger.error(message, err); // реальная причина логируется ТОЛЬКО в логи
  throw new BadRequestException(message); // наружу уходит generic-строка
}
```

Реальный текст ошибки/стек **проглатывается** (наружу — generic-строка), что
нарушает конвенцию проекта (см. CLAUDE.md, «Errors must never be swallowed»).
Поэтому по ответу 400 причину не видно — её надо читать в логах сервера
(`logger.error(message, err)` пишет полный err) ИЛИ воспроизвести локально.

## Цепочка обработки для .md (что внутри try)

`importPage` → `processMarkdown(fileContent)`:
1. `markdownToHtml` (`packages/editor-ext/.../marked.utils.ts`) — marked, чистый JS, без DOM.
2. `processHTML`: cheerio `load` → `normalizeImportHtml` (`utils/import-formatter.ts`) — чистый JS.
3. `htmlToJson` (`apps/server/src/collaboration/collaboration.util.ts:118`) →
   `generateJSON(html, tiptapExtensions)`.

## Ключевая зацепка: путь импорта зависит от happy-dom, рабочие пути — нет

`generateJSON` (`apps/server/src/common/helpers/prosemirror/html/generateJSON.ts`)
парсит HTML через **happy-dom**: `new Window()` + `new localWindow.DOMParser()` +
`parseFromString(...)`, затем `PMDOMParser.fromSchema(schema).parse(doc.body)`.

А исправные пути DOM-парсер НЕ используют:
- `/pages/create` — пустая страница, контент не парсится.
- `update_page_json` — пишет готовый ProseMirror-JSON в Yjs
  (`TiptapTransformer.toYdoc`), без HTML→DOM.

То есть единственное, что есть в сломанном пути и отсутствует в рабочих, —
**серверный парсинг HTML через happy-dom**.

## Главный подозреваемый: бамп happy-dom (14 → 20)

- Изначально было `"happy-dom": "^14.12.3"`.
- Сейчас запинено `"happy-dom": "20.8.9"` в `apps/server/package.json:83`
  (+ override в корневом `package.json`).
- Пин на `20.8.9` пришёл в коммите `17da7629 "overrides"`
  (Philipinho, 2026-03-28), где `20.8.4` → `20.8.9`.
- Скачок 14 → 20 — это 6 мажоров; у happy-dom между мажорами ломающие
  изменения в API `Window`/`DOMParser` и в поведении парсинга HTML. Очень
  вероятно, что `generateJSON` ломается на новом happy-dom.

Версия в node_modules подтверждена: `happy-dom@20.8.9` (симлинк свежий).

## Второстепенный подозреваемый

`getSchema(tiptapExtensions)` / `PMDOMParser.parse(...)` могут спотыкаться на
`parseHTML`-правилах недавно добавленных нод (synced blocks/transclusion,
page break, indent, columns, status — все они в `tiptapExtensions`). Но
`getSchema` используется и в рабочем пути (`createYdoc`/`update_page_json`),
поэтому сам по себе билд схемы скорее всего цел — под подозрением именно
DOM-парс-ветка, уникальная для импорта.

## Направления фикса

1. **Диагностируемость — ✅ СДЕЛАНО (по конвенции проекта).** В catch-блоках
   `import.service.ts` (обработка контента + вставка страницы) реальная
   причина теперь прокидывается наружу: `BadRequestException` несёт
   `${err.name}: ${err.message}`, а в лог пишется полный `err` со стеком.
   Раньше наружу уходила generic-строка "Error processing file content".
   Теперь при повторе 400 на проде реальный reason будет виден прямо в теле
   ответа — без необходимости лезть в логи.
2. **Корневой фикс — ⏳ НЕ ПОДТВЕРЖДЁН.** Гипотеза happy-dom 14→20 **не
   подтвердилась** при локальном воспроизведении на текущем коде (см. ниже).
   Применять блайнд-даунгрейд happy-dom нельзя — нужен реальный stack из
   логов/ответа после повторения.

## Локальное воспроизведение (выполнено)

На текущем `main` (happy-dom 20.8.9) вся цепочка импорта `.md` отработала
без ошибок через `tsx` (импорты прямо из source, не из dist):

- `markdownToHtml` → cheerio `load` → `normalizeImportHtml` → `generateJSON`
  с полным набором из 44 `tiptapExtensions` — **OK** для:
  - базового markdown (заголовки, bold/italic, списки, таблицы, code-block,
    blockquote)
  - edge-cases: пустой контент, whitespace, HTML-сущности, вложенные списки,
    task-list, emoji, кириллица, спецсимволы в code, ссылки, изображения, hr
- API happy-dom 20.8.9, используемые в `generateJSON`, существуют и работают:
  `new Window()`, `new localWindow.DOMParser()`, `parseFromString('…',
  'text/html')`, `happyDOM.abort()` (async), `happyDOM.close()` (async).
- Блок `finally` в `generateJSON` вызывает `abort()/close()` без `await` и без
  `try/catch`, но эти методы не бросают синхронно и не перезаписывают
  результат — **не является** причиной 400 (проверено отдельным тестом).
- Все `parseHTML`-правила расширений (status, transclusion, page-break,
  columns, subpages и т.д.) участвуют в успешном тесте — ни одно не падает.

Вывод: на текущем коде баг **не воспроизводится**. Вероятные объяснения —
контент-специфичный кейс, которого нет в тестах; разница между source и
собранным `dist`; либо временное состояние задеплоенного инстанса. После
применения fix #1 повторный 400 покажет реальный reason — по нему и искать
корень.
