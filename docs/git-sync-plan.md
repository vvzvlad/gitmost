# Git-sync: спека реализации (встраивание docmost-sync в gitmost)

Статус: **спецификация, код не менялся.** Детальный план реализации фичи
«двусторонний синк страниц Docmost ↔ локальная git-папка Markdown», встроенной
прямо в gitmost.

Источник движка: `https://gitea.vvzvlad.xyz/vvzvlad/docmost-sync`
(ветка `main`, на момент спеки HEAD `b03eb35`). Все сигнатуры ниже сверены с этим
исходником и с текущим кодом gitmost.

Предыстория и обоснование архитектурных развилок — в бэклоге
[ai-chat-tool-definitions-duplicated.md](backlog/ai-chat-tool-definitions-duplicated.md)
(раздел про дублирование конвертера) и в исходном `SPEC.md` репозитория
docmost-sync (нумерация §-параграфов ниже ссылается на него).

---

## 0. Зафиксированные решения

Из обсуждения архитектуры (выбор пользователя) и трёх суб-решений:

1. **Нативная in-process интеграция.** Никаких REST-к-себе и сервис-юзера: чтение
   через репозитории gitmost, запись тела — через collab `openDirectConnection`,
   триггеры — через `EventEmitter2` вместо поллинга `/recent`.
2. **Встроенный NestJS-модуль** `GitSyncModule` в `apps/server/src/integrations/git-sync`
   с `@Interval`/событиями и **leader-lock на Redis** (single-writer при нескольких
   репликах).
3. **Настройка по спейсам в UI** — флаг в `space.settings.gitSync`, секреты
   (git-remote) — через ENV/`EnvironmentService`.
4. **Конвертер** — вендорим *чистую* часть из docmost-sync в `packages/git-sync`,
   гейт = round-trip-идемпотентность против схемы `@docmost/editor-ext`.
5. **Vault** — **репозиторий на спейс**; `move-to-space` = кросс-репо delete+create.
6. **Провенанс** — отдельное значение `lastUpdatedSource = 'git-sync'`.

Вне scope v1 (как и в SPEC): комментарии (только якоря, без тредов), права/ACL,
вложения как отдельный поток (едут ссылками внутри контента), realtime-подписка
на Hocuspocus (остаётся поллинг-страховка + события).

---

## 1. Архитектура верхнего уровня

```
              gitmost server (NestJS, один процесс)
  ┌─────────────────────────────────────────────────────────────┐
  │ GitSyncModule                                                 │
  │                                                               │
  │  GitSyncOrchestrator  ── @Interval + Redis leader-lock        │
  │     │   (per enabled space: pull-cycle / push-cycle)          │
  │     │                                                         │
  │     ├── engine (vendored docmost-sync, IO инжектируется)      │
  │     │     pull.ts / push.ts / reconcile / layout / stabilize  │
  │     │                                                         │
  │     ├── GitmostDataSource  ── реализует подмножество           │
  │     │     DocmostClient НАТИВНО:                              │
  │     │        reads  → PageRepo / SpaceRepo (Kysely)           │
  │     │        writes → CollaborationGateway.openDirectConnection│
  │     │                 + PageService (create/move/delete/...)  │
  │     │                                                         │
  │     └── VaultGit  ── shell-out в системный git (как есть)     │
  │                                                               │
  │  PageChangeListener  ── подписка на EventName.PAGE_* →        │
  │                          debounce → enqueue push-cycle        │
  └─────────────────────────────────────────────────────────────┘
        ▲ читает/пишет страницы           ▼ git push/pull
  PostgreSQL (pages/spaces)         data/git-sync/<spaceId>/ (vault) → remote
```

Ключ интеграции: движок docmost-sync уже **полностью построен на dependency
injection** — весь внешний IO (REST-клиент, git, файловая система) передаётся
через узкие интерфейсы. Мы НЕ переписываем движок; мы подставляем нативные
реализации в его DI-швы.

---

## 2. Состав вендоринга из docmost-sync

