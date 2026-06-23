# Атрибуция комментариев (и записей) от MCP как «AI», а не как пользователь

Статус: **реализовано (#143).** Комментарии и записи страниц, созданные через MCP
(или любым `is_agent`-аккаунтом), помечаются неподделываемым AI-бейджем. Провенанс
выводится из подписанной идентичности на ОБОИХ транспортных швах — REST
(`jwt.strategy`) и collab-websocket (`authentication.extension`) — через общий
`resolveProvenance` (см. `auth-provenance.decorator.ts`), поэтому швы не расходятся.
Документ оставлен как запись дизайна/обоснования; дальнейшая работа по нему не нужна.

## Цель

Комментарий, созданный/зарезолвленный через MCP, на фронтенде помечается AI-бейджем
(как версии страниц в истории), а не выглядит как комментарий обычного участника.
Пометка должна быть **неподделываемой** (выводиться сервером из идентичности, а не из
тела запроса) и **аддитивной** (человек/сервис-аккаунт-автор остаётся, бейдж добавляется
рядом).

## Текущее состояние (почему сейчас «от пользователя»)

1. **Сервер умеет ставить маркер.** `apps/server/src/core/comment/comment.service.ts`
   (~стр. 88–92) при `provenance.actor === 'agent'` пишет в комментарий
   `createdSource: 'agent'` + `aiChatId`; иначе колонка остаётся в дефолте `'user'`.
   Аналогично `resolveComment` (~стр. 235–244) ставит `resolved_source = 'agent'`.
2. **`provenance.actor` берётся только из подписанного JWT.** Декоратор
   `apps/server/src/common/decorators/auth-provenance.decorator.ts` читает
   `request.raw.actor`, который выставляется в
   `apps/server/src/core/auth/strategies/jwt.strategy.ts` (~стр. 80–81) из claim
   `actor` токена. Сделано намеренно, чтобы обычный пользователь не подделал бейдж.
3. **MCP логинится как обычный сервис-аккаунт.** stdio-вариант
   (`packages/mcp/src/stdio.ts:38-39`) создаёт `DocmostClient` по `email`/`password`
   (`packages/mcp/src/client.ts:99-106`) → обычный `POST /auth/login` → access-токен
   **без** claim `actor`. Ветка API-ключа в `jwt.strategy.ts` (~стр. 45–47, 86–110)
   тоже не выставляет `actor`. Итог: `provenance.actor = 'user'` →
   `created_source = 'user'` → комментарий выглядит как от пользователя.
4. **В сайдбаре комментариев бейдж не рисуется.** Репозиторий уже отдаёт `createdSource`
   на фронт (`selectAll('comments')` в
   `apps/server/src/database/repos/comment/comment.repo.ts:34-49`), но клиентский тип
   `IComment` (`apps/client/src/features/comment/types/comment.types.ts`) его не описывает,
   а `apps/client/src/features/comment/components/comment-list-item.tsx` (~стр. 127–162)
   показывает только `comment.creator.name`. AI-бейдж сейчас рендерится **только** в
   истории страниц — `apps/client/src/features/page-history/components/history-item.tsx`
   (компонент `AiAgentBadge`, иконка `IconSparkles`, метка «AI-agent»,
   `lastUpdatedSource === "agent"`).

Колонки БД для этого уже существуют (миграция
`apps/server/src/database/migrations/20260616T130000-agent-provenance.ts`:
`comments.created_source` дефолт `'user'`, `comments.ai_chat_id` nullable,
`comments.resolved_source` nullable). Новых колонок на стороне комментариев не нужно.

## Дизайн

Два независимых куска: бэкенд (проставить провенанс для MCP-идентичности) и фронтенд
(отрисовать бейдж). Они стыкуются через уже отдаваемое поле `createdSource`.

### B1. Бэкенд — пометить MCP-идентичность как «agent» (неподделываемо)

Принцип: пометка выводится из идентичности на сервере, а не передаётся клиентом.
Помечаем сам сервис-аккаунт MCP как агентский — тогда **все** его записи (комментарии,
а также страницы через уже существующий provenance в `page.service.ts`) автоматически
атрибутируются AI, без правок в теле запроса.

1. **Флаг агентской идентичности на пользователе.** Добавить булеву колонку (например
   `users.is_agent`, дефолт `false`) отдельной аддитивной миграцией. Не переиспользовать
   `role` (у него семантика авторизации) и не прятать флаг в `settings` (нужен дешёвый
   фильтр и явность). Обновить тип `Users` в
   `apps/server/src/database/types/db.d.ts` и сущность `User`.
   - Эксплуатация: для MCP завести **отдельный** сервис-аккаунт и выставить ему
     `is_agent = true`. Не помечать обычных людей.
2. **Проставление `actor` в JWT-стратегии.** В
   `apps/server/src/core/auth/strategies/jwt.strategy.ts` после загрузки `user`
   (в ACCESS-ветке `validate`, и зеркально в `validateApiKey`, если MCP когда-то
   перейдёт на API-ключ) выставлять:
   ```ts
   // Derive provenance from the SIGNED identity, never from a client field:
   // an account flagged is_agent stamps every write as 'agent'.
   req.raw.actor = user.isAgent ? 'agent' : ((payload as JwtPayload).actor ?? 'user');
   req.raw.aiChatId = (payload as JwtPayload).aiChatId ?? null; // null for external MCP
   ```
   Внешний MCP не связан с внутренним `ai_chats`, поэтому `aiChatId` остаётся `null` —
   колонка `comments.ai_chat_id` nullable, FK `ON DELETE SET NULL`, это валидно.
3. **Ослабить тип provenance, где он требует `aiChatId: string`.** Сейчас
   `apps/server/src/core/auth/services/token.service.ts` (~стр. 37, 61) и спред в
   `comment.service.ts` исходят из непустого `aiChatId`. Для внешнего MCP нужен
   `aiChatId: string | null`. Декоратор уже возвращает `aiChatId: ... ?? null`, так что
   правка — это только смягчение типа в цепочке `provenance` (тип-уровень), а не логики.
   Запись `createdSource: 'agent', aiChatId: null` в БД корректна.

Почему именно идентичность, а не per-request флаг: (а) неподделываемо «по построению» —
обычный пользователь не сможет получить токен агентской учётки; (б) одной точкой
покрывает и комментарии, и страницы (`page.service.ts` уже читает provenance для
create/rename/move — стр. ~138/234/446/952), то есть MCP-страницы начнут показывать
AI-бейдж в истории **без** доп. фронтенд-работы.

Альтернатива (отклонена): заставить MCP чеканить provenance-токены, как это делает
внутренний AI-чат (`token.service.generateAccessToken(..., {actor:'agent', aiChatId})`,
см. `apps/server/src/core/ai-chat/tools/ai-chat-tools.service.ts:73`). Для внешнего MCP
это тяжелее: он ходит через `performLogin`, у него нет подписывающего секрета сервера, и
provenance всё равно пришлось бы привязать к идентичности. Идентичность-флаг проще и
покрывает оба транспорта.

### B2. Фронтенд — показать AI-бейдж в сайдбаре комментариев

1. **Расширить тип.** Добавить в `IComment`
   (`apps/client/src/features/comment/types/comment.types.ts`) поля
   `createdSource?: string`, `aiChatId?: string | null`, `resolvedSource?: string | null`
   (бэкенд их уже отдаёт через `selectAll`).
2. **Вынести общий бейдж.** Сейчас `AiAgentBadge` локальный внутри `history-item.tsx`.
   Вынести его в переиспользуемый компонент (например
   `apps/client/src/components/ui/ai-agent-badge.tsx`) с опциональным `aiChatId`:
   когда `aiChatId` есть — кликабельный deep-link в чат (поведение истории), когда `null`
   (внешний MCP) — просто метка. Существующая реализация уже корректно ведёт себя при
   `aiChatId == null` (нет курсора/клика).
3. **Отрисовать в `comment-list-item.tsx`** рядом с `comment.creator.name`
   (~стр. 129–131):
   ```tsx
   {comment.createdSource === "agent" && (
     <AiAgentBadge authorName={comment.creator?.name} aiChatId={comment.aiChatId} />
   )}
   ```
4. **(Опционально, в том же объёме) «Resolved by AI».** Поскольку `resolved_source` уже
   пишется, аналогичный маркер можно показать у строки «resolved» в
   `resolve-comment.tsx` / шапке треда. Вынести в отдельный подпункт, если объём растёт.

## Краевые случаи и тонкие места

- **`aiChatId = null` у внешнего MCP** — бейдж некликабелен, FK nullable; проверить, что
  ни сервер (спред в `comment.service`), ни фронт (deep-link) не падают на null.
- **Неподделываемость** — инвариант «`actor` только из серверной идентичности/подписанного
  claim, никогда из тела запроса» обязан сохраниться; покрыть тестом, что обычный
  пользователь не получает `created_source='agent'`.
- **Живое обновление** — WS-событие `commentCreated` несёт весь объект комментария
  (с `createdSource`), значит бейдж появится без перезагрузки. Проверить, что поле не
  теряется на пути WS → стор.
- **Уведомления/watchers** — автор остаётся сервис-аккаунтом (`creatorId`), нотификации
  работают как раньше; решить, нужно ли вообще слать уведомления о комментариях от AI
  (по умолчанию — оставить как есть).
- **Резолв человеком комментария от AI и наоборот** — `resolved_source` независим от
  `created_source`; UI не должен их путать.
- **Смешанная учётка** — если один и тот же аккаунт используется и людьми, и MCP, флаг
  пометит человеческие действия тоже. Поэтому требование: для MCP — отдельный аккаунт.

## Тесты

- `comment.service` (юнит): `provenance.actor='agent'` → `createdSource='agent'`,
  `aiChatId=null` не ломает вставку; `actor='user'` → дефолт.
- `jwt.strategy` (юнит/инт): `user.isAgent=true` → `req.raw.actor='agent'`; обычный
  пользователь → `'user'`; claim из тела не влияет (анти-spoof).
- Фронтенд (компонентный): `comment-list-item` рендерит бейдж при
  `createdSource==='agent'` и не рендерит при `'user'`; бейдж некликабелен при
  `aiChatId==null`.
- Регрессия: существующие тесты комментариев (`comment.service.spec`,
  `comment.service.behavior.spec`) остаются зелёными.

## Объём и решения, которые надо зафиксировать перед реализацией

- **Охват:** помечать как AI только комментарии или все MCP-записи. Рекомендуется все
  (флаг идентичности это и даёт «бесплатно»; страницы уже поддержаны на бэке и в истории).
- **«Resolved by AI»:** включать в первый заход или отдельным пунктом.
- **Имя/аватар сервис-аккаунта:** независимо от бейджа, разумно назвать учётку «AI» и
  дать аватар-робота — бейдж и имя усиливают друг друга.

## Критерии приёмки

1. Комментарий, созданный через MCP под агентским сервис-аккаунтом, имеет
   `created_source = 'agent'` в БД.
2. В сайдбаре комментариев у такого комментария виден AI-бейдж рядом с именем автора;
   у обычного — нет.
3. Обычный пользователь никаким способом (включая поле в теле запроса) не может получить
   `created_source = 'agent'`.
4. Страницы, созданные через MCP, показывают AI-бейдж в истории (следствие B1, без
   доп. фронтенд-работы).
5. Существующие тесты зелёные; добавлены тесты из раздела «Тесты».

## Связанные места (быстрые ссылки)

- Бэкенд-маркер: `apps/server/src/core/comment/comment.service.ts` (create ~88–92,
  resolve ~235–244).
- Провенанс из JWT: `apps/server/src/common/decorators/auth-provenance.decorator.ts`,
  `apps/server/src/core/auth/strategies/jwt.strategy.ts` (~80–81; API-key ~86–110).
- Минтинг provenance-токена (образец внутреннего агента):
  `apps/server/src/core/auth/services/token.service.ts` (~30–77),
  `apps/server/src/core/ai-chat/tools/ai-chat-tools.service.ts` (~53–84).
- Колонки БД: `apps/server/src/database/migrations/20260616T130000-agent-provenance.ts`.
- MCP-аутентификация: `packages/mcp/src/stdio.ts:38-39`,
  `packages/mcp/src/client.ts:99-106`.
- Фронтенд: `apps/client/src/features/comment/types/comment.types.ts`,
  `apps/client/src/features/comment/components/comment-list-item.tsx`,
  образец бейджа `apps/client/src/features/page-history/components/history-item.tsx`
  (`AiAgentBadge`).
