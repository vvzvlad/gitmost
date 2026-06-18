# Сноски (footnotes) — проект фичи

> Статус: **проработанный план, готов к реализации**. Ключевые решения приняты.
> - Архитектура: **reference + definitions** (модель Markdown/pandoc), а не «самодостаточный inline-атом со вложенным под-редактором».
> - Объём: **полная интеграция** — редактор + коллаборация (Yjs/Hocuspocus) + Markdown round-trip + зеркало схемы в MCP + AI-хелпер.
>
> Исходный кейс: переводы технических статей (например, про дефлокуляцию при шликерном литье) требуют сносок переводчика и ссылок на источники. Сейчас их некуда деть, кроме инлайновых комментариев или костыля `[1]` руками.

## 1. Цели и требования

1. **Читать сноску прямо в тексте** — навёл/кликнул на надстрочный номер → всплывающее окно с текстом сноски, не уходя со строки.
2. **Определения внизу страницы как часть текста** — текст сносок живёт реальным редактируемым блоком в конце документа (выделяется, копируется, экспортируется), а не виртуальной отрисовкой.
3. **Авто-нумерация** — номера проставляются и пересчитываются автоматически при вставке/удалении/перемещении.
4. **Безопасно для совместного редактирования** — работает поверх Hocuspocus/Yjs без расхождений между клиентами.
5. **Переживает Markdown** — экспорт/импорт страниц со сносками (формат pandoc/GFM `[^id]`).
6. **Доступно AI-агенту и MCP** — агент и MCP-инструменты умеют читать/создавать сноски; существующий хелпер `commentsToFootnotes` переводится на настоящие ноды.

## 2. Развилка (решена): почему НЕ «классический» footnote-атом

Есть два принципиально разных способа хранить текст сноски в ProseMirror/Tiptap.

### Вариант A — самодостаточный inline-атом (официальный пример ProseMirror)

