# Лимит шагов AI-агента (8 → 20) и принудительный финальный ответ

Контекст (симптом из реального чата): на узкий поисковый вопрос («Какой
процессор в первой версии Яндекс.Колонки?») агент сделал подряд ~8 вызовов
`Search_tavily_search` / `Search_tavily_extract` и **остановился без текстового
ответа** — ход завершился пустым. Пользователь отправил «?», что стартовало
новый ход с новым бюджетом, и агент продолжил. Причина — жёсткий потолок в
8 шагов на один ход агента: бюджет был израсходован на инструменты раньше, чем
модель дошла до шага с финальным текстом.

Хотим две вещи:
1. поднять лимит шагов с 8 до 20;
2. гарантировать непустой ответ — на последнем шаге принудительно запрещать
   инструменты, чтобы модель синтезировала лучший ответ из уже собранного.

## Как сейчас устроен лимит (цепочка)

Единственная точка ограничения — `stopWhen` в вызове `streamText`:

- Импорт условия: `apps/server/src/core/ai-chat/ai-chat.service.ts:7`
  (`stepCountIs` из `ai`).
- Потолок: `apps/server/src/core/ai-chat/ai-chat.service.ts:247`
  — `stopWhen: stepCountIs(8)` внутри `streamText({...})` (вызов начинается на
  `:237`).
- Системный промпт, который уходит в `streamText({ system, ... })`, собирается
  заранее в локальной переменной `system`:
  `apps/server/src/core/ai-chat/ai-chat.service.ts:146-150`
  (`buildSystemPrompt({...})`). Эта переменная в области видимости рядом с
  вызовом `streamText` — её можно переиспользовать в `prepareStep`.
- Терминальные колбэки `onFinish` / `onError` / `onAbort`
  (`ai-chat.service.ts:249-301`) сохраняют ответ ассистента через
  `persistAssistant` (`:210-230`). При пустом ходе `onFinish` приходит с
  `text === ''`, и в историю пишется пустое сообщение — это и видит пользователь
  как «агент ничего не ответил».

### Что такое «шаг» (семантика AI SDK v6)

Один шаг = одна генерация модели. Если в шаге есть вызовы инструментов, они
выполняются, результат возвращается модели, и запускается следующий шаг.
`stopWhen: stepCountIs(N)` останавливает цикл, как только число завершённых
шагов достигает `N`. Цикл также завершается естественно, если модель сделала шаг
**без** вызова инструментов (выдала финальный текст).

Важно: `stepNumber` в `prepareStep` нумеруется с нуля; последний из `N` шагов —
это `stepNumber === N - 1`. Один шаг может содержать несколько параллельных
вызовов инструментов, поэтому `N` шагов ≠ всегда ровно `N` вызовов (в инциденте
они шли последовательно — получилось ровно 8).

## Решение (точечное, только сервер)

Файл: `apps/server/src/core/ai-chat/ai-chat.service.ts`.

1. Завести модульную константу вместо «магической» восьмёрки:

```ts
// Max agent steps per turn. One step = one model generation; a step that calls
// tools is followed by another step carrying the tool results. Raised from 8 so
// multi-search research questions are not cut off mid-investigation.
const MAX_AGENT_STEPS = 20;

// System-prompt addendum injected ONLY on the final step (see prepareStep). It
// forbids further tool calls and tells the model to synthesize the best answer
// it can from what it already gathered, so a tool-heavy turn never ends empty.
const FINAL_STEP_INSTRUCTION =
  'You have reached the maximum number of tool-use steps for this turn. ' +
  'Do NOT call any more tools. Using only the information already gathered, ' +
  "write the most complete, useful final answer you can now, in the user's " +
  'language. If the information is incomplete, say so explicitly: summarize ' +
  'what you found, what is still missing, and give your best partial conclusion.';
```

2. Поднять потолок:

```ts
stopWhen: stepCountIs(MAX_AGENT_STEPS),
```

3. Добавить `prepareStep` в опции `streamText({...})` (рядом со `stopWhen`,
   перед `abortSignal`). На последнем разрешённом шаге запрещаем инструменты
   (`toolChoice: 'none'` → модель обязана выдать текст) и дополняем системный
   промпт инструкцией синтеза. На остальных шагах ничего не возвращаем →
   действуют дефолтные настройки:

```ts
// Forced finalization: reserve the LAST allowed step for a text-only answer.
// Without this, a turn that spends all its steps on tool calls ends with no
// assistant text (an empty turn). On the final step we forbid further tool
// calls and append a synthesis instruction. `system` is the prompt built above
// (in scope here); we CONCATENATE so the original persona/context is preserved
// — a bare `system` override would REPLACE the whole system prompt for the step.
prepareStep: ({ stepNumber }) => {
  if (stepNumber >= MAX_AGENT_STEPS - 1) {
    return {
      toolChoice: 'none',
      system: `${system}\n\n${FINAL_STEP_INSTRUCTION}`,
    };
  }
  return undefined; // default settings for all earlier steps
},
```

Итог: до 19 шагов модель свободно работает с инструментами, 20-й (последний)
шаг гарантированно текстовый. Если модель завершилась раньше естественным
образом — `prepareStep` для ранних шагов возвращает `undefined`, поведение не
меняется.

