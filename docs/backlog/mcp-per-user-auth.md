# Встроенный `/mcp`: авторизация под текущим пользователем (а не сервисным аккаунтом)

Статус: **план, код не менялся.** Фича сервер (`apps/server` + `packages/mcp`).
Затрагивает безопасность — менять аккуратно.

**Решение принято: основной путь — логин/пароль текущего пользователя через
HTTP Basic** (`Authorization: Basic base64(email:password)`). Токен-варианты
(Bearer access-JWT / community PAT / OAuth) описаны ниже как альтернативы и
возможные доработки, но делаем именно логин/пароль.

## Суть

Сейчас встроенный MCP-сервер на `/mcp` ходит в Docmost **под одним сервисным
аккаунтом** (`MCP_DOCMOST_EMAIL` / `MCP_DOCMOST_PASSWORD`). Любой клиент,
подключившийся к `/mcp`, действует с правами этого аккаунта — независимо от того,
кто реально сидит за MCP-клиентом. Это значит: единые CASL-права на всех, нет
атрибуции правок конкретному человеку (в истории страниц всё — от сервисного
юзера), и без env-кредов фича вообще не поднимается (отдаёт `503 "MCP is not
configured"`).

Хотим: чтобы `/mcp` авторизовался **под текущим пользователем** (его логином и
паролем) — тогда каждый запрос исполняется под его CASL-правами, правки
атрибутируются ему, и сервисный аккаунт перестаёт быть обязательным.

## Почему сейчас сервисный аккаунт (контекст)

