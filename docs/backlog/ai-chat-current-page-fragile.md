# Хрупкая передача «текущей страницы» в AI-агента

Контекст: агент не понимает «эта/текущая страница». В разговоре через
CLIProxyAPI он отвечает «я не вижу текущую страницу» и просит уточнить
id/название. Пользователь сообщает: **без CLIProxyAPI (прямой эндпоинт)
работает**. То есть проблема воспроизводится на прокси-пути, но сама
механика передачи страницы хрупкая по двум независимым причинам (см. ниже),
поэтому фиксируем в беклоге целиком.

## Как сейчас инжектится текущая страница (цепочка)

Страница передаётся **только текстом в системный промпт** — отдельной
строкой. Это единственная точка, где агент узнаёт pageId «этой страницы».
Нет ни инструмента «get current page», ни поля в user-сообщении.

1. Клиент вычисляет `openPage` из роута:
   `apps/client/src/features/ai-chat/components/ai-chat-window.tsx:124-131`
   — `const { pageSlug } = useParams();` →
   `usePageQuery({ pageId: extractPageSlugId(pageSlug) })` →
   `openPage = openPageData ? { id, title } : null`. Передаётся в `ChatThread`
   (`:391`).
2. Транспорт кладёт `openPage` в тело запроса:
   `apps/client/src/features/ai-chat/components/chat-thread.tsx:107-127`
   (`prepareSendMessagesRequest`, поле на `:121`), POST `/api/ai-chat/stream`.
3. Контроллер читает тело СЫРЫМ (намеренно без DTO, чтобы глобальный
   `ValidationPipe { whitelist: true }` не выкинул незадекларированное поле):
   `apps/server/src/core/ai-chat/ai-chat.controller.ts:103-135`
   (`const body = (req.body ?? {}) as AiChatStreamBody;`).
4. Сервис прокидывает `body.openPage` → `openedPage`:
   `apps/server/src/core/ai-chat/ai-chat.service.ts:146-149`
   (тип поля — `:32`, `openPage?: { id?; title? } | null`).
5. `buildSystemPrompt` дописывает строку контекста в системный промпт:
   `apps/server/src/core/ai-chat/ai-chat.prompt.ts:94-101`
   — `The user is currently viewing the page "<title>" (pageId: <id>)...`.
   Добавляется в секцию контекста (после persona, ПЕРЕД safety-framework).
6. Уходит как роль `system` в `streamText({ system, ... })`:
   `apps/server/src/core/ai-chat/ai-chat.service.ts:237-239`
   на OpenAI-совместимый `/chat/completions` по настроенному `baseURL`
   (это и есть CLIProxyAPI):
   `apps/server/src/integrations/ai/ai.service.ts:46-52`
   (`createOpenAI({ apiKey, baseURL }).chat(model)`).

## Хрупкость №1 — клиентская: openPage по исходнику всегда null

`AiChatWindow` примонтирован в глобальной оболочке:
`apps/client/src/components/layouts/global/global-app-shell.tsx:159`,
которую рендерит `Layout` (`apps/client/src/components/layouts/global/layout.tsx:7-19`).
`Layout` — это **pathless родительский layout-роут**
(`<Route element={<Layout/>}>` без своего пути), а сегмент `:pageSlug`
матчится только дочерним роутом `/s/:spaceSlug/p/:pageSlug` → `<Page/>`
(`apps/client/src/App.tsx:56-66`).

В react-router-dom@7.13.1 `useParams()` возвращает
`matches[matches.length-1].params` (проверено в исходнике
`node_modules/react-router/dist/development/chunk-XOLAXE2Z.js:6891-6895`).
На уровне шелла последний матч — это pathless `Layout` (params `{}`),
параметры дочернего роута через `<Outlet/>` родителю НЕ видны. Значит в
`AiChatWindow` `pageSlug === undefined` → `extractPageSlugId(undefined)`
возвращает `undefined` (`apps/client/src/lib/utils.tsx:14-23`) →
`usePageQuery` отключён (`enabled: !!pageInput.pageId`,
`apps/client/src/features/page/queries/page-query.ts:44-52`) →
`openPage = null`.

Ловушка — комментарий «same source the breadcrumb uses». Хлебные крошки
используют ТОТ ЖЕ `useParams()` (`apps/client/src/features/page/components/breadcrumbs/breadcrumb.tsx:37`)
и работают — но лишь потому, что рендерятся ВНУТРИ `<Page/>` (дочерний роут,
где `:pageSlug` уже заматчен). Один хук, разная глубина в дереве → разный
результат.

