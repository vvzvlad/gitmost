# Выбор agent role карточками в пустом окне чата (вместо выпадающего списка)

Контекст: при создании нового чата identity (agent role) выбирается из
выпадающего списка Mantine `<Select>`. Просьба: заменить список на **карточки
разных цветов с названием identity по центру пустого окна чата**. Клик по
карточке применяет роль; если пользователь карточку не нажал и просто написал
сообщение — срабатывает дефолтный Universal assistant.

Скриншот текущего поведения приложил пользователь: «Agent role» + раскрытый
список (Universal assistant ✓, Пират, Дедушка).

## Как сейчас устроен выбор роли (цепочка)

1. Picker рисуется только для нового чата (`activeChatId === null`), когда есть
   включённые роли, как `<Select label="Agent role">`:
   `apps/client/src/features/ai-chat/components/ai-chat-window.tsx:543-561`.
   Значение `""` → «Universal assistant» (роль `null`); остальные опции —
   `enabledRoles` (эмодзи + имя).
2. Список включённых ролей фильтруется клиентом из всех живых ролей:
   `ai-chat-window.tsx:144-147` (`enabledRoles = roles.filter(r => r.enabled)`).
   Источник — `useAiRolesQuery(windowOpen)`
   (`apps/client/src/features/ai-chat/queries/ai-chat-query.ts:131-137`).
3. Выбранный id хранится в jotai-атоме:
   `apps/client/src/features/ai-chat/atoms/ai-chat-atom.ts:23`
   (`selectedAiRoleIdAtom`, `null` = Universal assistant). Сбрасывается в `null`
   при «New chat»: `ai-chat-window.tsx:168-174` (`startNewChat`).
4. Выбранный id прокидывается в тред и уходит в теле первого запроса:
   `ai-chat-window.tsx:570-578` (`roleId={activeChatId === null ? selectedRoleId : null}`)
   → `apps/client/src/features/ai-chat/components/chat-thread.tsx:95-96, 128-138`
   (`roleIdRef` → `prepareSendMessagesRequest` кладёт `roleId` в body).
   Сервер учитывает `roleId` ТОЛЬКО при создании чата и фиксирует роль навсегда;
   для существующего чата роль читается из строки чата (бейдж в шапке окна:
   `ai-chat-window.tsx:433-440`).
5. Пустая область чата сейчас — бледный текст по центру:
   `apps/client/src/features/ai-chat/components/message-list.tsx:130-140`
   (`<Center>` + `emptyState ?? t("Ask the AI agent anything...")`).
   Важно: `MessageList` УЖЕ принимает произвольный `emptyState: ReactNode`
   (`message-list.tsx:10-33, 64-70`) — этим пользуется публичный шэр.

Данные роли в picker-представлении (доступны не-админам):
`id, name, emoji, description, enabled` —
`apps/server/src/core/ai-chat/roles/ai-agent-roles.service.ts:35-41, 164-173`.
То есть для карточек есть эмодзи и название (описание опционально).

## Желаемое поведение

- Вместо `<Select>` — карточки разных цветов по центру пустого окна чата.
- Каждая карточка = identity (роль), отдельный цвет, по центру эмодзи + имя.
- Отдельная карточка **Universal assistant** (дефолт), подсвечена по умолчанию.
- Клик по карточке выбирает/применяет identity (визуальная подсветка выбранной).
- Если ни одна карточка не нажата и пользователь отправил сообщение → роль `null`
  → Universal assistant (текущая дефолтная ветка сервера).
- После отправки первого сообщения карточки исчезают (чат больше не пуст).

## Ключевое архитектурное решение

Рисовать карточки **как empty-state** окна чата через уже существующий проп
`emptyState` у `MessageList`, а НЕ отдельным блоком над полем ввода. Почему так:

- «посреди пустого окна чата» получается само: `MessageList` оборачивает
  `emptyState` в `<Center>` (`message-list.tsx:130-140`).
- «не нажал и написал сообщение → дефолт» получается само: как только
  `messages.length > 0`, empty-state (и карточки) не рендерится, а
  `selectedRoleId` остаётся `null` → Universal assistant. Никакой логики
  «сбросить выбор при отправке» не нужно.
- Состояние выбора остаётся в том же `selectedAiRoleIdAtom`, поэтому вся
  серверная обвязка (`roleId` в body, фиксация роли при создании чата) **не
  меняется** — изменения чисто фронтовые.

Поток: `AiChatWindow` собирает узел карточек → новый проп `emptyState` у
`ChatThread` → форвард в `MessageList`.

## Состав изменений