Текст сноски лежит **внутри** inline-атома (`inline: true, atom: true, content: "text*"`), редактируется во вложенном под-редакторе в тултипе. См. [prosemirror.net/examples/footnote](https://prosemirror.net/examples/footnote/) и расширение [tiptap-extension-footnote](https://github.com/LAbigael/tiptap-extension-footnote).

Минусы для нашего стека:
- **Несовместим с коллаборацией.** Вложенный под-редактор синхронизирует шаги транзакций вручную (`dispatchInner`, флаг `fromOutside`). Поверх Hocuspocus/Yjs (`TiptapTransformer`) это даёт конфликты/расхождения — известная больная точка. У нас коллаборация — это ядро ([collaboration.gateway.ts](../apps/server/src/collaboration/collaboration.gateway.ts), [yjs.util.ts](../apps/server/src/collaboration/yjs.util.ts)).
- **Текст нельзя «положить вниз как часть текста».** Он заперт в атоме; нижний список пришлось бы рисовать виртуально (CSS/декорации) — он не выделяется и плохо экспортируется.
- Само расширение помечено `ALPHA, DO NOT USE FOR PRODUCTION`.

### Вариант B — reference + definitions (ВЫБРАН)

Маркер в тексте и текст сноски — **разные обычные ноды**, связанные по `id`:
- inline-атом-ссылка без контента (просто надстрочный номер);
- блок определений внизу страницы из обычных редактируемых нод.

Плюсы — это ровно то, что нужно:
- **Только обычные ноды → Yjs обрабатывает их нативно**, без вложенных редакторов. Главный выигрыш для коллаборативного стека.
- Нижний блок — **реальная часть документа**: выделяется, копируется, экспортируется (требование 2).
- Чтение в тексте — **read-only поповер**, который просто читает определение по `id`; под-редактор не нужен (требование 1).
- **1:1 ложится на Markdown-сноски** pandoc/GFM (`[^id]` … `[^id]: …`) → импорт/экспорт и хелпер `commentsToFootnotes` выравниваются естественно (требования 5, 6).

Минусы (управляемые, см. §4–§5): нужно держать ссылки и определения в синхроне (сироты/висячие ссылки) и считать номера/порядок плагином.

## 3. Модель документа

Три новые ноды. Источник истины — **ссылка**: есть `footnoteReference` → есть парное `footnoteDefinition`; удаление ссылки каскадно удаляет определение в той же транзакции (один Ctrl+Z восстанавливает оба).

```jsonc
// 1) Маркер в тексте — inline atom, без контента, только id.
//    Видимый номер НЕ хранится в документе (см. §4).
{ "type": "footnoteReference", "attrs": { "id": "fn_a1b2c3" } }

// 2) Контейнер внизу страницы — реальный блок, всегда последний в документе.
{ "type": "footnotesList", "content": [ /* footnoteDefinition+ */ ] }

// 3) Одно определение — обычный редактируемый блок с id, привязывающим к ссылке.
{ "type": "footnoteDefinition",
  "attrs": { "id": "fn_a1b2c3" },
  "content": [ { "type": "paragraph", "content": [ /* текст сноски, inline */ ] } ] }
```

### Почему нода, а не mark

Ссылка на сноску — это **вставляемый в точку курсора надстрочный глиф**, а не выделение существующего текста. Mark (как у комментариев в [comment.ts](../packages/editor-ext/src/lib/comment/comment.ts)) оборачивает диапазон; нам нужна точечная inline-нода-атом — образец [mention.ts](../packages/editor-ext/src/lib/mention.ts) (`inline: true, atom: true, selectable: true`).

### Схемные ограничения

| Нода | Параметры схемы | Где разрешена / что внутри |
|---|---|---|
| `footnoteReference` | `group: "inline"`, `inline: true`, `atom: true`, `selectable: true`, `draggable: false` | в любом inline-контексте, **кроме** code-block и **кроме** содержимого `footnoteDefinition` (запрет вложенных сносок) |
| `footnotesList` | `group: "block"`, `content: "footnoteDefinition+"`, `isolating: true`, `selectable: false` | единственный экземпляр, всегда **последний** дочерний узел документа |
| `footnoteDefinition` | `content: "paragraph+"` (или `block+` без вложенных сносок), `defining: true`, `isolating: true` | только внутри `footnotesList`; атрибут `id` обязателен |

`id` генерируется как `uuidv7` (как у mention/unique-id), хранится в `data-*`-атрибуте для HTML round-trip.

## 4. Нумерация и порядок — ключевая тонкость

**Решение: номера НЕ хранятся в документе.** Их вычисляет ProseMirror-плагин, проходя `footnoteReference` в порядке документа, и отрисовывает декорациями (на надстрочнике и на маркере определения).

Почему так:
- Детерминированность: каждый клиент считает одинаковые номера из одного и того же документа → **никаких расхождений в коллаборации**, никаких `appendTransaction` в ответ на чужие шаги (что и есть источник конфликтов).
- Дёшево: пересчёт на каждый рендер, без мутаций документа.

### Порядок определений внизу

Чтобы нижний список визуально шёл `1, 2, 3`, реальные ноды `footnoteDefinition` должны лежать в порядке ссылок (декорации не переставляют DOM). Стратегия:

1. **На создании** — команда `setFootnote` вставляет определение в **правильную позицию** (считает, сколько ссылок идёт до точки вставки, и кладёт определение по этому индексу). Покрывает и добавление в конец, и вставку в середину.
2. **Нормализация** — плагин-нормализатор приводит порядок определений к порядку ссылок, если он нарушился (например, пользователь вырезал и переставил абзац со ссылкой). Это **чистая функция от состояния документа** → все клиенты вычисляют одинаковую перестановку и сходятся. Чтобы два клиента не дёргали нормализацию одновременно, выполнять её в `appendTransaction` с guard-метой и идемпотентно (no-op, если порядок уже верный).

> Главный риск реализации — именно нормализация порядка при перемещении ссылок в коллаборации. Для MVP достаточно правильной вставки на создании (п.1) + нормализации только на локальных транзакциях; перемещение ссылок между местами — редкий кейс, его можно довести во вторую очередь.

Визуальные номера можно при желании продублировать CSS-счётчиками (`counter-reset`/`counter-increment`, как в alpha-расширении), но decoration-подход надёжнее в коллаборации и не зависит от порядка узлов.

## 5. Жизненный цикл, команды и UX

### Команды (в ноде, через `addCommands` + `declare module "@tiptap/core"`)

- `setFootnote()` — в одной транзакции: вставляет `footnoteReference` с новым `id` в позицию курсора + создаёт `footnotesList` (если его нет, в самом конце документа) + добавляет туда пустое `footnoteDefinition` с тем же `id` в правильную позицию + переносит фокус в это определение, чтобы сразу печатать текст.
- `removeFootnote(id)` — удаляет ссылку и её определение (каскад в одной транзакции). Если определений не осталось — удаляет пустой `footnotesList`.
- `scrollToFootnote(id)` / `scrollToReference(id)` — навигация «ссылка ↔ определение» (для кнопки в поповере и «↩» в определении).

### Ввод

- **Slash-меню** `/footnote` (или `/сноска`) — пункт в [slash-menu](../apps/client/src/features/editor/components/slash-menu), вызывает `setFootnote`.
- **Кнопка тулбара** и шорткат (например `Mod-Alt-F`).
- Опционально input-rule (по образцу `wrappingInputRule` в callout) — например `[^` → вставка сноски; решить при реализации, не обязательно для MVP.

### Плагин синхронизации (`addProseMirrorPlugins`)

Минимальный, guard’нутый, идемпотентный:
- **Подчистка сирот**: `footnoteDefinition` без парной ссылки — удалить (или пометить, см. §12).
- **Вставка/коллизии при paste**: ссылка без определения → создать пустое определение; определение без ссылки → удалить; при вставке с конфликтом `id` — регенерировать `id` у пары.
- **Пустой контейнер**: нет определений → удалить `footnotesList`.
- **Read-only / share**: плагин **не мутирует документ** (только декорации нумерации), чтобы не трогать общий документ при простом просмотре.

## 6. Чтение в тексте (поповер)

NodeView надстрочника (`ReactNodeViewRenderer`, образец mention/callout) по hover/click открывает поповер через `@floating-ui/dom` — тот же паттерн, что в [render-items.ts](../apps/client/src/features/editor/components/slash-menu/render-items.ts) и [mention-suggestion.ts](../apps/client/src/features/editor/components/mention/mention-suggestion.ts) (offset/flip/shift, autoUpdate, закрытие по outside-click).

Поповер показывает **read-only** текст определения, найденного по `id` прямо в `editor.state` (никакого под-редактора). Кнопка «редактировать»/«перейти» вызывает `scrollToFootnote(id)` и фокусит определение внизу. Работает и в read-only/share-режиме — там используется тот же `mainExtensions` ([extensions.ts](../apps/client/src/features/editor/extensions/extensions.ts), [readonly-page-editor.tsx](../apps/client/src/features/editor/readonly-page-editor.tsx)).

## 7. Нижний блок (footnotesList)

NodeView контейнера рисует визуальный разделитель: верхняя граница + заголовок («Footnotes» / «Примечания», локализуется), список `footnoteDefinition`. Каждое определение — `NodeViewContent` (редактируемый контент) + декоративный номер (из §4) + «↩» для возврата к ссылке. Стили — CSS-модули + Mantine, как у остальных NodeView ([components/callout](../apps/client/src/features/editor/components/callout)).

## 8. HTML round-trip (parseHTML / renderHTML)

Для лосслесс HTML↔JSON (экспорт, `generateHTML`, серверный рендер, зеркало MCP) у каждой ноды строгие `parseHTML`/`renderHTML`:

| Нода | renderHTML (примерно) | parseHTML |
|---|---|---|
| `footnoteReference` | `<sup data-footnote-ref data-id="…">` (атом, без контента; номер ставит CSS/декорация) | `sup[data-footnote-ref]` |
| `footnotesList` | `<section data-footnotes>…</section>` (или `<ol>`) | `section[data-footnotes]` |
| `footnoteDefinition` | `<div data-footnote-def data-id="…">…0…</div>` (`0` — дырка под контент) | `div[data-footnote-def]` |

## 9. Markdown

Маппинг на сноски pandoc/GFM:
- `footnoteReference` → `[^id]` в тексте;
- `footnoteDefinition` → `[^id]: текст` в конце документа.

Точки правки:
- **Экспорт HTML→Markdown (клиент/сервер):** правило turndown в [turndown.utils.ts](../packages/editor-ext/src/lib/markdown/utils/turndown.utils.ts) (образец — правило callout).
- **Импорт Markdown→JSON:** плагин/расширение marked в [marked.utils.ts](../packages/editor-ext/src/lib/markdown/utils/marked.utils.ts), плюс ноды должны быть в схеме `generateJSON`.
- **MCP JSON→Markdown:** case в [markdown-converter.ts](../packages/mcp/src/lib/markdown-converter.ts) (образцы — mention/callout).
- **Fallback:** при экспорте в формат без сносок — деградация в инлайновые `[n]` + список (текущее поведение `commentsToFootnotes`).

## 10. Сервер и коллаборация

Новые ноды обязаны попасть в серверный список расширений `tiptapExtensions` ([collaboration.util.ts](../apps/server/src/collaboration/collaboration.util.ts)) — иначе:
- сервер вырежет ноды при сохранении/коллаборации (`getSchema` в [yjs.util.ts](../apps/server/src/collaboration/yjs.util.ts));
- сломается серверный рендер HTML ([generateHTML.ts](../apps/server/src/common/helpers/prosemirror/html/generateHTML.ts)) и экспорт ([export.service.ts](../apps/server/src/integrations/export/export.service.ts)).

Поскольку это обычные ноды (а не атом с под-редактором), Yjs/`TiptapTransformer` обрабатывает их автоматически — отдельной регистрации в Yjs не нужно. Миграции БД не требуется (это уровень ProseMirror-документа, не схемы Postgres).

## 11. MCP: зеркало схемы и конвертер

`packages/mcp` **не** импортирует `editor-ext`, а держит собственное зеркало схемы. Синхронизировать вручную:
- определения трёх нод (`parseHTML`/`renderHTML`, атрибуты) — в [docmost-schema.ts](../packages/mcp/src/lib/docmost-schema.ts);
- сериализацию в Markdown — в [markdown-converter.ts](../packages/mcp/src/lib/markdown-converter.ts);
- перевод существующего хелпера `commentsToFootnotes` ([transforms.ts](../packages/mcp/src/lib/transforms.ts)) с текстовых `[N]` + `orderedList` на настоящие ноды `footnoteReference`/`footnotesList`/`footnoteDefinition`; обновить подсчёт маркеров в [diff.ts](../packages/mcp/src/lib/diff.ts).

> ⚠️ При любом изменении схемы документа держать `packages/mcp/src/lib/` и `packages/editor-ext` в синхроне — это явное требование CLAUDE.md.

## 12. Краевые случаи и решения

| Случай | Решение |
|---|---|
| Удалили ссылку | Каскадно удалить определение в той же транзакции (undo восстанавливает оба) |
| Удалили последнюю ссылку | Удалить весь `footnotesList` |
| Paste ссылки без определения | Создать пустое определение |
| Paste определения без ссылки | Удалить (сирота) — либо v2: пометить «осиротевшим» |
| Коллизия `id` при paste | Регенерировать `id` у вставленной пары |
| Перемещение ссылки (cut/paste абзаца) | Нормализатор переупорядочивает определения (§4) |
| Вложенная сноска (ссылка внутри определения) | Запретить схемой |
| Ссылка в code-block | Запретить |
| Несколько ссылок на одну сноску | v2 (MVP: строго 1:1) |
| Экспорт в формат без сносок | Fallback на `[n]` + список |
| Read-only / share | Только декорации нумерации, без мутаций документа |

## 13. Затрагиваемые файлы (полный список)

**Редактор (editor-ext):**
- `packages/editor-ext/src/lib/footnote/` — новые: три ноды, плагин нумерации/нормализации, команды, NodeView’ы (новый каталог).
- [packages/editor-ext/src/index.ts](../packages/editor-ext/src/index.ts) — экспорт.

**Клиент:**
- [apps/client/src/features/editor/extensions/extensions.ts](../apps/client/src/features/editor/extensions/extensions.ts) — регистрация в `mainExtensions`, привязка React-NodeView.
- `apps/client/src/features/editor/components/footnote/` — NodeView надстрочника + поповер чтения, NodeView нижнего блока, CSS-модули (новый каталог).
- [apps/client/src/features/editor/components/slash-menu](../apps/client/src/features/editor/components/slash-menu) — пункт `/footnote`.

**Сервер / коллаборация:**
- [apps/server/src/collaboration/collaboration.util.ts](../apps/server/src/collaboration/collaboration.util.ts) — добавить ноды в `tiptapExtensions`.

**Markdown round-trip:**
- [packages/editor-ext/src/lib/markdown/utils/turndown.utils.ts](../packages/editor-ext/src/lib/markdown/utils/turndown.utils.ts)
- [packages/editor-ext/src/lib/markdown/utils/marked.utils.ts](../packages/editor-ext/src/lib/markdown/utils/marked.utils.ts)

**MCP:**
- [packages/mcp/src/lib/docmost-schema.ts](../packages/mcp/src/lib/docmost-schema.ts)
- [packages/mcp/src/lib/markdown-converter.ts](../packages/mcp/src/lib/markdown-converter.ts)
- [packages/mcp/src/lib/transforms.ts](../packages/mcp/src/lib/transforms.ts) (+ [diff.ts](../packages/mcp/src/lib/diff.ts))

## 14. План реализации по фазам

1. **Схема (editor-ext):** три ноды + команды + input-rule + экспорт в `index.ts`. Минимальный плагин нумерации (декорации). Это фундамент, от него зависит всё.
2. **Клиент UI:** NodeView надстрочника + поповер чтения (floating-ui), NodeView нижнего блока, slash-меню, CSS, регистрация в `extensions.ts`. Проверить read-only/share.
3. **Сервер/коллаборация:** регистрация в `tiptapExtensions`; проверить сохранение, коллаборацию двух клиентов, серверный рендер/экспорт HTML.
4. **Markdown round-trip:** turndown + marked; тест «JSON → MD → JSON» без потерь.
5. **MCP:** зеркало схемы + конвертер + перевод `commentsToFootnotes` на ноды + `diff.ts`.
6. **Шлифовка:** нормализация порядка при перемещении ссылок, edge-cases из §12, доступность (ARIA для надстрочника/поповера).

## 15. Тестирование

- **Unit (mcp, `node --test`):** JSON↔Markdown round-trip сносок; `commentsToFootnotes` → ноды; нумерация/нормализация как чистая функция.
- **Unit (editor-ext):** команды `setFootnote`/`removeFootnote`, каскадное удаление, вставка определения в правильную позицию.
- **Client (Vitest):** рендер надстрочника и поповера, навигация ссылка↔определение.
- **Ручной/e2e:** два коллаборативных клиента (одновременная вставка сносок, отсутствие расхождений нумерации), экспорт в PDF/Markdown, публичная шара (поповер в read-only).

## 16. Открытые вопросы / v2

- Повторное использование одной сноски несколькими ссылками (pandoc допускает) — отложено.
- Сноски-сироты: удалять молча или показывать предупреждение/«осиротевший» бейдж.
- Концевые сноски (endnotes) на уровне спейса/книги vs постраничные — вне объёма.
- Доп. форматы экспорта (DOCX и т.п.) — отдельно.

---

### Ссылки на код

- Образец inline-атома: [packages/editor-ext/src/lib/mention.ts](../packages/editor-ext/src/lib/mention.ts)
- Образец блок-ноды с контентом + NodeView + input-rule: [packages/editor-ext/src/lib/callout/callout.ts](../packages/editor-ext/src/lib/callout/callout.ts)
- Образец mark с id + плагин-декорация: [packages/editor-ext/src/lib/comment/comment.ts](../packages/editor-ext/src/lib/comment/comment.ts)
- Реестр нод editor-ext: [packages/editor-ext/src/index.ts](../packages/editor-ext/src/index.ts)
- Клиентский список расширений: [apps/client/src/features/editor/extensions/extensions.ts](../apps/client/src/features/editor/extensions/extensions.ts)
- Поповеры через floating-ui: [slash-menu/render-items.ts](../apps/client/src/features/editor/components/slash-menu/render-items.ts), [mention/mention-suggestion.ts](../apps/client/src/features/editor/components/mention/mention-suggestion.ts)
- Серверный список расширений: [apps/server/src/collaboration/collaboration.util.ts](../apps/server/src/collaboration/collaboration.util.ts)
- Yjs-схема / рендер: [apps/server/src/collaboration/yjs.util.ts](../apps/server/src/collaboration/yjs.util.ts), [apps/server/src/common/helpers/prosemirror/html/generateHTML.ts](../apps/server/src/common/helpers/prosemirror/html/generateHTML.ts)
- Markdown ↔ HTML: [packages/editor-ext/src/lib/markdown](../packages/editor-ext/src/lib/markdown)
- Зеркало схемы MCP: [packages/mcp/src/lib/docmost-schema.ts](../packages/mcp/src/lib/docmost-schema.ts)
- MCP конвертер / хелпер сносок: [packages/mcp/src/lib/markdown-converter.ts](../packages/mcp/src/lib/markdown-converter.ts), [packages/mcp/src/lib/transforms.ts](../packages/mcp/src/lib/transforms.ts)
- Прообраз из примера ProseMirror: [prosemirror.net/examples/footnote](https://prosemirror.net/examples/footnote/)