В новый пакет `packages/git-sync` копируем (с сохранением истории смысла —
backport-friendly, как сделано с `packages/mcp`):

### 2.1. Движок (engine) — `src/engine/`
| Файл | Что несёт | IO | Берём |
| --- | --- | --- | --- |
| `pull.ts` | Docmost→FS: reconcile + write + commit + merge | client+git+fs (инжектируется) | да |
| `push.ts` | FS→Docmost: diff + classify + apply + refs | client+git+fs (инжектируется) | да |
| `git.ts` | `VaultGit` — обёртка git shell-out | системный `git` | да, как есть |
| `reconcile.ts` | чистый планировщик | нет | да |
| `layout.ts` | чистый маппер дерево→пути | нет | да |
| `sanitize.ts` | чистая санитизация имён | нет | да |
| `stabilize.ts` | fixpoint-нормализация md (SPEC §11) | нет (lib-вызовы) | да |
| `loop-guard.ts` | `bodyHash` (sha256) | нет | да |
| `settings.ts` | zod-конфиг | `.env` | **адаптируем** (см. §7) |
| `index.ts` | тонкий CLI-скаффолд | — | нет (заменяем на NestJS) |

### 2.2. Конвертер (чистая часть) — `src/lib/`
Из `packages/docmost-client/src/lib/` берём **только** чистый конвертер и формат
файла (collab/auth REST-части НЕ нужны — запись нативная):

| Файл | Экспорт |
| --- | --- |
| `markdown-converter.ts` | `convertProseMirrorToMarkdown(content): string` |
| `collaboration.ts` (только конвертер-функция) | `markdownToProseMirror(md): Promise<doc>` ⚠️ |
| `markdown-document.ts` | `serializeDocmostMarkdownBody`, `parseDocmostMarkdown`, `serializeDocmostMarkdown`, тип `DocmostMdMeta` |
| `canonicalize.ts` | `canonicalizeContent(node)`, `docsCanonicallyEqual(a,b)` |
| `docmost-schema.ts` | tiptap-схема для `markdownToProseMirror` |
| `node-ops.ts`, `diff.ts` | трансформации/диф (нужны транзитивно) |

⚠️ `markdownToProseMirror` физически лежит в `collaboration.ts` docmost-client
(строка 289) — это **чистая** функция (marked→HTML→generateJSON), не путать с
collab/websocket write-path из того же файла, который НЕ берём.

> **Долг (зафиксирован в бэклоге):** это третья копия конвертера (есть в
> docmost-sync, в `packages/mcp`, теперь в `packages/git-sync`). Конвергенция в
> общий пакет — отдельная задача; здесь сознательно вендорим валидированную
> копию ради сохранения идемпотентности.

### 2.3. НЕ берём
`pull`/`push` CLI-обёртки, `roundtrip.ts` (харнес переносим в тесты, см. §13),
`docmost-client` REST-клиент целиком, `lib/collaboration.ts` (websocket-write),
`lib/auth-utils.ts`, `Makefile`, Docker-обвязку docmost-sync.

---

## 3. Главный шов: `GitmostDataSource`

Движок дёргает Docmost через `Pick<DocmostClient, …>`. Мы реализуем класс,
**структурно совместимый** с этими сигнатурами, но нативный внутри. Это
единственный нетривиальный новый код.

### 3.1. Точный набор методов, которых требует движок

Из `pull.ts` (`ApplyPullActionsDeps.client`) и обхода дерева:
```ts
listSpaceTree(spaceId: string, rootPageId?: string): Promise<{ pages: PageNode[]; complete: boolean }>;
getPageJson(pageId: string): Promise<{ id; slugId; title; parentPageId; spaceId; updatedAt; content }>;
```

