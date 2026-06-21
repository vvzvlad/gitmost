# Отложенные интеграционные тесты `AiChatService.stream`

Статус: **открыто.** Это остаток от прежнего документа
`feature-test-coverage-deferred.md` (хвост тест-плана PR #49). Два из трёх
его разделов уже закрыты новой интеграционной обвязкой против реального
Postgres/Redis (`apps/server/test/integration/`, PR #115):

- ✅ **Раздел 1 — repo-тесты против БД.** Закрыт `ai-agent-roles-repo`,
  `ai-chat-repo-find-by-creator`, `page-template-references-cascade`,
  `workspace-repo-update-setting` (`*.int-spec.ts`).
- ✅ **Раздел 2 — достоверность Lua-окна cost-cap против реального Redis.**
  Закрыт `public-share-workspace-limiter.int-spec.ts`.
- ⬜ **Раздел 3 (ниже) — полная интеграция `AiChatService.stream`.** Всё ещё
  не реализован; держим запись открытой, чтобы тест-долг не потерялся при
  удалении исходного документа.

## Полная интеграция `AiChatService.stream` (рефактор R1-stream)

`apps/server/src/core/ai-chat/ai-chat.service.ts`. В PR #49 извлечён и
покрыт только чистый `buildErrorAssistantRecord`. Полные интеграционные
сценарии всё ещё отложены:

- **Запись чата, упавшего на первом ходу** (`onError`) — ассистентская
  запись об ошибке должна сохраняться, даже когда первый ход стрима падает.
- **Жизненный цикл external-MCP клиентов** — клиенты закрываются и при
  `throw`, и при `onFinish` (нет утечки соединений).
- **Анти-tamper: история восстанавливается из БД, а не из `body.messages`** —
  клиент не может подменить историю через тело запроса.

Эти сценарии требуют сидирования SDK `streamText` (инъекция/seam колбэков
`onError` / `onFinish` / `onAbort` + `res.hijack`). Отложено, чтобы не
дестабилизировать 287-строчный `stream()`; делать вместе с выносом testable
turn-pipeline.