`/mcp` — **внешний протокольный эндпоинт** (MCP Streamable-HTTP / JSON-RPC). В
сессии MCP нет личности Docmost: сессия идентифицируется случайным UUID
([http.ts:68-74](packages/mcp/src/http.ts#L68-L74), `sessionIdGenerator: () =>
randomUUID()`) и заголовком `mcp-session-id`, а транспорт **не несёт JWT/куку
пользователя**. Поэтому пакет `@docmost/mcp` спроектирован как standalone-клиент:
логинится один раз по `email/password` ([auth-utils.ts:41-86](packages/mcp/src/lib/auth-utils.ts#L41-L86),
достаёт куку `authToken`) и дальше ходит в REST + collab как обычный внешний
клиент.

Контраст — встроенный AI-чат: он крутится **внутри авторизованного NestJS-запроса**,
поэтому чеканит loopback-токен именно текущего пользователя и каждый инструмент
исполняется под его CASL ([ai-chat-tools.service.ts:54-85](apps/server/src/core/ai-chat/tools/ai-chat-tools.service.ts#L54-L85)).
Наша задача — принести эту же модель «per-user токен» во внешний `/mcp`.

**Хорошая новость: клиентская половина уже готова.** `DocmostClient` принимает
union-конфиг — либо `{email,password}` (сервис-аккаунт, вызывает `performLogin`),
либо `{getToken}` (берёт **готовый bare-JWT** пользователя как Bearer и **не**
логинится) ([client.ts:99-160](packages/mcp/src/client.ts#L99-L160),
[client.ts:223-241](packages/mcp/src/client.ts#L223-L241)). Этот `getToken`-вариант
уже используется внутренним AI-чатом. Не хватает только **связки в самом
`/mcp`-хендлере** — он сейчас строит конфиг статически из env.

## Где сейчас живёт код (точные места)

### Хендлер `/mcp` (NestJS-обвязка)
- [mcp.service.ts:114-144](apps/server/src/integrations/mcp/mcp.service.ts#L114-L144)
  `handle(req, res)`: (1) опц. статичный гард `MCP_TOKEN` против
  `Authorization: Bearer` (стр. 118-125); (2) `isEnabled()` — тумблер воркспейса
  `ai.mcp` (403 если выкл.); (3) `credsConfigured()` — наличие env-кредов (**это
  и есть источник твоего `503`**, стр. 132-144); (4) `res.hijack()` и проброс
  raw req/res в MCP-транспорт.
- [mcp.service.ts:47-64](apps/server/src/integrations/mcp/mcp.service.ts#L47-L64)
  `getEmail/getPassword/getApiUrl/credsConfigured` — читают env.
- [mcp.service.ts:85-112](apps/server/src/integrations/mcp/mcp.service.ts#L85-L112)
  `getHandler()` — лениво создаёт **один** HTTP-handler через
  `createMcpHttpHandler({apiUrl,email,password})` и кэширует его.

### MCP-пакет
- [http.ts:13](packages/mcp/src/http.ts#L13) `createMcpHttpHandler(config:
  DocmostMcpConfig)` — принимает **один статический** конфиг; создаёт по
  `McpServer` + транспорту **на каждую сессию** при `initialize`
  ([http.ts:68-82](packages/mcp/src/http.ts#L68-L82): `createDocmostMcpServer(config)`
  → `server.connect(transport)`). Идентичность сессии фиксируется здесь, на
  инициализации.
- [index.ts:50-54](packages/mcp/src/index.ts#L50-L54) `createDocmostMcpServer(config)`
  — пробрасывает union-конфиг в `new DocmostClient(config)`.
- [client.ts:99-160](packages/mcp/src/client.ts#L99-L160) `DocmostMcpConfig` =
  `{email,password} | {getToken}` (+ опц. `getCollabToken`); конструктор
  ветвится: `getToken`-вариант не логинится, использует bare-JWT как Bearer.

### Auth / токены (сервер)
- [token.service.ts:30-54](apps/server/src/core/auth/services/token.service.ts#L30-L54)
  `generateAccessToken(user, sessionId, provenance?)` → JWT `type=ACCESS`.
- [token.service.ts:119-138](apps/server/src/core/auth/services/token.service.ts#L119-L138)
  `generateApiToken({apiKeyId,user,workspaceId,expiresIn})` → JWT `type=API_KEY`.
- [token.service.ts:164-176](apps/server/src/core/auth/services/token.service.ts#L164-L176)
  `verifyJwt(token, type)` — проверка подписи + типа.
- [jwt.strategy.ts:26-34](apps/server/src/core/auth/strategies/jwt.strategy.ts#L26-L34)
  `jwtFromRequest = cookie authToken || Bearer` — **bearer уже принимается** на
  `/api`.
- [jwt.strategy.ts:80-81](apps/server/src/core/auth/strategies/jwt.strategy.ts#L80-L81)
  провенанс: токен без `actor` → `'user'` (нам и нужно — правки как пользователя).
- [jwt.strategy.ts:86-109](apps/server/src/core/auth/strategies/jwt.strategy.ts#L86-L109)
  `validateApiKey` — путь `type=API_KEY` **требует EE-модуль**
  (`ee/api-key/api-key.service`), которого в форке нет → бросает «Enterprise API
  Key module missing». То есть полноценных PAT сейчас **нет**.
- [auth.controller.ts:184-193](apps/server/src/core/auth/auth.controller.ts#L184-L193)
  `POST /auth/collab-token` под `JwtAuthGuard` — выдаёт collab-токен по
  bearer/cookie (этим уже пользуется и сервис-аккаунт, и AI-чат).
- [environment.service.ts:63-64](apps/server/src/integrations/environment/environment.service.ts#L63-L64)
  `JWT_TOKEN_EXPIRES_IN` по умолчанию **`90d`** — access-JWT долгоживущий, годится
  как «токен пользователя».
- [utils.ts:109](apps/server/src/common/helpers/utils.ts#L109)
  `extractBearerTokenFromHeader(req)` — переиспользуемый парсер `Authorization`.
- [migration 20250912T101500-api-keys.ts](apps/server/src/database/migrations/20250912T101500-api-keys.ts)
  — таблица `api_keys` (`id, name, creator_id, workspace_id, expires_at,
  last_used_at, deleted_at`) **уже существует**, но community-сервиса под неё нет.
- [.env.example:72-79](.env.example#L72) — `MCP_DOCMOST_EMAIL/PASSWORD`,
  `MCP_DOCMOST_API_URL`, `MCP_TOKEN`, `MCP_SESSION_IDLE_MS`.

## Как именно логиниться под пользователем — варианты

Пользователь подключает к `/mcp` внешний MCP-клиент (Claude Desktop и т.п.).
Авторизоваться «под текущим пользователем» можно несколькими путями с разной
ценой и безопасностью. Все они сводятся к одному и тому же на уровне клиента:
получить пользовательский JWT и ходить под ним; разница — **откуда** берётся
токен (приносит пользователь / логинит сервер / выдаёт OAuth).

### Вариант L — логин/пароль пользователя через HTTP Basic ✅ ВЫБРАН
MCP-клиент шлёт `Authorization: Basic base64(email:password)`; `/mcp` декодит и
строит per-session конфиг `{email, password}` → `DocmostClient` сам делает
`performLogin` (`POST /auth/login`) и дальше ходит под этим пользователем. Это
**ровно тот же путь, что у сервисного аккаунта сегодня**, только с кредами
текущего пользователя — клиентская механика уже готова
([client.ts:99-160](packages/mcp/src/client.ts#L99-L160),
[auth-utils.ts:41-86](packages/mcp/src/lib/auth-utils.ts#L41-L86)).

- **Плюсы:** минимум нового кода (переиспользуется `{email,password}`-ветка
  `performLogin`); пользователю не надо доставать токен — привычные логин/пароль;
  сервисный аккаунт становится необязательным.
- **Минусы:** **сырой пароль лежит в конфиге MCP-клиента** и уходит на сервер при
  каждом коннекте (токен безопаснее — отзываем/скоупится без смены пароля);
  **не работает с MFA** (статические креды не пройдут интерактивный челлендж) —
  в этом форке MFA-модуль удалён (EE), поэтому сейчас вопрос моот, но при
  возврате MFA или `workspace.enforceMfa` ([auth.controller.ts:64-103](apps/server/src/core/auth/auth.controller.ts#L64-L103))
  путь сломается; **SSO/OIDC**-пользователи могут не иметь локального пароля;
  логин жмёт `/auth/login` throttle ([AUTH_THROTTLER](apps/server/src/core/auth/auth.controller.ts#L41),
  раз на сессию + переавторизация на 401).
- **Вывод:** хорош для single-user self-host без MFA; как дефолт лучше токен.

### Вариант A — pass-through access-JWT (альтернатива / возможна параллельно)
MCP-клиент шлёт `Authorization: Bearer <access-JWT>`, где токен — это значение
куки `authToken` пользователя (валиден 90 дней). `/mcp` извлекает его, валидирует
как `ACCESS`-JWT и передаёт в `DocmostClient` как `getToken`. Все REST + collab
идут под CASL этого пользователя; правки атрибутируются ему (`actor='user'`).

- **Плюсы:** минимальный диф, переиспользует уже готовый `getToken`-путь клиента;
  bearer уже принимается на `/api`; сервисный аккаунт становится необязательным.
- **Минусы:** токен надо достать руками (DevTools → Cookies → `authToken`),
  токен привязан к сессии (логаут/revoke сессии убивает его), он же даёт полный
  доступ как у пользователя (не сужен скоупом). Приемлемо для self-host, но это
  не «красивый» PAT.

### Вариант B — community PAT / API-keys (доработка на будущее)
Реализовать сообществом то, что было в EE: пользователь создаёт в настройках
**именованный, отзываемый, с TTL** персональный токен; его и кладёт в MCP-клиент.

- Таблица `api_keys` уже есть; `JwtApiKeyPayload`+`generateApiToken` есть; не
  хватает **community `ApiKeyService`** (хранить хеш/строку ключа, валидировать
  по `apiKeyId` из JWT, обновлять `last_used_at`, проверять `expires_at`/
  `deleted_at`) + CRUD-эндпоинты + UI выдачи/отзыва.
- Поправить [jwt.strategy.ts:86-109](apps/server/src/core/auth/strategies/jwt.strategy.ts#L86-L109):
  путь `API_KEY` должен звать community-сервис вместо `require('./../../../ee/...')`.
- **Плюсы:** стабильный, отзываемый, именованный токен; не завязан на браузерную
  сессию; виден и управляем в UI. Это «правильный» долгоживущий ответ.
- **Минусы:** заметно больше работы (сервис + контроллер + миграция типов + UI),
  и это самостоятельная фича auth, шире чем сам `/mcp`.

### Вариант C — OAuth 2.1 для MCP (доработка на будущее, «с логином» из коробки)
MCP-спека описывает авторизацию через OAuth 2.1: Docmost поднимает
authorization-server metadata + token endpoint, а MCP-клиент (Claude Desktop)
делает **интерактивный логин** и сам получает токен — это и есть «mcp с логином».

- **Плюсы:** самый стандартный и удобный UX (логин в браузере, без копипасты
  токенов), refresh из коробки.
- **Минусы:** самый большой объём (discovery-эндпоинты, согласие, refresh,
  привязка к существующему JWT-стеку). Избыточно для текущего запроса.

> **Решение:** делаем **L** (логин/пароль через HTTP Basic) основным и
> единственным путём на этот заход. Это закрывает «авторизация под текущим
> пользователем» минимальным кодом (переиспользуется `performLogin`) и привычным
> для пользователя способом — логин/пароль. **A/B/C** оставляем в доке как
> совместимые доработки на будущее: все варианты сходятся в одной точке —
> per-session `DocmostClient` под пользовательским JWT, отличается лишь источник
> токена (`performLogin` от сервера / Bearer от пользователя / PAT / OAuth), так
> что добавить их позже можно поверх той же связки без переделки.

## Детальный дизайн выбранного пути — логин/пароль (HTTP Basic)

Идея: вместо **одного статического** конфига хендлер получает **резолвер конфига
от запроса**, который на инициализации каждой MCP-сессии решает, под кем ходить.
Для выбранного пути резолвер читает `Authorization: Basic`, **валидирует
логин/пароль на сервере** и строит per-session `DocmostClient`, ходящий под этим
пользователем.

### 1) `packages/mcp/src/http.ts` — принять резолвер конфига
```ts
// Accept either a static config (service-account / stdio, unchanged) OR a
// per-request resolver. The resolver runs once per MCP session, at initialize,
// so the session's DocmostClient is bound to that request's identity.
export type McpConfigResolver = (
  req: IncomingMessage,
) => DocmostMcpConfig | Promise<DocmostMcpConfig>;

export function createMcpHttpHandler(
  config: DocmostMcpConfig | McpConfigResolver,
) { /* ... */ }

// inside handleRequest, at session init (POST initialize, http.ts:68-82):
const sessionConfig =
  typeof config === "function" ? await config(req) : config;
const server = createDocmostMcpServer(sessionConfig);
```
Обратная совместимость полная: stdio ([stdio.ts](packages/mcp/src/stdio.ts)) и
существующий вызов с объектом-конфигом работают как раньше (это не функция →
ветка `else`).

### 2) `apps/server/.../mcp.service.ts` — разобрать Basic, провалидировать креды, выпустить токен
Креды валидируем **на сервере** через `AuthService.login` и в конфиг кладём
**уже выпущенный пользовательский JWT** (`getToken`-вариант), а не сам пароль —
тогда пароль не уходит дальше в loopback-клиент, а ошибки логина видны сразу,
чистым JSON-ответом до `res.hijack()`.
```ts
// Resolve the per-session identity from the request. Primary path: HTTP Basic
// (current user's email:password) -> validate on the server -> issue the user's
// JWT -> client acts as that user. Bearer (variant A) and the service account
// (back-compat) are accepted as fallbacks.
private async resolveSessionConfig(req): Promise<DocmostMcpConfig> {
  const auth = req.headers['authorization'] as string | undefined;

  // --- chosen path: Basic login/password ---
  if (auth?.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');           // password may contain ':'
    const email = decoded.slice(0, sep);
    const password = decoded.slice(sep + 1);
    // Single-workspace assumption (loopback) — same as the AI-chat tools path.
    const workspace = await this.workspaceRepo.findFirst();
    // Throws UnauthorizedException('Email or password does not match') on bad
    // creds -> surfaced as a specific 401 (never a generic error). NOTE: calling
    // AuthService.login directly BYPASSES the controller's throttle + MFA gate
    // (both EE/controller-level) — see Security below.
    const authToken = await this.authService.login({ email, password }, workspace.id);
    return { apiUrl: this.getApiUrl(), getToken: async () => authToken };
  }

  // --- fallback A: Bearer access-JWT (user-supplied token) ---
  const bearer = extractBearerTokenFromHeader(req);            // utils.ts:109
  if (bearer) {
    await this.tokenService.verifyJwt(bearer, JwtType.ACCESS); // specific 401
    return { apiUrl: this.getApiUrl(), getToken: async () => bearer };
  }

  // --- fallback B: service account (existing behaviour, optional) ---
  if (this.credsConfigured()) {
    return { apiUrl: this.getApiUrl(), email: this.getEmail()!, password: this.getPassword()! };
  }

  throw new UnauthorizedException(
    'MCP requires Basic auth (email:password) or a Bearer token, ' +
    'or a configured MCP_DOCMOST_EMAIL/PASSWORD service account.',
  );
}
```
- `getHandler()` зовёт `createMcpHttpHandler((req) => this.resolveSessionConfig(req))`
  (резолвер, не статический объект).
- Auth-разбор (Basic decode + `AuthService.login` / `verifyJwt`) делать в
  `handle()` **до** `res.hijack()`, чтобы на плохих кредах вернуть чистый
  `401 {error: "..."}`, а не рвать hijack-нутый ответ. Резолвер тогда может
  просто отдать уже посчитанный конфиг (напр. через `(req.raw as any).__mcpConfig`).
- Проверку `credsConfigured()` (стр. 132-144) **заменить** на «есть Basic ИЛИ
  Bearer ИЛИ env-креды», иначе осмысленный `401/503` (не глотать).
- Инжектнуть в `McpService` `AuthService` (для `login`) и `TokenService` (для
  `verifyJwt` в fallback A); `WorkspaceRepo` уже есть. Подтянуть нужные модули в
  `integrations/mcp`.

### 3) Гард `MCP_TOKEN` — развести с пользовательскими кредами
Сейчас `MCP_TOKEN` едет в `Authorization: Bearer`
([mcp.service.ts:118-125](apps/server/src/integrations/mcp/mcp.service.ts#L118-L125)).
В per-user режиме `Authorization` занят кредами/токеном пользователя. Решение:
- в per-user режиме **убрать** статичный `MCP_TOKEN`-гард на `Authorization`
  (аутентификацией служат сами креды; эндпоинт по-прежнему закрыт тумблером
  воркспейса и сетевой изоляцией), **или**
- если нужен доп. общий шлагбаум — перенести `MCP_TOKEN` в **отдельный заголовок**
  (`X-MCP-Token`), чтобы не конфликтовал с `Authorization`.

### 4) Collab / провенанс — ничего лишнего не нужно
`getCollabToken`-провайдер **не задаём**: `DocmostClient` сам сходит в
`POST /auth/collab-token` с выпущенным пользовательским JWT
([auth.controller.ts:184-193](apps/server/src/core/auth/auth.controller.ts#L184-L193))
и получит обычный пользовательский collab-токен. Так правки через collab
атрибутируются пользователю (`actor='user'` по умолчанию,
[jwt.strategy.ts:80-81](apps/server/src/core/auth/strategies/jwt.strategy.ts#L80-L81)).
Никакого «AI agent»-бейджа здесь не вешаем — это живой человек.

> **Альтернатива по объёму (если не хочется тянуть `AuthService` в McpService):**
> отдать креды как есть в конфиг `{ email, password }` — `DocmostClient` сам
> сделает `performLogin` по loopback (это буквально путь сервис-аккаунта). Минус:
> пароль идёт в loopback-клиент и ошибка логина всплывает позже, из пакета, после
> hijack. Серверная валидация (вариант выше) чище и безопаснее — её и берём.

## Тонкие моменты / edge cases

- **Идентичность привязана к сессии.** `DocmostClient` создаётся один раз на
  MCP-сессию (на `initialize`) и кэширует токен; последующие запросы той же
  `mcp-session-id` пойдут под пользователем, зафиксированным при инициализации.
  Грань безопасности: на повторных запросах **проверять, что предъявленные креды/
  токен резолвятся в того же пользователя** (`email`/`sub`), что и при инициализации
  сессии, иначе `401` — чтобы нельзя было «подсесть» в чужую сессию (session
  fixation / подмена кред).
- **Новая Docmost-сессия на каждый логин.** `AuthService.login` →
  `sessionService.createSessionAndToken` ([auth.service.ts:97](apps/server/src/core/auth/services/auth.service.ts#L97))
  создаёт **запись пользовательской сессии** на каждый MCP-логин. При частых
  реконнектах сессии копятся (idle-eviction MCP-сессий их не чистит). Прикинуть:
  переиспользовать токен в пределах MCP-сессии (одна сессия = один логин, уже так),
  и/или TTL/чистку висящих сессий — отдельной заботой.
- **Истечение токена.** Выпущенный access-JWT живёт 90 дней — на 401 от loopback
  клиент перезайдёт. Удобство Basic: креды у клиента постоянны, поэтому
  переавторизация прозрачна (повторный `login`), в отличие от вручную вставленного
  токена. Опционально — per-session mutable-холдер токена, чтобы переавторизация
  не пересоздавала MCP-сессию.
- **Откат на сервис-аккаунт.** Сохранить как опцию (нет bearer + есть env-креды →
  старое поведение). Это не ломает существующие инсталляции и даёт «безличный»
  режим, где он нужен (CI, скрипты). Если откат нежелателен — сделать его
  переключаемым (`MCP_REQUIRE_USER_TOKEN=true`).
- **Мульти-тенантность / loopback.** `127.0.0.1` не резолвит воркспейс по
  субдомену → таргетится дефолтный воркспейс (та же single-workspace-оговорка,
  что и у сервис-аккаунта и AI-чата, см.
  [ai-chat-tools.service.ts:25-28](apps/server/src/core/ai-chat/tools/ai-chat-tools.service.ts#L25-L28)).
  `jwt.strategy` сверяет `req.raw.workspaceId` с `payload.workspaceId`
  ([jwt.strategy.ts:41-43](apps/server/src/core/auth/strategies/jwt.strategy.ts#L41-L43));
  на loopback `req.raw.workspaceId` не выставлен → проверка проходит. Для
  мульти-воркспейс деплоя нужен явный workspace-скоуп (отдельная задача).
- **Idle-eviction.** Сессии чистятся по `MCP_SESSION_IDLE_MS` (30 мин)
  ([http.ts:21-39](packages/mcp/src/http.ts#L21-L39)) — без изменений; protected
  per-user сессии тоже истекают по бездействию, это ок.
- **Ошибки не глотать.** Невалидный/просроченный токен → `console`/logger с
  полной ошибкой **и** конкретный текст в ответе (реальная причина), не «MCP
  error» (CLAUDE.md «Errors must never be swallowed»). Текущее одноразовое
  warning про отсутствие кредов — оставить/адаптировать.
- **Логи/PII.** Не логировать сам токен. Сейчас `auth-utils` прячет тело ответа
  за `DEBUG` — сохранить этот принцип.

## Безопасность (на ревью проверить отдельно)

- **Прямой `AuthService.login` обходит throttle и MFA-гейт.** Контроллерный
  `/auth/login` защищён `ThrottlerGuard` и (в EE) MFA-проверкой
  ([auth.controller.ts:41](apps/server/src/core/auth/auth.controller.ts#L41),
  [:64-103](apps/server/src/core/auth/auth.controller.ts#L64-L103)); вызывая
  `authService.login` напрямую, мы их минуем. Следствия: (1) **brute-force через
  `/mcp`** — добавить свой rate-limit на неудачные логины `/mcp` (по IP/почте);
  (2) если MFA когда-либо вернётся/`enforceMfa` — Basic-путь должен **повторить
  MFA-гейт или быть запрещён** для MFA-пользователей, а не молча пускать.
- **Креды в логах/трейсах.** Никогда не логировать `Authorization`, decoded
  `email:password` и тело ответа логина (`auth-utils` уже прячет тело за `DEBUG`
  — держать тот же принцип). На ошибке логина — конкретный `401`, но без эха
  пароля.
- Per-user CASL: убедиться, что **все** инструменты идут только через loopback
  REST/collab под пользовательским JWT и нигде не остаётся фолбэка на
  сервис-аккаунт внутри уже инициализированной per-user сессии.
- Привязка к сессии (см. edge case) — анти-fixation проверка `email`/`sub`.
- `MCP_TOKEN`-развод: не оставить «дыру», где `Authorization` молча игнорируется.
- SSO/OIDC-пользователи без локального пароля: Basic для них не сработает —
  вернуть понятный `401`, а не generic (и направить на токен-путь, если он есть).
- Доработка B (PAT): ключ хранить **хешем**, `last_used_at` обновлять, отзыв
  (`deleted_at`) и `expires_at` проверять в `validateApiKey`.

## Миграции / конфиг / env / docs

- **Выбранный путь (Basic):** миграций нет. Обновить
  [.env.example:72-79](.env.example#L72): пометить `MCP_DOCMOST_EMAIL/PASSWORD`
  как **опциональные** (теперь это фолбэк-сервис-аккаунт, а не обязательный),
  описать per-user Basic-режим и (если выбран) `X-MCP-Token`/
  `MCP_REQUIRE_USER_TOKEN`. Обновить README: как прописать в MCP-клиенте
  `Authorization: Basic` (свои email:password) — у клиентов это обычно поле
  «headers» в конфиге сервера.
- **Доработка B (PAT):** `api_keys` таблица уже есть; добавить типы в `db.d.ts`
  (`migration:codegen`), при необходимости — индексы; новый модуль/сервис/контроллер
  и клиентский UI в `apps/client/src/features/.../settings`.

## Тесты / проверка

- **Сервер (`pnpm --filter server test`):**
  - `mcp.service` резолвер: `Basic email:password` → `AuthService.login` зовётся
    с дефолтным воркспейсом → `getToken`-конфиг с выпущенным токеном; неверные
    креды → `401` с конкретным сообщением (не generic); Bearer-fallback →
    `verifyJwt(ACCESS)`; нет ничего + есть env-креды → сервис-аккаунт; нет ничего
    → осмысленный 401/503.
  - **пароль с `:`** парсится корректно (split по первому `:`).
  - анти-fixation: второй запрос с кредами другого пользователя в той же сессии
    → 401.
- **MCP-пакет (`pnpm --filter @docmost/mcp test`):** `createMcpHttpHandler`
  принимает и статический конфиг, и резолвер; резолвер зовётся один раз на
  инициализацию сессии; статический путь (stdio/сервис-аккаунт) не задет.
- **Ручная:** прописать в MCP-клиенте `Authorization: Basic base64(email:pass)`
  своего юзера → проверить, что (1) видны только доступные пользователю спейсы/
  страницы (CASL), (2) правки в истории атрибутируются этому пользователю, а не
  сервисному, (3) без env-кредов `/mcp` работает по логину/паролю, (4) неверный
  пароль → понятная ошибка, а не generic, (5) залогировано без утечки пароля.

## Открытые вопросы

1. ~~Какой путь делаем~~ — **решено: логин/пароль через HTTP Basic** (вариант L).
   A/B/C — совместимые доработки на будущее.
2. **Сервис-аккаунт:** оставить как откат (нет Basic/Bearer → старое поведение)
   или полностью убрать в пользу обязательного per-user логина
   (`MCP_REQUIRE_USER_TOKEN`)?
3. **`MCP_TOKEN`:** убрать в per-user режиме или перенести в отдельный заголовок
   `X-MCP-Token` как доп. общий шлагбаум?
4. **Brute-force / throttle:** добавлять ли свой rate-limit на неудачные логины
   `/mcp` (прямой `AuthService.login` минует контроллерный `ThrottlerGuard`)?
5. **Накопление сессий:** нужно ли чистить/ограничивать Docmost-сессии, создаваемые
   `AuthService.login` на каждый MCP-логин, или достаточно «одна MCP-сессия = один
   логин»?
6. **Серверная валидация vs pass-through:** валидировать креды через
   `AuthService.login` (чище/безопаснее, тянет сервис в McpService) или отдать
   `{email,password}` в `performLogin` пакета (минимум кода)? В дизайне выбрана
   серверная валидация.
7. **Мульти-воркспейс:** loopback таргетит дефолтный воркспейс (как у AI-чата).
   Нужен ли явный workspace-скоуп для мульти-тенант деплоя — или отдельная задача?
