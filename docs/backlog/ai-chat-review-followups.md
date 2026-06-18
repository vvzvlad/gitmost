# Follow-ups код-ревью фичи ai-chat

Контекст: мульти-аспектное ревью встроенного AI-агента (диапазон коммитов
`6e5d0300..4868ca8e`, вся фича ai-chat) прошло чисто по безопасности,
регрессиям и конвенциям. Ниже — находки, которые НЕ блокируют merge, но
должны быть закрыты: пробелы в тестах на критичном по безопасности коде,
доступность с клавиатуры, устаревшая документация и мелкие рефакторинги.
Сгруппировано по приоритету. Каждая запись: что → где (`file:line`) → почему →
фикс.

Сознательно НЕ входят в этот файл (вынесены отдельно): warning про неусечённый
реплей tool-выводов в `ai-chat.service.ts` и архитектурное предложение про
дублирование набора инструментов между in-app агентом и `packages/mcp`.

---

## Приоритет 1 — тесты на критичном по безопасности коде (warning)

### 1.1 Шифрование ключей провайдеров (AES-256-GCM) — ноль тестов

- **Где:** `apps/server/src/integrations/crypto/secret-box.ts`
  — `encryptSecret` (`:36-48`), `decryptSecret` (`:51-81`), сообщение об ошибке
  (`:78`). Spec-файла нет (подтверждено grep'ом по `*.spec.ts`).
- **Почему:** это единственная защита API-ключей провайдеров в покое. Не
  проверено: round-trip `encrypt → decrypt` возвращает исходный текст; два
  шифрования одного текста дают разные блобы (random salt+iv, layout
  `base64(salt | iv | authTag | ciphertext)`); ветка `catch` бросает ожидаемую
  ошибку «APP_SECRET may have changed» на испорченном/обрезанном блобе или
  неверном ключе (на это сообщение опирается UI). Ошибка в смещениях layout или
  регресс auth-tag молча испортит все сохранённые креды.
- **Фикс:** `secret-box.spec.ts`, 4 кейса — (1) round-trip equality; (2) два
  encrypt одного входа → разные блобы, оба декриптятся; (3) decrypt
  подделанного ciphertext / флипнутого байта auth-tag → throw с нужным
  сообщением; (4) decrypt под другим `APP_SECRET` → throw. `EnvironmentService`
  тривиально стабается (`getAppSecret`).

### 1.2 SSRF-guard — ветки allow/deny полностью не покрыты

- **Где:** `apps/server/src/core/ai-chat/external-mcp/ssrf-guard.ts`
  — `isIpAllowed` (`:40`), `isUrlAllowed` (`:60-104`); `isIpAllowed`
  вызывается для IP-литерала (`:80`) и для каждого DNS-резолва (`:97`).
- **Почему:** единственная защита от SSRF для admin-задаваемых URL внешних
  MCP-серверов; тестов нет. Каждая непокрытая ветка = реальный эксплойт:
  loopback (127.0.0.1, ::1), link-local/metadata (169.254.169.254), private
  (10/172.16/192.168), CGNAT (100.64/10), ULA (fc00::/7), unspecified,
  IPv4-mapped IPv6, не-http(s) схема, невалидный URL, DNS-rebinding (любой
  резолвнутый адрес приватный ⇒ block). `isIpAllowed` — чистая синхронная
  функция.
- **Фикс:** `ssrf-guard.spec.ts` — `isIpAllowed` по каждому блокируемому классу
  + публичный IP (allow); `isUrlAllowed` — bad-scheme, invalid-url,
  IP-литерал-private и (с моком `dns.lookup`) кейс rebinding, где
  резолвнутый адрес приватный.

### 1.3 `assistantParts()` — логика «сохранить ошибки/tool-calls в истории» без тестов

- **Где:** `apps/server/src/core/ai-chat/ai-chat.service.ts`
  — `assistantParts` (`:430-495`), родственные `serializeSteps` (`:610`),
  `rowToUiMessage`. Spec'а у сервиса нет.
- **Почему:** чистая функция, чей вывод определяет, переиграется ли диалог.
  Ключевая ветка (`:472-486`) эмитит синтетический `output-error` для tool-call
  без пары — чтобы `convertToModelMessages` не бросил `MissingToolResultsError`
  на следующем ходу. Это суть фиксов видимости ошибок (`dbd83b5a`/`4868ca8e`).
  Регресс, убравший пару, молча вернёт краш. Не покрыты также ветки: step с
  текстом vs без (`:451-453`, `:489-492`), call с результатом
  (`output-available`, `:463-471`) vs без, skip битого call
  (`!toolName || !toolCallId`, `:461`).
- **Фикс:** экспортировать чистые хелперы (или тонкая обёртка) и в spec
  проверить: парный вызов → `output-available`; непарный → `output-error`; skip
  битых; fallback на единственный `text` при отсутствии step-текста.
  `rowToUiMessage` предпочитает `metadata.parts` над `content`. Тест на ветку
  непарного вызова обязан падать на pre-fix коде.

### 1.4 (suggestion) Ветки парсинга JSON-строковых node-аргументов не покрыты

- **Где:** `apps/server/src/core/ai-chat/tools/ai-chat-tools.service.ts`
  — `patchNode` (`:686-693`), `insertNode` (`:745-752`), `updatePageJson`
  (`:800-809`); сообщения об ошибке `:690`, `:749`, `:804`. Существующий
  `ai-chat-tools.service.spec.ts` покрывает только guardrail `deletePage` +
  наличие инструментов.
- **Почему:** фикс `59b99dba` добавил coercion string→object (то, что чинило
  `insert_node` под OpenAI-tool-calls). Невалидная JSON-строка бросает «node was
  a string but not valid JSON» / «content was a string…»; `updatePageJson`
  различает undefined/null (title-only) vs object vs string-parse. Регресс,
  убравший parse, молча вернёт падение `insert_node` под OpenAI.
- **Фикс:** в существующий spec (он уже стабает фейковый клиент) добавить:
  JSON-строковый `node` парсится и форвардится как объект; невалидная строка →
  throw с нужным сообщением; `updatePageJson` с `content === undefined`
  форвардит `doc === undefined` (title-only), объект проходит как есть.

### 1.5 (suggestion) Фильтр размерности / пустые spaces в поиске эмбеддингов не покрыты

- **Где:** `apps/server/src/database/repos/ai-chat/page-embedding.repo.ts`
  — `searchByEmbedding` (`:143`), early-return на пустом `spaceIds` (`:149`),
  фильтр `model_dimensions = queryEmbedding.length` (`:154` + where в запросе).
- **Почему:** early-return на пустых spaceIds — путь access-scoping с нулевым
  результатом; фильтр размерности существует, чтобы избежать pgvector
  dimension-mismatch, когда остались строки от ранее настроенной модели
  эмбеддингов. Регресс, убравший фильтр, вернёт runtime-краш pgvector.
- **Фикс:** минимум — assert, что `searchByEmbedding(ws, vec, [], n)` → `[]` без
  обращения к БД (ветка чистая). При наличии тест-БД — кейс со смешанными
  размерностями: скорятся только строки той же размерности.

---

## Приоритет 2 — доступность и документация (suggestion)

### 2.1 Два новых кликабельных `div` без клавиатурной доступности (a11y)

- **Где:** `apps/client/src/features/ai-chat/components/ai-chat-window.tsx:342-354`
  (заголовок «Chat history») и
  `apps/client/src/features/ai-chat/components/conversation-list.tsx:107-119`
  (строка диалога, `onClick` на `:118`).
- **Почему:** несемантические элементы с `onClick`, но без
  `role`/`tabIndex`/`onKeyDown` — с клавиатуры/скринридером историю не
  развернуть и прошлый чат не открыть. Это ниже планки самого проекта:
  `apps/client/src/features/comment/components/comment-list-item.tsx` использует
  `role="button"`, и бейдж AI-агента, добавленный в этом же изменении
  (`apps/client/src/features/page-history/components/history-item.tsx:77-79`),
  корректно ставит `role="button"` + `tabIndex={0}` + обработку Enter/Space.
- **Фикс:** применить тот же паттерн к обоим элементам (или Mantine
  `UnstyledButton`).

### 2.2 Устаревший doc-комментарий перечисляет 9 инструментов из текущих ~40

- **Где:** `apps/client/src/features/ai-chat/utils/tool-parts.tsx:1-10`
  (список инструментов на `:8-10`).
- **Почему:** комментарий описывает старый набор; после «expose full Docmost
  toolset» и `drop updateComment` вводит в заблуждение. Не баг — дружелюбные
  подписи `toolLabelKey` всё равно только у перечисленных, остальные идут в
  generic-ветку «Ran tool {{name}}».
- **Фикс:** заменить жёсткий список на «см. `ai-chat-tools.service.ts`» (или
  пометить, что дружелюбные подписи только у инструментов из `toolLabelKey`).

### 2.3 Реализация `secret-box` противоречит схеме крипто в плане

- **Где:** `apps/server/src/integrations/crypto/secret-box.ts:11-48` vs
  `docs/ai-agent-chat-plan.md` §5.3 / §6.3.
- **Почему:** код использует per-record случайную соль
  (`scryptSync(APP_SECRET, salt, 32)`) и layout
  `base64(salt | iv | authTag | ciphertext)`; план описывает фиксированную
  строковую соль `'ai-provider'` и layout без сегмента соли. Реализация лучше,
  но план теперь описывает не те байты на диске — введёт в заблуждение при
  написании ротации/отладке decrypt. План помечен «иллюстративным», поэтому
  suggestion.
- **Фикс:** обновить §5.3 / §6.3 под фактический layout.

---

## Приоритет 3 — стабильность и рефакторинг (suggestion)

### 3.1 Новый чат, упавший на первом ходу, не «усыновляет» созданный сервером chat id

- **Где:** `apps/client/src/features/ai-chat/components/chat-thread.tsx:129-137`
  (`useChat` с `onFinish` на `:136`, без `onError`). Целевой колбэк —
  `onTurnFinished` в
  `apps/client/src/features/ai-chat/components/ai-chat-window.tsx:154-157`
  (инвалидирует `AI_CHATS_RQ_KEY`).
- **Почему:** в AI SDK v6 `onFinish` не срабатывает при ошибке стрима, поэтому
  `onTurnFinished()` не вызывается. Сервер же уже создал строку чата и сохранил
  error-сообщение — но клиент не инвалидирует список чатов и не подхватывает
  новый id: ошибочный чат не появляется в истории до постороннего refresh.
  Alert с ошибкой показывается, так что это UX-несогласованность, не потеря
  данных.
- **Фикс:** передать в `useChat` `onError`, который тоже вызывает
  `onTurnFinished()` (или инвалидирует `AI_CHATS_RQ_KEY` + подхватывает новый
  id).

### 3.2 Дублированный хелпер `isToolPart` в двух компонентах

- **Где:** `apps/client/src/features/ai-chat/components/message-item.tsx:16` и
  `apps/client/src/features/ai-chat/components/message-list.tsx:15` —
  идентичное `type.startsWith("tool-") || type === "dynamic-tool"`. Оба уже
  импортируют из `utils/tool-parts.tsx`.
- **Почему:** копии молча разойдутся, если AI SDK добавит ещё один
  tool-part-дискриминатор.
- **Фикс:** экспортировать `isToolPart` один раз из `tool-parts.tsx` (рядом с
  `getToolName`), импортировать в оба компонента, локальные определения удалить.

### 3.3 Объект `initialValues` формы продублирован дословно

- **Где:**
  `apps/client/src/features/workspace/components/settings/components/ai-mcp-server-form.tsx`
  — `useForm({ initialValues: {...} })` (`:75-82`) и эффект re-hydration
  `form.setValues({...})` (`:87-95`): один и тот же 6-полевой объект из
  `server`.
- **Почему:** должны меняться синхронно; добавить поле в одно и забыть второе —
  лёгкий баг. (В соседнем `ai-provider-settings.tsx` этой проблемы нет — там
  initialValues константны, а эффект мапит из `settings`.)
- **Фикс:** вынести `buildInitialValues(server)` и звать в обоих местах.

### 3.4 Идиома форматирования ошибки провайдера дублирует существующий хелпер

- **Где:** `apps/server/src/core/ai-chat/ai-chat.service.ts:274-275` и `:338-339`
  — инлайн `e?.statusCode ? \`${e.statusCode}: ${e.message}\` : e.message`.
- **Почему:** в `apps/server/src/integrations/ai/ai-error.util.ts` уже есть
  общий `describeProviderError(err)` (импортируется в
  `apps/server/src/integrations/ai/ai.service.ts:14`, используется на `:193`,
  `:210`). Два места в `ai-chat.service.ts` переизобретают его инлайном — формат
  может разойтись.
- **Фикс:** заменить оба инлайн-места на `describeProviderError(err)` (при
  необходимости расширив хелпер fallback-аргументом), чтобы формат ошибок
  провайдера был единым.
