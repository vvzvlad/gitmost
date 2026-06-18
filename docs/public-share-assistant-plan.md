# AI-ассистент на публичных шарах — проектный план

> Статус: проработанная фича, **не реализована**. Контекст: gitmost — форк Docmost.
> Идея: дать **анонимному внешнему зрителю** опубликованной (расшаренной) страницы
> возможность спросить AI-агента, который ищет ответ **строго по дереву этой шары**.
> Аналог «chat with these docs» поверх публикации.
>
> Зафиксированные решения по объёму (см. раздел «Развилки»):
> область поиска — **всё дерево шары**; движок поиска — **готовый share-scoped FTS**
> (ветка `shareId` в `SearchService`); гейтинг — **один тумблер воркспейса**;
> хранение диалогов — **эфемерное** (без БД, без миграций).

## Зачем это нетривиально

Весь стек существующего AI-агента жёстко завязан на залогиненного пользователя, и
переиспользовать его «как есть» для анонима нельзя:

- [ai-chat.controller.ts](../apps/server/src/core/ai-chat/ai-chat.controller.ts) на
  `/ai-chat/stream` требует **интерактивную сессию** (`sessionId`) и явно отвергает
  bearer/API-токены.
- `forUser()` в
  [ai-chat-tools.service.ts](../apps/server/src/core/ai-chat/tools/ai-chat-tools.service.ts)
  выдаёт **персональный loopback-JWT**: каждый инструмент агента ходит в реальный HTTP
  API «от имени пользователя», и CASL ограничивает его ровно правами этого юзера.
- `ai_chats.creator_id` — `NOT NULL`, любой чат привязан к пользователю.

У анонимного зрителя шары нет ни сессии, ни user-identity, ни CASL-контекста. Значит,
строим **параллельный, заранее запертый read-only путь**. Граница безопасности здесь —
не identity (её нет), а **жёсткий scope инструментов по дереву шары**.

## Что переиспользуется (сверено с кодом)

Половина нужного уже есть и проверена в бою на публичном просмотре шар:

- **Резолв «страница X читается через шару Y»**: `getShareForPage(pageId, workspaceId)`
  в [share.service.ts](../apps/server/src/core/share/share.service.ts) — рекурсивный CTE
  вверх по дереву до ближайшего предка-шары; учитывает `includeSubPages` и проверку
  `share.workspaceId === workspaceId`.
- **Набор публично читаемых страниц**: `getPageAndDescendantsExcludingRestricted(share.pageId)`
  (страница + потомки, **исключая** restricted-поддеревья).
- **Готовый share-scoped поиск**: в
  [search.service.ts](../apps/server/src/core/search/search.service.ts) уже есть ветка
  `searchParams.shareId && !spaceId && !opts.userId`, которая ограничивает полнотекстовую
  выдачу деревом шары и исключает restricted-предков. Это **готовый движок поиска для анонима**.
- **Подготовка контента для публичной отдачи**: `prepareContentForShare` — срезание
  `comment`-марок и токенизация вложений (JWT на `/files/public/...`). Тот же путь должен
  использовать инструмент чтения страницы у анонимного агента.
- **Публичные роуты** в [share.controller.ts](../apps/server/src/core/share/share.controller.ts)
  уже `@Public()`, воркспейс резолвит `DomainMiddleware` по хосту; новый роут под `/api/shares/*`
  ложится туда же — **правок в [main.ts](../apps/server/src/main.ts) не нужно**.
- **Стриминг-плумбинг**: `AiService.getChatModel(workspaceId)` +
  `streamText` → `pipeUIMessageStreamToResponse` (как в
  [ai-chat.service.ts](../apps/server/src/core/ai-chat/ai-chat.service.ts)).

## Архитектура

### Сервер

