# Отложенные тесты по фичам с коммита 053a9c0d (хвост от PR #49)

## Контекст

PR #49 («test: cover features since 053a9c0d + repair test tooling») закрыл
основную массу покрытия новых фич gitmost (+~330 тестов: server/Jest,
client/Vitest, editor-ext/Vitest, packages/mcp/node:test) и починил
тест-инструментарий (FIX-0 сломанные спеки transclusion, BUILD-0 сборка
editor-ext перед серверными тестами, INFRA-0 резолв `.tsx` email-шаблонов).

Часть тестов из принятого тест-плана **намеренно отложена** — им нужен
тестовый Postgres, реальный Redis или HTTP/e2e-харнес, которых в проекте
сейчас нет, либо инвазивный рефактор продакшн-кода. Ниже — что осталось и
почему, чтобы не потерять.

---

## 1. Интеграционные тесты против БД (нужен тестовый Postgres)

Сейчас все repo-зависимые проверки делаются на моках; SQL-уровень не
исполняется. Чтобы покрыть это честно, нужен поднимаемый в CI Postgres
(testcontainers или сервис в pipeline) + хелпер миграций.

- **`AiAgentRoleRepo` — изоляция и индексы.**
  `apps/server/src/database/repos/ai-agent-roles/ai-agent-roles.repo.ts`.
  Проверить против реальной БД: `findById`/`listByWorkspace` исключают
  soft-deleted строки; `findById` для roleId из ЧУЖОГО workspace → undefined
  (tenant-изоляция); дубль имени в одном workspace → 23505; то же имя
  переиспользуемо после softDelete (partial unique index
  `WHERE deleted_at IS NULL`, миграция `20260620T120000-ai-agent-roles.ts`);
  одинаковое имя в разных workspace разрешено. Это «хребет» безопасности —
  сейчас только предполагается unit-моками.

- **`AiChatRepo.findByCreator` — join role-badge.**
  `apps/server/src/database/repos/ai-chat/ai-chat.repo.ts` (~:27-70).
  Чат с enabled-ролью → roleName/roleEmoji заполнены; с soft-deleted ролью →
  бейдж NULL; с DISABLED ролью → бейдж NULL (должно совпадать с
  `resolveRoleForRequest`); ORDER BY квалифицирован `aiChats.*` (нет
  ambiguous column после join). Не проверяемо чистым unit-ом.

- **`WorkspaceService.update` / `WorkspaceRepo.updateSetting` — jsonb-merge.**
  `apps/server/src/core/workspace/services/workspace.service.ts` (~:514),
  `apps/server/src/database/repos/workspace/workspace.repo.ts` (~:275).
  Сейчас покрыта только форма вызова сервиса
  (`workspace-html-embed.spec.ts`). Не покрыто (нужна БД): `htmlEmbed:true`
  персистится через jsonb-merge **не затирая** соседние настройки (ai,
  sharing). Это и есть «kill-switch пишется» — критично, что write-половина
  тоггла не ломает остальной settings-namespace.

- **FK `page_template_references` onDelete('cascade').**
  Миграция `20260620T131000-page-template-references.ts`. Проверить, что
  удаление source/reference-страницы каскадит строки ссылок.

## 2. HTTP / e2e-харнес (его нет в apps/server)

- **Public-share ассистент: обход per-IP throttle ротацией XFF, но
  per-workspace cap держит.**
  Контроллер использует стоковый `@UseGuards(ThrottlerGuard)`
  (`apps/server/src/core/ai-chat/public-share-chat.controller.ts`), IP берётся
  из Fastify `trustProxy` → `X-Forwarded-For`. Единственный оправданный e2e
  (named journey «аноним спамит ассистента»): ротация XFF обходит per-IP
  лимит 5/min, но per-workspace cost-cap всё равно отдаёт 429. Требует
  поднятого HTTP-слоя Nest + trusted-proxy конфигурации.

- **Достоверность Lua-окна cost-cap против реального Redis.**
  `apps/server/src/core/ai-chat/public-share-workspace-limiter.ts`
  (`SLIDING_WINDOW_LUA`). Сейчас cap тестируется против TS-реализации
  `FakeRedis` в `public-share-chat.spec.ts` — баг в самой Lua-строке
  (`>=` vs `>`, неверный PEXPIRE) не поймается. Нужен интеграционный тест
  против реального/testcontainers Redis.

## 3. Полная интеграция `AiChatService.stream` (рефактор R1-stream)

`apps/server/src/core/ai-chat/ai-chat.service.ts`. В PR #49 извлечён и
покрыт только чистый `buildErrorAssistantRecord`. Полные интеграционные
сценарии — **запись чата, упавшего на первом ходу** (onError), жизненный
цикл external-MCP клиентов (закрытие при throw/onFinish), и
**история восстанавливается из БД, а не из `body.messages`** (анти-tamper) —
требуют сидирования SDK `streamText` (инъекция/seam колбэков `onError`/
`onFinish`/`onAbort` + `res.hijack`). Отложено, чтобы не дестабилизировать
287-строчный `stream()`; делать вместе с выносом testable turn-pipeline.

---

## Сопутствующие НЕ-тестовые находки

Вынесены в отдельные issues (всплыли во время написания тестов):

- #52 — ai-roles: нет серверной валидации модели роли + дрейф enum драйверов.
- #53 — ws: `invalidateSpaceRestrictionCache` без вызывающих (30с stale-окно).
- #54 — page-embed: серверный guard глубины/циклов раскрытия.
- #55 — transclusion: cycle-guard в `collectPageEmbedsFromPmJson`.
- #56 — test-infra: jest DI + lib0 ESM (16 падающих сьютов).
