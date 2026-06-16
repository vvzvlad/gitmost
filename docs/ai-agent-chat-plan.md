# Чат с AI-агентом в gitmost

> Статус: проектный документ, готов к реализации.
> Контекст: gitmost — форк Docmost; весь фронтенд EE-кода вырезан (community-сборка),
> но в бэкенде остался каркас AI-функций. Цель — собрать «чат с агентом» (как в
> EE-версии Docmost), но чистой реализацией поверх существующего каркаса.

Документ фиксирует все принятые решения, целевую архитектуру и пошаговый план с
привязкой к конкретным файлам. По нему можно сразу начинать кодить по этапам A…D.

Все комментарии в коде — на английском. Сниппеты ниже иллюстративные (targeted
edits, не полные замены файлов).

---

## 1. TL;DR

1. **Это не «с нуля», а достройка поверх готового каркаса.** Уже есть: схема БД
   чата (`ai_chats`, `ai_chat_messages` с колонкой `tool_calls`), весь AI-стек в
   зависимостях (Vercel **AI SDK v6** `ai`, `@ai-sdk/openai`, `@ai-sdk/google`,
   `@ai-sdk/openai-compatible`, `ai-sdk-ollama`, `@langchain/*`), собственный
   **MCP-тулсет** (`packages/mcp`) и серверный эндпоинт `/mcp`.
2. **Агент — полноценный (чтение + запись).** Пишет без подтверждения; защита от
   необратимого — за счёт того, что агенту доступны **только обратимые** операции
   (история версий + корзина), а перманентное удаление не экспонируется.