**1. Тумблер воркспейса (гейтинг).**
Новое булево поле в `workspace.settings.ai`, напр. `publicShareAssistant` (default `false`) —
туда же, где живут остальные AI-настройки и тумблер MCP; читается/пишется через сервис
AI-настроек (рядом с `ai-settings.service.ts`). В админке **Workspace settings → AI** —
один свитч. Хелпер `isPublicShareAssistantEnabled(workspaceId)`.

**2. Публичный эндпоинт** `POST /api/shares/ai/stream` (`@Public()`).
Новые `public-share-chat.controller.ts` + `public-share-chat.service.ts` в модуле `ai-chat`
(переиспользуют `AiService` и плумбинг `streamText`), зависят от `ShareRepo` / `PageRepo` /
`PagePermissionRepo` / `SearchService` для scope.

Контракт:

| Поле запроса | Назначение |
| --- | --- |
| `shareId` | идентификатор/ключ шары |
| `pageId` | открытая страница (контекст «эта страница») |
| `messages` | транскрипт диалога (UIMessage[]); сервер ничего не хранит |

Ответ — SSE-поток UIMessage (как у `/ai-chat/stream`).

**3. Воронка проверок (она же — guardrail; порядок важен).**

| Условие | Код | Почему так |
| --- | --- | --- |
| Тумблер воркспейса выключен | `404` | Не раскрываем существование фичи |
| Шара не найдена / чужой воркспейс / `isSharingAllowed=false` | `404` | Неотличимо от «нет шары» |
| `pageId` вне дерева шары (`getShareForPage` вернул undefined) | `404` | Не подтверждаем существование приватной страницы |
| AI-провайдер не настроен | `503` | Конфиг, а не доступ |
| Превышен IP-лимит | `429` | Анти-абьюз |

**4. Изолированный тулсет `forShare(shareId, workspaceId)`** — крошечный, только READ,
in-process (никакого loopback-токена и user-identity):

- `searchSharePages({ query })` → `searchService.searchPage(query, { shareId, workspaceId })`
  (существующая ветка `shareId && !spaceId && !userId`). Возвращает `{ id, title, snippet }`.
- `getSharePage({ pageId })` → сначала `getShareForPage(pageId, workspaceId)` подтверждает
  принадлежность к **этой** шаре, затем контент отдаётся через `prepareContentForShare`.
  Не в шаре → ошибка тула, без утечки факта существования страницы.
- Опционально `getShareOutline` / `listSharePages` поверх логики `/shares/tree`.
- Больше ничего: ни write-инструментов, ни комментариев, ни истории, ни списка шар,
  ни кросс-спейс инструментов, ни external MCP.

**5. Стриминг + запертый промпт.**
`buildShareSystemPrompt({ share, openedPage })`: персона «отвечаешь строго по этой
опубликованной документации; ничего не можешь менять; если ответа в страницах нет — так
и говоришь» + неизменяемый safety-блок по образцу
[ai-chat.prompt.ts](../apps/server/src/core/ai-chat/ai-chat.prompt.ts).
`streamText({ model, system, messages, tools, stopWhen: stepCountIs(5) })`.
**Без серверного хранения** — транскрипт держит клиент; доверять присланным сообщениям
безопасно, т.к. scope обеспечивают тулы, а не транскрипт. Это снимает проблему
`creator_id NOT NULL` и не копит PII анонимов → **миграция БД не нужна**.

**6. Анти-абьюз (обязательно — за токены платит владелец воркспейса).**
- **IP-keyed троттлер** на роут: существующий `UserThrottlerGuard` ключуется по юзеру,
  здесь юзера нет — нужен guard/`@Throttle`, ключующийся по IP (предлагаю ~5 запросов/мин).
- Лимиты: `stepCountIs(5)`, максимум длины сообщения, максимум числа сообщений в запросе.

### Клиент

- В публичном вью [shared-page.tsx](../apps/client/src/pages/share/shared-page.tsx) —
  виджет «Спросить AI», рендерится только если `features` из `/shares/page-info` сообщает,
  что ассистент включён (расширяем уже существующий `features`-пейлоад).