1. **Новый компонент `role-cards.tsx`** (+ `role-cards.module.css`),
   `apps/client/src/features/ai-chat/components/`:
   - Пропсы: `roles: IAiRole[]`, `selectedRoleId: string | null`,
     `onSelect: (id: string | null) => void`.
   - Рендер: контейнер карточек с переносом (flex-wrap), по центру:
     - первая карточка — Universal assistant (значение `null`), нейтрально-серая,
       подсвечена когда `selectedRoleId === null`;
     - по карточке на каждую роль: цвет по индексу, по центру эмодзи (если есть)
       + имя; подсвечена когда `selectedRoleId === r.id`.
   - Карточка — `UnstyledButton` (доступность + темизация Mantine). Клик →
     `onSelect(value)`. Выбранная — более яркий бордер/кольцо + галочка.
   - Цвета — фиксированная палитра имён Mantine, циклично по индексу:
     `blue, grape, teal, orange, pink, cyan, lime, indigo, red, violet`.
     Через theme-aware CSS-переменные (корректны и в светлой, и в тёмной теме):
     фон `var(--mantine-color-${c}-light)`, текст
     `var(--mantine-color-${c}-light-color)`, бордер выбранной
     `var(--mantine-color-${c}-filled)`. Universal — `gray`.
   - Раскладка (размер карточек ~100–130px, отступы, hover, кольцо выбора,
     прокрутка при большом числе ролей) — в CSS-модуле; цвет инжектится инлайн.

2. **`ai-chat-window.tsx`**:
   - Удалить блок `<Select>` (`:543-561`) и импорт `Select` (`:9`, используется
     только там — проверить, что `Group/Loader/Tooltip` остаются нужны).
   - Собрать узел карточек только когда `activeChatId === null &&
     enabledRoles.length > 0`, иначе `undefined`.
   - Передать его в `<ChatThread emptyState={...} />` (`:570-578`). Существующее
     `roleId={...}` без изменений.

3. **`chat-thread.tsx`**:
   - Добавить необязательный проп `emptyState?: ReactNode` (импорт `ReactNode`)
     и форварднуть в `<MessageList emptyState={...} />` (`:164`).

4. **`message-list.tsx`** — без изменений (проп `emptyState` уже поддержан).

Иллюстративный набросок (НЕ финальный код), `AiChatWindow`:

```tsx
// Role cards become the empty-state ONLY for a brand-new chat that has roles.
const roleCardsNode =
  activeChatId === null && enabledRoles.length > 0 ? (
    <RoleCards
      roles={enabledRoles}
      selectedRoleId={selectedRoleId}
      onSelect={setSelectedRoleId}
    />
  ) : undefined;
// ...
<ChatThread
  ...
  roleId={activeChatId === null ? selectedRoleId : null}
  emptyState={roleCardsNode}
/>
```

## Краевые случаи

- **Нет включённых ролей** → карточки не показываем (`emptyState = undefined`),
  остаётся обычный дефолтный текст empty-state.
- **Существующий чат** (`activeChatId !== null`) → карточек нет; роль уже
  зафиксирована и показана бейджем в шапке (`ai-chat-window.tsx:433-440`).
- **Сброс выбора** при «New chat» уже делается (`setSelectedRoleId(null)`,
  `startNewChat`) — поведение сохраняется.
- **Много ролей** → контейнер с переносом и прокруткой, чтобы не ломать пустую
  область чата.
- **Тёмная тема** → за счёт `-light`/`-filled` переменных Mantine цвета
  корректны в обеих темах.
- **Эмодзи нет** → карточка показывает только имя (как сейчас в `<Select>`:
  `r.emoji ? ... : ''`).

## Локализация

Новых ключей не требуется: переиспользуем существующие `t("Agent role")` и
`t("Universal assistant")` (есть в `apps/client/public/locales/en-US/translation.json:1220-1221`;
остальные локали падают на ключ — как сейчас у `<Select>`). Если решим добавить
подпись-подсказку (например «или просто начните печатать») — это один новый ключ
в `en-US/translation.json`; по умолчанию в объём не закладываю.

## Режим работы при реализации

Изменение нетривиальное (новый компонент + логика выбора/цветов + интеграция с
empty-state), поэтому — делегирование кодеру с обязательным последующим ревью
(`review` subagent), затем верификация перечитыванием файлов.

## Открытые вопросы (решить перед/во время реализации)

- [ ] Нужна ли карточка Universal assistant отдельной плиткой, или достаточно
      «ничего не выбрано = дефолт»? Предлагается отдельная карточка (явный
      возврат к дефолту после клика по роли) — подтвердить.
- [ ] Показывать ли `description` роли на карточке (есть в picker-view) или
      только эмодзи + имя? По умолчанию — только эмодзи + имя, описание в `title`.
- [ ] Нужна ли подпись-подсказка над карточками (тогда +1 ключ локали).