Из `push.ts` (`ApplyPushDeps.client`):
```ts
importPageMarkdown(pageId: string, fullMarkdown: string): Promise<{ updatedAt?: string; /* … */ }>;
createPage(title: string, content: string, spaceId: string, parentPageId?: string): Promise<{ data: { id: string }; updatedAt?: string }>;
deletePage(pageId: string): Promise<unknown>;
movePage(pageId: string, parentPageId: string | null, position?: string): Promise<unknown>;
renamePage(pageId: string, title: string): Promise<unknown>;
```

Для непрерывного режима/детекции удалений (фаза B+, SPEC §8):
```ts
listRecentSince(spaceId: string | undefined, sinceIso: string | null, hardPageCap?: number): Promise<any[]>;
listTrash(spaceId: string): Promise<any[]>;
restorePage(pageId: string): Promise<unknown>;
```

### 3.2. Маппинг на нативные сервисы gitmost

| Метод адаптера | Нативная реализация |
| --- | --- |
| `listSpaceTree(spaceId)` | `SpaceRepo.findById(spaceId, wsId)` + `PageRepo.getSpaceDescendants(spaceId, { includeContent: false })` → map в `PageNode { id, title, slugId, parentPageId, hasChildren }`. **`complete: true` всегда** (читаем БД, не пагинированный REST) → суппрессия `incomplete-fetch` из SPEC §8 нативно не срабатывает. |
| `getPageJson(pageId)` | `PageRepo.findById(pageId, { includeContent: true })` → `{ id, slugId, title, parentPageId, spaceId, updatedAt, content }`. `content` — ProseMirror JSON в схеме `editor-ext`. |
| `importPageMarkdown(pageId, fullMd)` | `parseDocmostMarkdown(fullMd)` → body; `await markdownToProseMirror(body)` → doc; **запись через collab** (см. §3.3). Вернуть `{ updatedAt }` свежей страницы. |
| `createPage(title, body, spaceId, parent?)` | `PageService.create(userId, wsId, { spaceId, title, parentPageId }, provenance)` → shell; затем тело через collab (§3.3). Вернуть `{ data: { id }, updatedAt }`. |
| `deletePage(pageId)` | `PageService.removePage(pageId, userId, wsId)` (soft-delete → Trash, обратимо). |
| `movePage(pageId, parent, pos?)` | `PageService.movePage({ pageId, parentPageId: parent, position }, movedPage, provenance)`. **`position` обязателен** для Docmost-move — вычисляем `fractional-indexing-jittered` ключ между соседями (соседей берём из `PageRepo`). |
| `renamePage(pageId, title)` | `PageService.update(page, { title }, user, provenance)`. |
| `listRecentSince` | `PageRepo.getRecentPagesInSpace(spaceId, { … })`, фильтр по `updatedAt > since`. |
| `listTrash(spaceId)` | `PageRepo` запрос с `deletedAt IS NOT NULL` по спейсу. |
| `restorePage(pageId)` | `PageService.restore(...)`. |

`userId`/`wsId` берём из конфигурации спейса (сервисный аккаунт воркспейса или
владелец спейса — см. §7). `provenance` всегда несёт `source: 'git-sync'` (§8).

### 3.3. Нативная запись тела (linchpin)