## Подтверждённые факты по API (установлено: `ai@6.0.207`)

Проверено по `node_modules/ai/dist/index.d.ts`:

- `prepareStep({ stepNumber, steps, model, messages }) => PrepareStepResult |
  void` — колбэк опции `streamText`.
- `PrepareStepResult` (строки ~990-1019) содержит поля:
  `model?`, `toolChoice?`, `activeTools?`, `system?`, `messages?` и др.
- `toolChoice?: ToolChoice<TOOLS>`, где
  `ToolChoice = 'auto' | 'none' | 'required' | { type:'tool', toolName }`
  (строка 126) — значит `toolChoice: 'none'` валидно и заставляет модель
  отвечать текстом.
- `system?: string | SystemModelMessage | Array<SystemModelMessage>` — override
  системного сообщения **для шага**; это полная замена, поэтому конкатенируем с
  исходным `system`, а не пишем голую инструкцию.
- `stepNumber` нумеруется с нуля (док. пример: `if (stepNumber === 0) {...}`).

> ⚠️ При апгрейде до AI SDK v7 поле `system` в `prepareStep` переименовано в
> `instructions` (см. migration guide 7.0). На v6 (`^6.0.134`, фактически
> 6.0.207) корректно именно `system`. Учесть при будущем bump.

## Тонкие моменты / edge cases

- **Резерв ровно одного шага** — на 20-м шаге модель не сможет сделать ещё один
  «дозапрос». Это осознанный компромисс: гарантированный ответ важнее одного
  лишнего инструмента. Если захочется буфера — форсить на `stepNumber >=
  MAX_AGENT_STEPS - 2` (зарезервировать 2 шага), но это режет полезную работу.
- **Естественное завершение** до последнего шага — не затрагивается: override
  применяется только при `stepNumber >= MAX_AGENT_STEPS - 1`.
- **finishReason** последнего шага: при `toolChoice:'none'` модель выдаёт текст
  без tool-calls → цикл завершается как `stop` (а не «оборвался на лимите»).
  Пустых ходов больше не будет; `onFinish` получит непустой `text`.
- **Замена system** override-ом — единственная ловушка: НЕ потерять исходный
  промпт. Переменная `system` (`ai-chat.service.ts:146`) в замыкании — берём её.
- **maxOutputTokens** на агенте намеренно не задан (коммент `:242-246`) — это
  изменение его не трогает; токенов на финальный текстовый шаг достаточно.
- **Клиент не меняется**: рендер шагов и текста уже есть в
  `apps/client/src/features/ai-chat/components/message-list.tsx`. Раньше пустой
  ход показывался как ход без текста — после фикса будет нормальный ответ.
- **Внешние MCP-клиенты** (tavily и пр.) закрываются в терминальных колбэках
  (`closeExternalClients`) — путь завершения не меняется, ликов не добавляем.

## Тестирование

- Цикл `streamText` целиком юнит-тестировать дорого. Рекомендуется вынести
  логику выбора шага в чистую экспортируемую функцию (по образцу
  `compactToolOutput`, который уже тестируется в `ai-chat.service.spec.ts`):

```ts
// Pure, unit-testable: decide per-step overrides. Returns undefined for normal
// steps, and forces a text-only synthesis on the final step.
export function prepareAgentStep(
  stepNumber: number,
  system: string,
): { toolChoice: 'none'; system: string } | undefined {
  if (stepNumber >= MAX_AGENT_STEPS - 1) {
    return { toolChoice: 'none', system: `${system}\n\n${FINAL_STEP_INSTRUCTION}` };
  }
  return undefined;
}
```

  Тогда `prepareStep: ({ stepNumber }) => prepareAgentStep(stepNumber, system)`,
  а тест проверяет: для `stepNumber < 19` → `undefined`; для `19` → объект с
  `toolChoice === 'none'` и `system`, начинающимся с исходного промпта и
  содержащим `FINAL_STEP_INSTRUCTION`.

## Альтернативы / возможные расширения (вне базового объёма)

- **Конфигурируемый лимит** — вынести `MAX_AGENT_STEPS` в настройку воркспейса
  (admin → AI), как системный промпт (`AiSettingsService.resolve`). Сейчас же —
  просто константа в коде.
- **UI-метка «ответ по неполным данным»** — если последний шаг был принудительным,
  можно прокинуть флажок в metadata и показать бейдж в `message-list.tsx`. Не
  обязательно для базовой фичи.

## Открытые вопросы (согласовать перед реализацией)

- [ ] Значение лимита: 20 — ок? (компромисс «глубина исследования» vs стоимость
      токенов на ход.)
- [ ] Текст `FINAL_STEP_INSTRUCTION` — устраивает формулировка? Язык ответа
      модель выбирает сама по контексту; инструкция на английском как и весь
      системный промпт.
- [ ] Выносить ли логику шага в чистую функцию ради юнит-теста (рекомендуется),
      или оставить инлайн в `prepareStep` без отдельного теста.

## Процесс

- Сейчас это только план; код НЕ менялся.
- Реализация — режим делегирования (по умолчанию): изменение логическое
  (новый `prepareStep` + константы, >5 строк) → general-purpose кодеру, затем
  обязательный прогон `review`.
- Не коммитить; в конце предложить сообщение коммита.