3. **Права: две независимые оси.** Агент ходит в Docmost **под JWT текущего юзера**
   (права enforce'ятся самим Docmost через CASL), а к LLM — под системным конфигом
   воркспейса. Ключ LLM никогда не попадает в браузер.
4. **Конфиг провайдера/модели/ключа — только из admin-UI/БД. Env-фолбэка нет.**
   API-ключ шифруется (AES-256-GCM на `APP_SECRET`), хранится вне `settings`/
   `baseFields`, **write-only**, не возвращается ни одним эндпоинтом.
5. **Правки агента видно в истории** через аддитивный маркер (`last_updated_source`
   = `agent` + ссылка на чат), без создания бот-пользователя.
6. **Поиск — оба механизма:** полнотекстовый (сразу, инфраструктура есть) и
   векторный RAG (отдельная стадия D; нужна миграция pgvector + индексатор).

---

## 2. Принятые решения (decision log)

| # | Решение | Обоснование |
|---|---------|-------------|
| D1 | Агент умеет **читать и писать** страницы | запрошено явно |
| D2 | Запись **без подтверждения** | есть история версий + корзина; UX-трения не нужно |
| D3 | Guardrail «ничего необратимо»: агенту **не** экспонируется `permanentlyDelete`/`forceDelete`; удаление = только мягкое (корзина) | единственная необратимая операция в API |
| D4 | Поиск — **оба**: полнотекст сейчас, вектор RAG позже | баланс «быстрый старт / качество» |
| D5 | **Чистая реализация** в форке, не порт EE | форк специально вычищен от EE-кода и лицензии |
| D6 | Агент → Docmost под **JWT юзера** (per-request), а не сервис-аккаунт | пер-юзерные права «бесплатно» через CASL; нет privilege escalation |
| D7 | Маркер «правка агентом» — **аддитивный флаг**, не отдельный бот-юзер | бот сломал бы модель прав, засорил бы контрибьюторов/уведомления |
| D8 | Конфиг провайдера/модели/ключа — **только UI/БД**, env-фолбэка нет | единый источник правды, предсказуемость |
| D9 | API-ключ — **зашифрован** (AES-256-GCM на `APP_SECRET`), вне `settings`/`baseFields`, write-only | защита и от member-read (через API), и от утечки дампа БД |
| D10 | Тулсет агента **расширяется внешними MCP-серверами** (Tavily для веб-поиска и др.), настраиваемыми админом в UI | агенту нужен доступ в интернет/гугл; gitmost выступает MCP-**клиентом** к внешним серверам |
| D11 | **Системное сообщение (system prompt) настраивается** админом в UI | возможность задать роль/тон/правила агента под конкретную инсталляцию |

---

## 3. Текущее состояние (что уже есть / чего нет)

### 3.1. Уже есть в репозитории
- **Схема чата** — миграция `apps/server/src/database/migrations/20260409T132415-ai-chat.ts`:
  - `ai_chats(id, workspace_id, creator_id, title, timestamps, deleted_at)`;
  - `ai_chat_messages(id, chat_id, workspace_id, user_id, role, content, tool_calls jsonb, metadata jsonb, tsv, timestamps)` — обрати внимание на `tool_calls`: схема изначально под **агента с инструментами**;
  - колонка `attachments.ai_chat_id`.
  - Типы уже заведены в Kysely: `apps/server/src/database/types/db.d.ts` (`AiChats`, `AiChatMessages`, и `aiChatId` на attachments).
- **Тип эмбеддингов** — `apps/server/src/database/types/embeddings.types.ts` (`PageEmbeddings`), подключён в `db.interface.ts`. **Но таблицы и pgvector ещё нет** (только тип).
- **AI-стек в зависимостях** — `apps/server/package.json`: `ai` (v6), `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`, `ai-sdk-ollama`, `@langchain/core`, `@langchain/textsplitters`. Ставить ничего не нужно.
- **MCP-тулсет** — `packages/mcp/` (MIT): полноценный набор инструментов (поиск/чтение/создание/правка страниц, node-ops, markdown/prosemirror-конвертация, collab-правки через Hocuspocus). Серверный эндпоинт `/mcp` — `apps/server/src/integrations/mcp/` (`mcp.service.ts`, `mcp.controller.ts`, `mcp.module.ts`).
- **Тумблеры AI в настройках воркспейса** — `settings.ai = { generative, chat, search, mcp }`, апдейт через `WorkspaceRepo.updateAiSettings` (`apps/server/src/database/repos/workspace/workspace.repo.ts`).
- **Очередь `AI_QUEUE`** и хук реиндекса: `onStoreDocument` уже кидает `aiQueue PAGE_CONTENT_UPDATED` (`apps/server/src/collaboration/extensions/persistence.extension.ts`).
- **`TokenService`** — выпуск JWT любого типа: `generateAccessToken`, `generateCollabToken`, `generateApiKey` (`JwtType.API_KEY`) — `apps/server/src/core/auth/services/token.service.ts`.
- **`APP_SECRET`** в env — `EnvironmentService.getAppSecret()`.
- История версий: `page_history` (+ `contributorIds`), `PageHistoryService`, сохранение через `HistoryProcessor.saveHistory`.

### 3.2. Чего нет (надо сделать)
- Серверный слой чата: репозитории + сервис (агентный цикл, стриминг, персист) + контроллер.
- Драйвер LLM (сборка провайдера AI SDK из конфига воркспейса).
- Хранение и шифрование API-ключа + CRUD/Test настроек провайдера.
- Адаптер MCP-тулсета под JWT юзера (внутренний путь, отдельный от `/mcp`).
- Маркер «правка агентом» (колонки + протяжка через collab).
- Пайплайн эмбеддингов/индексации + pgvector (стадия D).
- Весь фронтенд: панель чата + настройки провайдера + бейдж в истории.

---

## 4. Целевая архитектура

```
Клиент (React/Mantine)                Сервер (NestJS/Fastify)
─────────────────────                 ──────────────────────────────
features/ai-chat/                     core/ai-chat/  (новый модуль)
  AiChatPanel  ──SSE stream──────────▶  ai-chat.controller  (CRUD + /stream)
  useChat (@ai-sdk/react)               ai-chat.service     (agent loop)
  ToolCallCard (лог действий)             │  streamText({ model, tools, stopWhen })
  Citations (ссылки на страницы)          ├─▶ integrations/ai      (driver per workspace)
                                          │     └─ AI key из settings (decrypt)
settings/ai/  (admin)                     ├─▶ ai-chat/tools/       (MCP toolset под JWT юзера)
  ProviderForm + Test connection          │     └─ create*/update*/search* → loopback REST/WS as user
                                          └─▶ repos: ai_chats / ai_chat_messages
```

### Две оси авторизации (ключевой принцип)
| Канал | Кто авторизует | Чем |
|-------|----------------|-----|
| Агент → **LLM** | деплой (система) | API-ключ из `settings` воркспейса (расшифрованный на сервере) |
| Агент → **Docmost** | конкретный **юзер** | его JWT (per-request, выписан `TokenService`) |
| Агент → **внешние MCP** (Tavily/веб-поиск и др.) | **админ** воркспейса | per-server креды (зашифрованы, как и LLM-ключ) |

«Кто платит за модель» = воркспейс/деплой; «что агенту можно в вики» = права юзера.
Браузер видит только `/ai-chat/stream` (под сессией юзера); LLM-ключ остаётся на сервере.

---

## 5. Модель данных и миграции

### 5.1. Чат — уже есть
`ai_chats` / `ai_chat_messages` (см. §3.1). Нужны только **репозитории**
(`apps/server/src/database/repos/ai-chat/`): `ai-chat.repo.ts`,
`ai-chat-message.repo.ts`. Типы готовы.

### 5.2. Новая миграция: маркер «правка агентом»
```ts
// pages: provenance of the current state (mirrors lastUpdatedById semantics)
pages.last_updated_source     varchar  default 'user'   // 'user' | 'agent'
pages.last_updated_ai_chat_id uuid     null             // FK -> ai_chats(id)
// page_history: provenance snapshot, copied from pages at save time
page_history.last_updated_source varchar
page_history.ai_chat_id          uuid null
```

### 5.3. Новая миграция: хранение ключа провайдера
```ts
// dedicated table, NEVER selected into workspace baseFields / API responses
ai_provider_credentials(
  id uuid pk,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  driver varchar not null,          // 'openai' | 'gemini' | 'ollama'
  api_key_enc text,                 // AES-256-GCM: base64(iv | authTag | ciphertext)
  created_at, updated_at
)
// unique (workspace_id, driver) — позволяет хранить ключи разных провайдеров
```
Несекретное (driver, chatModel, embeddingModel, baseUrl, dimension, **systemPrompt**)
— в `settings.ai.provider` (видно member'ам, не утечка).

### 5.4. Новая миграция: внешние MCP-серверы
```ts
// per-workspace external MCP servers the agent may use (Tavily, etc.)
ai_mcp_servers(
  id uuid pk,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name varchar not null,            // display name, e.g. 'Tavily'
  transport varchar not null,       // 'http' | 'sse'
  url text not null,                // remote MCP endpoint
  headers_enc text,                 // AES-256-GCM: encrypted JSON of auth headers
  tool_allowlist jsonb null,        // optional: restrict which remote tools to expose
  enabled boolean not null default true,
  created_at, updated_at
)
```

### 5.5. Стадия D: pgvector + эмбеддинги (отдельной миграцией)
```sql
CREATE EXTENSION IF NOT EXISTS vector;
-- таблица page_embeddings под существующий тип PageEmbeddings,
-- колонка embedding vector(<dim>), ANN-индекс (hnsw/ivfflat)
```

---

## 6. Бэкенд

### 6.1. Модуль `core/ai-chat/`
- `ai-chat.controller.ts`:
  - REST: `GET /ai-chat` (список диалогов), `GET /ai-chat/:id/messages`, `POST /ai-chat/:id` (rename), `DELETE /ai-chat/:id`.
  - **`POST /ai-chat/stream`** — стриминг ответа. Под Fastify: `res.hijack()` (паттерн уже применён в `mcp.service.ts`) + `result.toUIMessageStreamResponse()` из AI SDK; отмена LLM-стрима по разрыву соединения (`abortSignal`).
  - Гейт: `JwtAuthGuard` + проверка `settings.ai.chat`. Нет конфига провайдера → 503 «AI provider not configured».
- `ai-chat.service.ts` — агентный цикл:
```ts
// per-request agent loop, bound to the current user.
const result = streamText({
  model: await this.ai.getChatModel(workspaceId),     // provider from workspace settings
  system: buildSystemPrompt(workspace, openedPageCtx),
  messages,                                            // rebuilt from ai_chat_messages
  tools: this.tools.forUser(user, session),           // read+write, scoped by user's JWT
  stopWhen: stepCountIs(8),                            // cap the agent loop (safety)
  abortSignal,
  onFinish: persistAssistantMessage,                  // content + tool_calls (jsonb)
});
```
  - Создание чата при отсутствии `chatId`; генерация заголовка асинхронно дешёвой моделью.
  - Обрезка/суммаризация длинной истории (контекст-окно).
  - Сохранение частичного ответа при abort/ошибке.

### 6.2. Драйвер LLM `integrations/ai/`
```ts
// ai.service.ts — config comes solely from workspace settings (NO env fallback).
async getChatModel(workspaceId: string) {
  const cfg = await this.aiSettings.resolve(workspaceId); // settings.ai.provider + decrypted key
  if (!cfg?.driver || !cfg?.chatModel || (cfg.driver !== 'ollama' && !cfg.apiKey)) {
    throw new AiNotConfiguredException();                 // controller -> 503
  }
  switch (cfg.driver) {
    case 'openai': return createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl })(cfg.chatModel);
    case 'gemini': return createGoogleGenerativeAI({ apiKey: cfg.apiKey })(cfg.chatModel);
    case 'ollama': return createOllama({ baseURL: cfg.baseUrl })(cfg.chatModel); // no key
  }
}
```
Провайдер строится **динамически на воркспейс** (нельзя кешировать один глобальный
клиент). Расшифрованный ключ — в памяти с инвалидацией при сохранении настроек,
либо расшифровка на запрос (дёшево). Ключ не логируется.

> Env-переменные `AI_*` больше не используются. Геттеры `getAiDriver/getAiChatModel/
> getOpenAiApiKey/...` в `environment.service.ts` — удалить, если ничем больше не
> заняты, чтобы не было второго источника правды. `MCP_*` и `APP_SECRET` остаются.

### 6.3. Шифрование `integrations/crypto/secret-box.ts`
```ts
// AES-256-GCM; key derived from APP_SECRET. Server-side only.
const key = scryptSync(env.getAppSecret(), 'ai-provider', 32);
encryptSecret(plain: string): string   // -> base64(iv | authTag | ciphertext)
decryptSecret(blob: string): string    // used only when building the provider
```
Ротация `APP_SECRET` ломает расшифровку старых шифртекстов — документировать (надо
ввести ключ заново), и при ошибке расшифровки отдавать понятное «введите ключ
заново», а не падать.

### 6.4. Настройки провайдера (admin-only)
- `GET /workspace/ai-settings` → `{ driver, chatModel, embeddingModel, baseUrl, hasApiKey }` — **ключ замаскирован**.
- `PATCH /workspace/ai-settings` → `{ driver?, chatModel?, baseUrl?, apiKey? }`:
  - `apiKey` отсутствует → не трогаем; пустая строка → очистить; значение → зашифровать и сохранить.
- `POST /workspace/ai-settings/test` → дешёвый вызов провайдера (`generateText`/ping) → `{ ok } | { error }`; тело ошибки провайдера наружу не отдаём (только статус/короткое сообщение).
- Доступ — admin-ability воркспейса (как `POST /workspace/update`, который проверяет `WorkspaceCaslAction.Manage / WorkspaceCaslSubject.Settings`).

### 6.5. Адаптер инструментов `ai-chat/tools/` (под JWT юзера)
- Оборачиваем логику `packages/mcp` в `tool()` AI SDK. **Внутренний путь — отдельный от кешированного `/mcp`-handler'а** (тот одно-идентичностный, под сервис-аккаунтом).
- Аутентификация — токеном текущего юзера:
```ts
// packages/mcp DocmostMcpConfig becomes a union: credentials OR a token getter.
type DocmostMcpConfig = { apiUrl: string } & (
  | { email: string; password: string }   // external/service: performLogin
  | { getToken: () => Promise<string> }    // internal: carry the user's JWT
);
// ai-chat.service: seed the toolset with the CURRENT user's token
const getToken = async () => this.tokenService.generateAccessToken(user, session.id);
```
  Сейчас `DocmostClient` принимает только `email/password` и зовёт `performLogin`
  (`packages/mcp/src/lib/auth-utils.ts`). Нужно добавить токен-вариант: `login()`
  при наличии `getToken` ставит Bearer из него и **не** логинится; на 401 — заново
  зовёт `getToken()` (кредов для перелогина нет).
- Набор инструментов: **read** (`searchPages`, `getPage`) + **write** (`createPage`,
  `updatePage`, `movePage`, `deletePage` — только мягкое). **Не экспонировать**
  `permanentlyDelete`/`forceDelete` (D3). Удаление комментариев — по решению, мягко
  или не давать.
- Права — каждый tool-вызов идёт под JWT юзера через loopback REST/WS → Docmost CASL
  проверяет всё сам. Дополнительного слоя авторизации в адаптере не нужно.

### 6.6. Маркер «правка агентом» — протяжка
- **Носитель** — claim в collab-токене (подписан, поэтому доверенный). Расширить
  `TokenService.generateCollabToken(user, workspaceId, provenance?: { actor: 'agent'; aiChatId })`.
- `apps/server/src/collaboration/extensions/authentication.extension.ts` (`onAuthenticate`,
  `verifyJwt(token, JwtType.COLLAB)`) → положить в контекст: `context.actor`, `context.aiChatId`.
- `apps/server/src/collaboration/extensions/persistence.extension.ts` (`onStoreDocument`):
```ts
await this.pageRepo.updatePage({
  content: tiptapJson, textContent, ydoc: ydocState,
  lastUpdatedById: context.user.id,             // human stays the responsible author
  lastUpdatedSource: context.actor ?? 'user',   // additive provenance marker
  lastUpdatedAiChatId: context.aiChatId ?? null,
  contributorIds,
}, pageId, trx);
// also add `source` to broadcastStateless('page.updated') so live viewers see it
```
- `PageHistoryRepo.saveHistory` (`apps/server/src/database/repos/page/page-history.repo.ts`):
  копировать `lastUpdatedSource`/`aiChatId` со страницы (как уже делается для
  `lastUpdatedById`). История-джоба коалесцируется по `jobId: page.id` и перечитывает
  страницу — поэтому маркер удобнее хранить на `pages`, а не в payload джобы.
- REST-путь (`page.service.ts` rename/move): инструменты передают `source: 'agent'` +
  `aiChatId`, сервис проставляет те же поля.
- Audit: действия агента писать в `AuditEvent` с `source: 'agent'` + `aiChatId` (без значения ключа LLM).
- Тонкость: если правка человека и агента схлопнутся в один снапшот, `last_updated_source`
  отразит последнего писавшего — для «видно, что агент приложил руку» достаточно;
  поблочная атрибуция — отдельная задача, не для v1.

### 6.7. Ретрив
- **Стадия 1 (сразу):** инструмент `searchPages` поверх существующего полнотекстового
  поиска (Postgres `tsvector`). Инфраструктура есть.
- **Стадия D:** индексатор в `AI_QUEUE` (чанкинг `@langchain/textsplitters` → эмбеддинги
  по конфигу воркспейса → `page_embeddings`), инструмент `semanticSearch` (embed запроса
  + pgvector similarity). Реиндекс по `PAGE_CONTENT_UPDATED` (хук уже есть). Правки
  агента реиндексируются автоматически.

---

## 7. Фронтенд

### 7.1. Фича `apps/client/src/features/ai-chat/` (шаблон — `features/comment/`)
- Правая панель/aside: `AiChatPanel`, `ConversationList`, `MessageList`, `MessageItem`
  (markdown + карточки tool-calls как лог действий + цитаты-ссылки на страницы), `ChatInput`.
- Стриминг — хук `useChat` из `@ai-sdk/react`, направленный на `/ai-chat/stream`;
  он ведёт состояние сообщений. Подтверждения write-операций **нет** (D2) — tool-calls
  рисуются как лог выполненного.
- Точка входа — кнопка в шапке/aside; строки в i18n (i18next).

### 7.2. Настройки провайдера (admin)
Раздел «AI / Модели» в настройках воркспейса:
- дропдаун провайдера → динамические поля (OpenAI: key + опц. Base URL + chat model;
  Gemini: key + model; Ollama: Base URL + model, без ключа); поле эмбеддинг-модели;
- поле ключа: при наличии — плейсхолдер «•••• задан», ввод заменяет, пусто = не менять;
- кнопка **Test connection**; сохранение.

### 7.3. Бейдж в истории версий
На версиях с `last_updated_source = 'agent'` — бейдж «AI-агент» рядом с аватаром
человека, тултип «Изменено AI-агентом от имени {имя}», ссылка на чат по `ai_chat_id`.
Бейдж добавляется, автор не заменяется.

---

## 8. Безопасность (чеклист — читать до старта)
1. API-ключ **только зашифрованным** (AES-256-GCM на `APP_SECRET`), вне `settings`/`baseFields`; в ответах — маска/`hasApiKey`.
2. Ключ — **write-only**: PATCH принимает, GET никогда не возвращает (даже зашифрованным).
3. Расшифровка/использование — только на сервере; ключ не уходит в браузер, не пишется в логи/audit/тела ошибок (в т.ч. в ответ Test connection).
4. Доступ к настройкам провайдера — под admin-ability воркспейса.
5. Агент → Docmost строго под **JWT юзера**; внутренний путь не переиспользует сервис-аккаунтовый `/mcp`-handler. Никакого обхода CASL.
6. Агенту экспонируются **только обратимые** инструменты (D3): нет перманентного удаления.
7. Лимит шагов агентного цикла (`stopWhen`), таймауты; rate-limit запросов чата на юзера через `integrations/throttle`.
8. Все запросы скоупятся по `workspace_id`.
9. Внимание к `/workspace/info`: он отдаёт `settings` **любому участнику** (только `JwtAuthGuard`, без admin-гейта) — поэтому секрет туда класть нельзя.

---

## 9. План реализации по этапам

### Этап A — бэкенд-ядро (без записи, без RAG)
1. Репозитории `ai_chats`/`ai_chat_messages`.
2. Миграция + хранилище ключа (`ai_provider_credentials`) + `secret-box` (шифрование).
3. `integrations/ai` драйвер (конфиг только из настроек воркспейса).
4. Настройки провайдера: GET (маска) / PATCH (write-only ключ) / Test connection, admin-only.
5. Модуль `core/ai-chat` (CRUD диалогов + `POST /ai-chat/stream` через SSE).
6. Агентный цикл с **read**-инструментами + `searchPages` (полнотекст).
7. Гейт `settings.ai.chat`, 503 при отсутствии конфига.
- → `review`-субагент → верификация.

### Этап B — запись + маркер агента
1. Токен-вариант в `packages/mcp` (`getToken`) + адаптер инструментов под JWT юзера.
2. **Write**-инструменты (только обратимые), под CASL.
3. Миграция маркера (`pages`/`page_history`), claim в collab-токене, протяжка через
   `authentication.extension` / `persistence.extension` / `saveHistory`.
4. Audit-события действий агента.
- → `review` → верификация.

### Этап C — фронтенд
1. Панель чата на `useChat` (список диалогов, стрим, tool-calls как лог, цитаты).
2. Раздел настроек «AI / Модели» (провайдер, ключ, модель, Test connection).
3. Бейдж «AI-агент» в истории версий. i18n. Точка входа.
- → `review` → верификация.

### Этап D — векторный RAG
1. Миграция pgvector + `page_embeddings` (+ pgvector в Docker/CI образе Postgres).
2. Индексатор в `AI_QUEUE` (чанкинг + эмбеддинги), реиндекс по `PAGE_CONTENT_UPDATED`.
3. Инструмент `semanticSearch`. Конфиг эмбеддинг-модели — в настройках провайдера.
- → `review` → верификация.

Каждый этап делегируется coder-агенту с детальным брифом, затем обязательный
`review`-субагент и верификация ведущим.

---

## 10. Зависимости (npm)
Всё уже в `apps/server/package.json`: `ai` (v6), `@ai-sdk/openai`,
`@ai-sdk/google`, `@ai-sdk/openai-compatible`, `ai-sdk-ollama`, `@langchain/core`,
`@langchain/textsplitters`. На фронт — `@ai-sdk/react` (проверить наличие; при
отсутствии добавить). Доп. инфраструктура для стадии D: pgvector в образе Postgres.

> Перед кодом подтянуть актуальную доку AI SDK v6 (`streamText` + `tools` + `stopWhen`,
> `toUIMessageStreamResponse`, `useChat`) через context7 — в v6 API заметно отличается
> от v4/v5.

---

## 11. Подводные камни
- **AI SDK v6 ≠ v4/v5** — сверять API по докам, не по памяти.
- **Стриминг под Fastify** — `res.hijack()`, отмена LLM-стрима по разрыву, персист частичного ответа.
- **Per-workspace провайдер** — не кешировать один глобальный клиент; не логировать ключ.
- **Токен юзера и время жизни** — выписывать на сообщение; для длинных turn'ов — `getToken()`-рефреш.
- **Коалесцинг истории** — маркер хранить на `pages`, не в payload джобы.
- **Ротация `APP_SECRET`** — старые ключи перестают расшифровываться (внятная ошибка, не падение).
- **pgvector в окружении** — образ Postgres должен иметь расширение `vector` (docker-compose/CI).
- **`/workspace/info` отдаёт `settings` любому member'у** — секрет туда нельзя.

---

## 12. Открытые вопросы (зафиксировать до/во время реализации)
- Выбор модели: v1 — одна модель на воркспейс (из настроек). Пер-чатовый пикер из
  allowlist — возможное расширение (поле модели в `ai_chats`/`metadata` + дропдаун).
- Удаление комментариев агентом — давать мягко или не давать вовсе.
- Хранить ключи нескольких провайдеров одновременно (таблица `ai_provider_credentials`
  с `unique(workspace_id, driver)`) или один активный — влияет только на UX переключения.
- Лимиты стоимости (потолок токенов на диалог) — нужно ли в v1.

---

## 13. Чеклист реализации
- [ ] A1 репозитории чата
- [ ] A2 миграция + `ai_provider_credentials` + `secret-box`
- [ ] A3 драйвер `integrations/ai` (конфиг только из БД)
- [ ] A4 настройки провайдера: GET (маска) / PATCH (write-only) / Test, admin-only
- [ ] A5 модуль `core/ai-chat` (CRUD + SSE-стрим)
- [ ] A6 агентный цикл + read-инструменты + полнотекстовый `searchPages`
- [ ] A7 гейт `settings.ai.chat` + 503
- [ ] B1 токен-вариант `packages/mcp` + адаптер под JWT юзера
- [ ] B2 write-инструменты (только обратимые)
- [ ] B3 маркер агента (миграция + collab-протяжка + `saveHistory`)
- [ ] B4 audit-события агента
- [ ] C1 панель чата (`useChat`)
- [ ] C2 настройки провайдера в UI
- [ ] C3 бейдж в истории версий + i18n
- [ ] D1 миграция pgvector + `page_embeddings`
- [ ] D2 индексатор + реиндекс по событиям
- [ ] D3 инструмент `semanticSearch`