Подтверждено в коде: `CollaborationGateway.openDirectConnection(documentName, context)`
([collaboration.gateway.ts:148](../apps/server/src/collaboration/collaboration.gateway.ts#L148-L150))
+ паттерн `withYdocConnection`
([collaboration.handler.ts:118-133](../apps/server/src/collaboration/collaboration.handler.ts#L118-L133)).
Имя документа — `page.<pageId>` ([getPageId](../apps/server/src/collaboration/collaboration.util.ts#L163-L165)).
Схему берём из `tiptapExtensions` ([collaboration.util.ts](../apps/server/src/collaboration/collaboration.util.ts)).

```ts
// In-process body write — no loopback websocket, no service-user token.
// Mirrors collaboration.handler.ts 'replace' operation exactly.
private async writeBody(pageId: string, prosemirrorJson: JSONContent): Promise<void> {
  const conn = await this.collabGateway.openDirectConnection(
    `page.${pageId}`,
    { actor: 'git-sync' }, // provenance flows into PersistenceExtension (see §8)
  );
  try {
    await conn.transact((doc) => {
      const fragment = doc.getXmlFragment('default');
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      const next = TiptapTransformer.toYdoc(prosemirrorJson, 'default', tiptapExtensions);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(next));
    });
  } finally {
    await conn.disconnect();
  }
  // PersistenceExtension.onStoreDocument persists ydoc+content+textContent
  // consistently, stamps lastUpdatedSource, broadcasts 'page.updated'.
}
```

**Схема-совместимость (критично).** `markdownToProseMirror` производит
ProseMirror JSON в схеме docmost-client, а `TiptapTransformer.toYdoc` валидирует
его в схеме `editor-ext`. Аналогично на чтении `convertProseMirrorToMarkdown`
получает `content` в схеме `editor-ext`. Эти две схемы **должны совпадать по
именам нод/марок/атрибутов**, иначе ноды потеряются. Это и есть гейт §13.1.

---

## 4. `VaultGit` и git-бинарь

`VaultGit` (engine/git.ts) оставляем как есть — он шеллит в системный `git` через
`execFile` (args-массив, без инъекций), всегда `cwd=<vaultPath>`. Константы:
`DEFAULT_BRANCH = "main"`, `BOT_AUTHOR_NAME = "Docmost Sync"`,
`BOT_AUTHOR_EMAIL = "docmost-sync@local"`; в push.ts: `DOCMOST_BRANCH = "docmost"`,
`LAST_PUSHED_REF = "refs/docmost/last-pushed"`, провенанс-трейлеры
`Docmost-Sync-Source: docmost|local`.

**Ops-требование:** в рантайм-образ gitmost добавить пакет `git`
([Dockerfile](../Dockerfile)) — сейчас его там может не быть. Без бинаря
`VaultGit.assertGitAvailable()` падает на старте цикла.

**Модель веток (пер-репо, SPEC §5):** `main` (правит человек/файлы) ↔ `docmost`
(зеркало Docmost, пишет только движок) ↔ `merge-base` как базлайн;
`refs/docmost/last-pushed` — что из `main` уже отражено в Docmost.

---

## 5. Топология vault: репозиторий на спейс

- Корень: `<DATA_DIR>/git-sync/<spaceId>/` — отдельный git-репо на каждый
  включённый спейс. `layout.ts` уже спейс-скоупный (корень спейса → `segments: []`).
- Remote — пер-спейс (из конфигурации спейса/ENV). Изоляция конфликтов, блокировок
  и blast-radius.
- `move-to-space` (страница меняет спейс) → **кросс-репо**: `delete` в исходном
  репо + `create` в целевом. Ловим по событию `PAGE_MOVED_TO_SPACE`.
- Redis-lock ключ — `git-sync:lock:<spaceId>` (§9).

---

## 6. NestJS-модуль `GitSyncModule`

Структура (шаблон — `McpModule`):
```
apps/server/src/integrations/git-sync/
  git-sync.module.ts
  git-sync.constants.ts                # QueueJob/event-имена, дефолты
  services/
    gitmost-datasource.service.ts      # §3 адаптер
    git-sync.orchestrator.ts           # @Interval + leader-lock + цикл по спейсам
    vault-registry.service.ts          # путь vault на спейс, VaultGit-инстансы
    fractional-index.util.ts           # position для move (reuse server util)
  listeners/
    page-change.listener.ts            # подписка на EventName.PAGE_* + debounce
  git-sync.controller.ts               # (опц.) ручной trigger/status для админа
```

```ts
@Module({
  imports: [DatabaseModule, EnvironmentModule, ScheduleModule.forRoot()],
  providers: [
    GitmostDataSourceService,
    GitSyncOrchestrator,
    VaultRegistryService,
    PageChangeListener,
  ],
})
export class GitSyncModule {}
```
- Регистрируем в [app.module.ts](../apps/server/src/app.module.ts) рядом с `McpModule`.
- Зависимости: `PageRepo`/`SpaceRepo` (через `DatabaseModule`), `PageService`,
  `CollaborationGateway` (экспортировать из `CollaborationModule`),
  `EnvironmentService`, ioredis-клиент.
- `ScheduleModule.forRoot()` уже подключается в `TelemetryModule`; повторный вызов
  безопасен, но лучше вынести в общий модуль или убедиться, что forRoot один раз.

---

## 7. Конфигурация

### 7.1. Per-space (UI) — `space.settings.gitSync`
Расширяем существующий паттерн `settings.sharing` / `settings.comments`.

Сервер:
- `UpdateSpaceDto` ([update-space.dto.ts](../apps/server/src/core/space/dto/update-space.dto.ts)):
  добавить `@IsOptional() @IsBoolean() gitSyncEnabled?: boolean;` (+ опц.
  `gitSyncRemote?: string`, если решим хранить remote в БД, а не только в ENV).
- `SpaceService.updateSpace(dto, wsId)`
  ([space.service.ts:120](../apps/server/src/core/space/services/space.service.ts#L120)):
  обработать как `disablePublicSharing`/`allowViewerComments`.
- `SpaceRepo`: добавить `updateGitSyncSettings(spaceId, wsId, prefKey, prefValue, trx?)`
  по образцу `updateSharingSettings`
  ([space.repo.ts:92](../apps/server/src/database/repos/space/space.repo.ts#L92)) —
  jsonb-merge в `settings.gitSync.<key>`.
- Гард: CASL `SpaceCaslAction.Manage / SpaceCaslSubject.Settings` (как в
  [space.controller.ts:147](../apps/server/src/core/space/space.controller.ts#L147)).

Клиент:
- Тоггл в форме настроек спейса
  ([edit-space-form.tsx](../apps/client/src/features/space/components/edit-space-form.tsx))
  через `useUpdateSpaceMutation()` → `updateSpace({ spaceId, gitSyncEnabled })`.
  Образец — `mcp-settings.tsx`. `readOnly` при отсутствии `Manage/Settings`.

Форма `space.settings.gitSync`:
```jsonc
{ "gitSync": { "enabled": true, "remote": "git@…", "branch": "main" } }
```

### 7.2. Секреты/тюнинг (ENV) — `EnvironmentService`
Движковый `settings.ts` (zod, читает `.env`) **заменяем** на чтение из gitmost
`EnvironmentService`: `parseSettings(env)` оставляем как чистую функцию для тестов,
но в проде собираем `Settings` из `EnvironmentService`-геттеров.

Новые переменные (объявить в
[environment.validation.ts](../apps/server/src/integrations/environment/environment.validation.ts)
class-validator-декораторами, геттеры — в
[environment.service.ts](../apps/server/src/integrations/environment/environment.service.ts)):

| ENV | Назначение | Обяз. |
| --- | --- | --- |
| `GIT_SYNC_ENABLED` | глобальный мастер-выключатель | нет (default false) |
| `GIT_SYNC_DATA_DIR` | корень vault'ов (default `<DATA_DIR>/git-sync`) | нет |
| `GIT_SYNC_REMOTE_TEMPLATE` | шаблон remote, напр. `git@host:vault-{spaceId}.git` | нет |
| `GIT_SYNC_SSH_KEY_PATH` / креды remote | доступ к git-remote (secret) | по ситуации |
| `GIT_SYNC_POLL_INTERVAL_MS` | страховочный поллинг (default 15000) | нет |
| `GIT_SYNC_DEBOUNCE_MS` | окно дебаунса событий (default 2000) | нет |
| `GIT_SYNC_SERVICE_USER_ID` | от чьего имени писать в Docmost | да (если синк включён) |

> git-remote = доступ ко всей вики спейса (SPEC §12): креды только в ENV/secret
> store, никогда в БД/коммиты. В UI — только `enabled` (+ опц. имя remote из
> заранее разрешённого списка).

---

## 8. Провенанс и loop-guard

### 8.1. Значение `'git-sync'`
Сегодня `lastUpdatedSource ∈ { 'user', 'agent' }`
([persistence.extension.ts:132-134](../apps/server/src/collaboration/extensions/persistence.extension.ts#L132-L134)).
Добавляем `'git-sync'`:
- `PersistenceExtension`: `context.actor === 'git-sync'` → `lastUpdatedSource = 'git-sync'`.
- Снапшот истории для `'git-sync'` — дебаунс (как у человека), а не немедленный
  (немедленный — только для `'agent'`,
  [persistence.extension.ts:321](../apps/server/src/collaboration/extensions/persistence.extension.ts#L321)).
- Для `create/move/rename/delete` через `PageService` передаём
  `AuthProvenanceData` c `source: 'git-sync'` (тип уже используется для агента —
  расширить допустимые значения; точную форму подтвердить на реализации).
- Клиент: в истории
  ([history-item.tsx:128](../apps/client/src/features/page-history/components/history-item.tsx#L128))
  не показывать агентский бейдж/дип-линк для `'git-sync'`; добавить значение в
  тип [page.types.ts:23-26](../apps/client/src/features/page-history/types/page.types.ts#L23-L26)
  (опц. свой бейдж «sync»).

### 8.2. Подавление петли (SPEC §10)
На pull-стороне игнорируем страницу как «свою запись», если:
`page.lastUpdatedSource === 'git-sync'` **И** `bodyHash(exportedBody)` совпадает
с последним запушенным (`PushedPageRecord.bodyHash` из `push.ts`). После записи в
Docmost сохраняем `updatedAt` ответа, чтобы поллинг-страховка не утянул свою же
запись обратно.

---

## 9. Single-writer (Redis leader-lock)

В кодовой базе `@Interval`-задачи (`trash-cleanup`, `telemetry`, `session-cleanup`)
**не защищены** от мультиинстанса. Для синка добавляем явный лок.

- ioredis уже есть (`RedisModule` из `@nestjs-labs/nestjs-ioredis`,
  [app.module.ts](../apps/server/src/app.module.ts); прямой `RedisClient`
  используется в collab-gateway).
- Лок на спейс: `SET git-sync:lock:<spaceId> <instanceId> NX PX <ttl>`; держим
  цикл только при успехе, продлеваем по heartbeat, освобождаем в `finally`
  (Lua-CAS на удаление по `instanceId`, чтобы не снять чужой лок).
- TTL > максимальной длительности цикла; на краше лок истекает сам.

```ts
// Acquire per-space leadership; returns false if another replica holds it.
private async acquire(spaceId: string): Promise<boolean> {
  const ok = await this.redis.set(`git-sync:lock:${spaceId}`, this.instanceId, 'PX', LOCK_TTL_MS, 'NX');
  return ok === 'OK';
}
```

---

## 10. Планировщик и событийные триггеры

- **События (основной триггер).** `PageChangeListener` подписывается на
  `EventName.PAGE_CREATED | PAGE_UPDATED | PAGE_MOVED | PAGE_SOFT_DELETED |
  PAGE_RESTORED | PAGE_MOVED_TO_SPACE` и job `PAGE_CONTENT_UPDATED`
  ([event.contants.ts](../apps/server/src/common/events/event.contants.ts)).
  Фильтр по `spaceId` (только включённые спейсы) → дебаунс (`GIT_SYNC_DEBOUNCE_MS`)
  → ставит pull/push-цикл спейса в очередь оркестратора.
  - Loop-guard: события от собственных записей (`source==='git-sync'` + совпавший
    хэш) пропускаем (§8.2).
- **Поллинг-страховка.** `@Interval(GIT_SYNC_POLL_INTERVAL_MS)` в оркестраторе:
  по каждому включённому спейсу (под локом) — реконсиляция (`listRecentSince` +
  `listTrash`), ловит пропущенные события и стартовую сверку после простоя
  (SPEC §12).
- Один цикл на спейс за раз (внутри-процессный мьютекс на `spaceId` поверх
  Redis-лока).

---

## 11. Потоки данных (walkthroughs)

### 11.1. Первичный клон спейса (initial clone, SPEC §12)
1. `VaultGit.ensureRepo()` + `ensureBranch('docmost','main')` + `checkout('docmost')`.
2. `dataSource.listSpaceTree(spaceId)` → `{ pages, complete:true }`.
3. `readExisting({ listTracked: () => git.listTrackedFiles('*.md'), readFile })`.
4. `computePullActions({ pages, treeComplete:true, existing })` → план.
5. `applyPullActions(deps, actions, vaultRoot)`: на каждую страницу
   `getPageJson` → `stabilizePageFile(content, meta)` (export→import→export
   fixpoint, SPEC §11) → запись файла; затем `stageAll` + `commit` (трейлер
   `docmost`) на `docmost`; `checkout('main')` + `merge('docmost')`.
6. Зафиксировать max `updatedAt` как стартовый `T_last`; `git push` в remote.

### 11.2. Docmost → FS (pull-цикл)
Триггер: событие/поллинг → (под локом) шаги §11.1 п.1–5 инкрементально. 3-way
merge `docmost→main` делает git: непересекающиеся правки сливаются, реальное
пересечение → conflict-маркеры в файле. **При конфликте push этой страницы в
Docmost блокируется** до ручного резолва (SPEC §9; фаза D).

### 11.3. FS → Docmost (push-цикл)
`runPush(deps, { dryRun })`:
1. `git.ensureRepo` / `isMergeInProgress` (abort при merge) / `checkout('main')`.
2. `stageAll` + `commit('local: working-tree changes')` (локально, в Docmost не шлёт).
3. База диффа: `readRef(LAST_PUSHED_REF)` ?? `docmost`; `revParse('main')` → `pushedCommit`.
4. `diffNameStatus(base, 'main')` → changes; префетч `metaAt(path, side)`.
5. `computePushActions({ changes, metaAt })` → creates/updates/deletes/renamesMoves/skipped.
6. `dryRun` → лог плана и выход (клиент НЕ создаётся).
7. `--apply`: `makeClient(settings)` → наш `GitmostDataSource`;
   `applyPushActions`:
   - update → `importPageMarkdown(pageId, fullMd)` (collab-write, §3.3);
   - create → `createPage(...)` → записать присвоенный `pageId` обратно в meta;
   - delete → `deletePage(pageId)` (Trash);
   - rename/move → `classifyRenameMoves` → `movePage`/`renamePage`;
   - при пустых failures: `updateRef(LAST_PUSHED_REF, pushedCommit)` +
     `fastForwardBranch('docmost', pushedCommit)`.
8. Записать `bodyHash` + `updatedAt` (loop-guard, §8.2); `git push`.

---

## 12. Фазирование

- **A. Каркас + односторонний pull (нативно).** `packages/git-sync` (вендоринг
  §2), `GitmostDataSource` (чтение через репозитории), `GitSyncModule`, конфиг из
  `EnvironmentService`, ручной/однократный pull-цикл на один спейс. **Гейт §13.1.**
- **B. Push + непрерывность.** Нативная запись (§3.3), `runPush`, ветки/refs,
  loop-guard (§8), Redis-лок (§9), `@Interval` + `PageChangeListener` (§10).
- **C. Per-space UI.** `space.settings.gitSync` (§7.1), DTO/сервис/репо/гард,
  тоггл на клиенте, скоуп оркестратора по включённым спейсам.
- **D. Харднинг.** Conflict-gating (SPEC §9), удаления через Trash + git (§5),
  стартовая реконсиляция и `move-to-space` кросс-репо, провенанс на клиенте,
  Dockerfile `git`, полный набор тестов.

---

## 13. Тестирование

### 13.1. Гейт идемпотентности (блокирует фазу B)
Перенести round-trip-харнес docmost-sync (`roundtrip.ts` + `test/fixtures/corpus`)
в тесты `packages/git-sync`, но прогонять **против схемы `editor-ext`**:
`content (editor-ext) → convertProseMirrorToMarkdown → markdownToProseMirror →
TiptapTransformer.toYdoc(…, tiptapExtensions) → fromYdoc → canonicalizeContent`
должно давать `docsCanonicallyEqual === true`. Любая потеря нод/атрибутов =
расхождение схем → чинить `docmost-schema.ts` под `editor-ext`.

### 13.2. Юнит (чистая логика, переносится как есть)
`reconcile` (planReconciliation / decideAbsenceDeletions / mass-delete guards),
`layout` (коллизии/санитизация), `computePullActions`, `computePushActions`,
`classifyRenameMoves`, `bodyHash`.

### 13.3. Интеграция (нативный адаптер)
`GitmostDataSource` против тестовой БД: `listSpaceTree`/`getPageJson` корректно
маппят; `createPage`/`movePage`/`deletePage`/`importPageMarkdown` пишут через
collab и проставляют `lastUpdatedSource='git-sync'`; loop-guard не зацикливается
(write → poll → no-op).

### 13.4. e2e (под локом)
Полный pull→push round-trip на временном vault + временном спейсе: правка в
Docmost доезжает в файл и наоборот; конфликт даёт маркеры и блокирует push.

---

## 14. Риски и открытые пункты

1. **Схема-совместимость конвертера** (§3.3, §13.1) — главный риск; гейт
   обязателен до фазы B.
2. **`AuthProvenanceData`** — точную форму типа подтвердить; возможно, потребует
   расширения enum источника на сервере и в истории.
3. **Согласованность Yjs** — писать строго через `openDirectConnection`/`transact`;
   не трогать `content`-колонку напрямую.
4. **`position` для move** — обязателен в Docmost-move; нужен
   `fractional-indexing-jittered` между соседями (соседей брать сортировкой
   `position COLLATE "C"`).
5. **`git` в рантайме** — добавить в Dockerfile.
6. **`ScheduleModule.forRoot()`** — не задублировать `forRoot`.
7. **Сервисный пользователь записи** (`GIT_SYNC_SERVICE_USER_ID`) — от чьего имени
   идут create/move (влияет на `creatorId`/права); согласовать политику.
8. **Конфликты и удаления** — фаза D строго по SPEC §8/§9 (маркеры никогда не
   уезжают в Docmost).

---

## 15. Чек-лист изменений по файлам

**Новый пакет**
- `packages/git-sync/**` — движок + чистый конвертер (§2), `package.json`
  (`@docmost/git-sync`, `workspace:*`), `tsconfig.json`.

**Сервер (`apps/server/src`)**
- `integrations/git-sync/**` — модуль, оркестратор, адаптер, листенер (§6).
- `app.module.ts` — импорт `GitSyncModule`.
- `collaboration/collaboration.module.ts` — экспорт `CollaborationGateway`.
- `collaboration/extensions/persistence.extension.ts` — источник `'git-sync'` (§8.1).
- `core/space/dto/update-space.dto.ts` — `gitSyncEnabled?` (§7.1).
- `core/space/services/space.service.ts` — обработка флага.
- `database/repos/space/space.repo.ts` — `updateGitSyncSettings` (§7.1).
- `integrations/environment/environment.validation.ts` + `environment.service.ts` —
  новые ENV (§7.2).
- `Dockerfile` — пакет `git`.

**Клиент (`apps/client/src`)**
- `features/space/components/edit-space-form.tsx` — тоггл git-sync.
- `features/space/types` — поле `settings.gitSync`.
- `features/page-history/types/page.types.ts` + `components/history-item.tsx` —
  значение `'git-sync'` в `lastUpdatedSource`.

**Корень**
- `pnpm-workspace.yaml` уже покрывает `packages/*`; `apps/server/package.json` —
  зависимость `@docmost/git-sync: workspace:*`.