Косвенное подтверждение того же антипаттерна рядом: `Layout` тоже делает
`const { spaceSlug } = useParams()` (`layout.tsx:8`) и тоже получает
`undefined` → `SearchSpotlight` получает `spaceId={undefined}` и тихо
работает без привязки к спейсу. Никем не замечено, потому что некритично.

**ПРОТИВОРЕЧИЕ, которое надо разрешить перед фиксом:** по исходнику
`openPage` должен быть `null` В ОБОИХ режимах (и через прокси, и напрямую),
а пользователь говорит, что напрямую РАБОТАЕТ. Значит либо рантайм/сборка
расходится с рабочим деревом, либо страница доезжает иным путём. Проверить
фактом (см. открытые вопросы) ДО того, как чинить клиент.

## Хрупкость №2 — прокси: контекст живёт только в system-сообщении

Поскольку pageId передаётся ТОЛЬКО строкой в роли `system`, любой прокси,
который переписывает/дополняет системный промпт, может её потерять или
«утопить». gitmost формирует `system` одинаково независимо от эндпоинта —
строка идентична для direct и для прокси. Значит если напрямую работает, а
через CLIProxyAPI нет, расхождение возникает ВНУТРИ трансляции прокси
(CLIProxyAPI оборачивает CLI-бэкенды — Gemini CLI / Claude Code / Codex /
Qwen — у которых свой объёмный системный промпт; наш system может быть
склеен с их преамбулой, перенесён в `systemInstruction`, обрезан или
недооценён моделью). Пользователь ранее отмечал «она вроде не стирает
системный промпт, а просто дополняет» — это надо подтвердить захватом
реального запроса.

## Открытые вопросы (проверить ДО реализации)

- [ ] Что реально уходит в `system`? Залогировать строку перед `streamText`
      (`ai-chat.service.ts:~237`) и сравнить direct vs proxy — строка должна
      быть БАЙТ-В-БАЙТ одинаковой.
- [ ] Долетает ли `openPage` непустым до сервера? Залогировать `body.openPage`
      в `ai-chat.service.ts:~149` в обоих режимах. Если null даже на direct —
      проблема №1 реальна и для direct (тогда «работает» означало что-то иное).
      Если непустой — клиентская теория про `useParams` неверна для рантайма,
      надо понять почему (другая сборка? другой м压онт?).
- [ ] Что CLIProxyAPI шлёт апстриму? Снять HTTP апстрим-запрос прокси
      (логи прокси / mitmproxy) — присутствует ли строка `pageId: ...` в
      системной инструкции, что отдаётся модели.

## Варианты фикса (выбрать после разрешения противоречия)

Клиентская часть (проблема №1), если подтвердится:
- A. В `AiChatWindow` заменить `useParams()` на `useMatch("/s/:spaceSlug/p/:pageSlug")`
     или `matchPath` по `useLocation().pathname` — матчится по полному URL
     независимо от позиции в дереве. Минимально и точечно.
- B. Завести jotai-атом текущей страницы, который выставляет `Page`
     (он внутри дочернего роута, видит params), и читать его в окне чата.
     Заодно чинит тот же баг в `Layout`/`SearchSpotlight`.

Прокси-устойчивость (проблема №2):
- C. Дублировать контекст страницы НЕ только в system: добавить короткий
     скрытый префикс в user-сообщение, либо дать агенту инструмент
     `get_current_page` (берёт pageId из серверной сессии запроса), чтобы
     идентичность страницы не зависела от сохранности system-промпта прокси.
- D. Если CLIProxyAPI обрезает/переносит system — настроить его так, чтобы
     наш system сохранялся (вне кода gitmost; задокументировать требование).

Рекомендация: сначала разрешить противоречие логами (дёшево), потом A или B
для клиента + C для устойчивости к прокси (C — единственное, что реально
лечит исходный симптом «через прокси не видит страницу»).

## Процесс

- Чистая диагностика на текущий момент, код НЕ менялся.
- Реализация — режим делегирования (по умолчанию): нетривиально (роутинг +
  серверный промпт/инструмент) → general-purpose кодеру, затем обязательный
  прогон `review`.
- Не коммитить; в конце предложить сообщение коммита.