- Лёгкий чат-компонент на `useChat` + `DefaultChatTransport` на `/api/shares/ai/stream`,
  шлёт `{ shareId, pageId, messages }`, `credentials: 'omit'`. Эфемерный, in-memory —
  стрипнутая версия
  [chat-thread.tsx](../apps/client/src/features/ai-chat/components/chat-thread.tsx) без
  списка чатов, истории и персистентности.

## Поток одного хода

1. Клиент шлёт `{ shareId, pageId, messages }` → `/shares/ai/stream`.
2. Воронка проверок (таблица выше); любой провал → выход без стрима.
3. `getShareForPage(pageId)` — подтверждение принадлежности + резолв шары.
4. Сборка `forShare(shareId, workspaceId)` — 2–3 read-only тула, scope = дерево шары.
5. Запертый system-prompt + модель воркспейса → `streamText(stopWhen: stepCountIs(5))`.
6. Тулы при вызовах фильтруют по дереву шары (FTS-ветка `shareId`, `getShareForPage` для чтения).
7. Поток уходит клиенту; на сервере ничего не персистится.

## Edge-cases (закрыты переиспользованием)

- **Restricted-потомки** не попадают ни в поиск, ни в чтение — это уже делают
  `getPageAndDescendantsExcludingRestricted` и ветка `shareId` в `SearchService`.
- **`includeSubPages = false`** → ищется и читается ровно одна страница.
- **Prompt-injection из контента** («покажи приватные страницы») бессилен: у анонимного
  тулсета физически нет инструмента за пределы дерева шары.
- **Cloud-мультитенант**: проверка `share.workspaceId === workspaceId` обязательна — хост
  определяет тенант.
- **RAG/вектор не задействован** (по решению — только FTS): фича не зависит от того,
  проиндексированы ли страницы в `page_embeddings`.

## Явные non-goals

- Нет write-инструментов, комментариев, истории, списка шар, кросс-спейс доступа.
- Нет external MCP / веб-поиска для анонимов.
- Нет серверного хранения диалогов (эфемерно).
- Нет RAG/вектора — только share-scoped FTS.
- Нет per-share гранулярности — один тумблер на воркспейс.

## Развилки (зафиксированные решения)

| Развилка | Решение | Альтернативы (отклонены) |
| --- | --- | --- |
| Область поиска | **Всё дерево шары** | только открытая страница; все публичные шары воркспейса |
| Движок поиска | **Готовый share-scoped FTS** | share-scoped гибрид/RAG (`hybridSearchByPages`) — отложено |
| Гейтинг | **Один тумблер воркспейса** | per-share флаг; тумблер + опт-ин на шару |
| Хранение диалогов | **Эфемерно** | отдельная таблица / nullable `creator_id` |

## Осталось решить (не блокирует)

- Точные числа лимитов: IP rate-limit (старт ~5/мин), max длина сообщения, max число
  сообщений в запросе, `stepCountIs` (старт 5).
- UX виджета: плавающая кнопка vs боковая панель vs блок под контентом.
- Финальная формулировка запертого промпта (персона + safety-блок).

## Объём работ

~2 новых серверных файла (controller + service) + tools-метод `forShare` + share-промпт +
IP-троттлер + одно поле настройки и свитч в админке; на клиенте — виджет и лёгкий
чат-компонент. **Без миграций БД.** Пользовательского агента не трогаем.

## Возможные расширения (следующие итерации)

- **Share-scoped гибрид/RAG**: вариант `hybridSearch` с фильтром `pageId IN allowedPageIds`
  (вектор + FTS) вместо `space_id IN (...)` — качественнее ответы, но зависит от индексации.
- **Per-share гранулярность**: флаг на конкретную шару поверх мастер-тумблера.
- **Лёгкая аналитика/аудит**: отдельная таблица для анонимных диалогов (если понадобится),
  не нарушая `ai_chats.creator_id NOT NULL`.
