# Индикатор-точка эндпоинта AI: «настроено / включено» вместо «результат теста»

## Контекст (симптом)

В админских настройках AI (Workspace settings → AI) у каждой карточки-эндпоинта
(«Chat / LLM», «Embeddings», «Voice / STT») слева от заголовка есть маленькая
цветная точка. Сейчас её цвет означает **результат последнего ручного теста**
кнопкой «Test endpoint», а не состояние настройки:

- зелёная — тест «Test endpoint» прошёл (`ok`);
- красная — тест упал (`error`);
- серая — тест ещё **не запускали** (`idle`).

Поэтому на текущем экране у «Embeddings» точка зелёная (по карточке нажимали
«Test endpoint» → «Connection successful»), а у «Voice / STT» — серая, **хотя
тумблер «Voice dictation» включён и эндпоинт настроен**. Тумблеры фич
(`chat` / `search` / `dictation`) и сам факт заполненности полей (модель +
Base URL) на цвет точки сейчас никак не влияют.

Хотим, чтобы точка читалась с одного взгляда как состояние эндпоинта, без
ручного теста:

- **зелёная** — корректно настроено **и** включено;
- **жёлтая** — настроено, но **не** включено;
- **серая** — выключено / не настроено (нечего включать).

## Как сейчас устроено (цепочка)

Всё в одном файле клиента:
`apps/client/src/features/workspace/components/settings/components/ai-provider-settings.tsx`.

- Тип состояния точки: `type CardStatus = "ok" | "error" | "idle";`
  — строка ~64.
- Компонент `StatusDot` (строки ~75-90) красит круг: `ok` → `green[6]`,
  `error` → `red[6]`, иначе → `gray[5]`.
- Источник статуса — **только** мутации теста (строки ~356-370):

  ```ts
  const chatStatus: CardStatus = chatTest.data
    ? (chatTest.data.ok ? "ok" : "error")
    : "idle";
  // аналогично embedStatus (embedTest), sttStatus (sttTest)
  ```

  `chatTest` / `embedTest` / `sttTest` — это `useTestAiConnectionMutation()`
  (строки ~101-104); их `data` появляется только после нажатия «Test endpoint».
- Точки рендерятся в заголовках трёх карточек: `<StatusDot status={chatStatus}/>`
  (~407), `embedStatus` (~517), `sttStatus` (~634).

### Какие данные уже доступны в компоненте

Этого достаточно, чтобы вычислить «настроено» и «включено» синхронно, без сети:

- **Поля настройки** (живые, из формы) — `form.values`:
  `chatModel`, `baseUrl`, `embeddingModel`, `embeddingBaseUrl`, `sttModel`,
  `sttBaseUrl`, `sttApiStyle`, и write-only буферы ключей `apiKey`,
  `embeddingApiKey`, `sttApiKey`.
- **Наличие сохранённых ключей** — состояния `hasApiKey`, `hasEmbeddingApiKey`,
  `hasSttApiKey` (строки ~122-130), синхронизируются с сервером и обновляются
  при «Clear» и сохранении.
- **Тумблеры фич** (персистятся в `workspace.settings.ai`) — `chatEnabled`
  (`settings.ai.chat`, строка ~108), `searchEnabled` (`settings.ai.search`,
  ~111), `dictationEnabled` (`settings.ai.dictation`, ~114).
- **Семантика наследования** (важно для «настроено»): Embeddings и Voice
  **наследуют Base URL и ключ от Chat**, если свои не заданы. Это прямо написано
  в подзаголовке карточки Chat: «root endpoint — Embeddings and Voice inherit its
  URL and key» (строка ~423), и реализовано в `resolveUrl(..., fallback)`
  (~373-382). Значит у Embeddings/STT «свой Base URL» не обязателен.

## Решение (точечное, только клиент)

Файл: `apps/client/src/features/workspace/components/settings/components/ai-provider-settings.tsx`.
Перепривязать цвет точки с «результата теста» на пару булевых признаков
**`configured` × `enabled`**. Результат теста остаётся как был — текстом рядом с
кнопкой («Connection successful» / ошибка), точку он больше не красит.

### 1. Новый тип состояния и чистый хелпер выбора цвета

```ts
// Three-state endpoint health shown by the header dot. Derived synchronously
// from the form + feature toggle — never from a network probe (the "Test
// endpoint" button still surfaces the live probe result as text).
//   "ready"      (green)  — required fields are filled AND the feature is ON
//   "configured" (yellow) — required fields are filled but the feature is OFF
//   "off"        (gray)   — required fields missing (nothing to enable)
type CardStatus = "ready" | "configured" | "off";

// Pure + unit-testable. `configured` = the endpoint has everything it needs to
// work; `enabled` = the workspace feature toggle for this endpoint is ON.
function resolveCardStatus(configured: boolean, enabled: boolean): CardStatus {
  if (!configured) return "off";
  return enabled ? "ready" : "configured";
}
```

### 2. `StatusDot` — добавить жёлтый

```ts
function StatusDot({ status }: { status: CardStatus }) {
  const theme = useMantineTheme();
  const color =
    status === "ready"
      ? theme.colors.green[6]
      : status === "configured"
        ? theme.colors.yellow[6] // Mantine default palette has `yellow`
        : theme.colors.gray[5];
  return (
    <Box w={9} h={9} style={{ borderRadius: "50%", background: color, flex: "none" }} />
  );
}
```

### 3. Признак «настроено» для каждой карточки

Ключ (API key) считаем **необязательным** — локальные серверы (Ollama, speaches
/ faster-whisper-server) работают без ключа, поэтому требовать ключ нельзя.
«Настроено» = задана модель **и** есть Base URL (свой или унаследованный от Chat):

```ts
const v = form.values;
const chatBase = v.baseUrl.trim();

// Chat is the root: needs its own model + base URL.
const chatConfigured = v.chatModel.trim() !== "" && chatBase !== "";

// Embeddings / Voice inherit the chat base URL when their own is empty.
const embedConfigured =
  v.embeddingModel.trim() !== "" && (v.embeddingBaseUrl.trim() !== "" || chatBase !== "");
const sttConfigured =
  v.sttModel.trim() !== "" && (v.sttBaseUrl.trim() !== "" || chatBase !== "");
```

### 4. Заменить вывод статусов (строки ~356-370)

```ts
const chatStatus = resolveCardStatus(chatConfigured, chatEnabled);
const embedStatus = resolveCardStatus(embedConfigured, searchEnabled);
const sttStatus = resolveCardStatus(sttConfigured, dictationEnabled);
```

`chatTest` / `embedTest` / `sttTest` остаются для текстового результата под
кнопкой «Test endpoint» — их `data` просто больше не участвует в цвете точки.

### 5. (Рекомендуется) Tooltip на точке — цвет не должен быть единственным сигналом

Цвет в одиночку недоступен дальтоникам и неочевиден. Обернуть `StatusDot` в
Mantine `Tooltip` с текстовой расшифровкой (через `t(...)`), напр.:
`ready` → «Configured and enabled», `configured` → «Configured but disabled`»,
`off` → «Not configured». `Tooltip` уже используется в соседнем
`mcp-settings.tsx`, импорт из `@mantine/core`.

## Тонкие моменты / edge cases

- **Источник «настроено» — `form.values` (живой), а не persisted `settings`.**
  Тогда точка реагирует прямо при наборе. Минус: тумблер (`*Enabled`) —
  персистентный, поэтому после правки полей и **до** «Save endpoints» возможна
  кратковременная рассинхронизация (поля изменены, но ещё не сохранены). Это
  приемлемо и логично (точка показывает «то, что введено»). Альтернатива — брать
  поля из `settings` (тогда точка отражает строго сохранённое состояние,
  согласованно с тумблером) — см. «Альтернативы».
- **Включено, но НЕ настроено** (`enabled && !configured`): админ включил фичу, но
  не заполнил эндпоинт — реальная мисконфигурация. По строгой трёхцветной схеме
  это **серый**, что прячет проблему. Варианты: (а) оставить серым (буквально по
  ТЗ); (б) **рекомендуется** — отдельный «warning»-цвет (красный/оранжевый) и
  тултип «Enabled but not configured», т.к. фича включена и работать не будет.
  Решить в «Открытых вопросах».
- **Судьба красного «тест упал».** Сейчас красный = упавший тест. В новой схеме
  цвета красного нет. Падение теста по-прежнему видно текстом под кнопкой, так что
  сигнал не теряется. Опционально можно сохранить красный как 4-е состояние-оверрайд
  (если тест **явно** запускали и он упал) — но это усложняет модель; по умолчанию
  не делаем.
- **`yellow` в теме Mantine** есть в дефолтной палитре (Mantine 8) — `yellow[6]`
  валиден; кастомная тема в проекте палитру не переопределяет (использовать
  `theme.colors.yellow[6]`).
- **Все три карточки** ведут себя единообразно (одна `StatusDot` + один хелпер),
  включая «Chat / LLM», которой нет на скриншоте, но логика та же.
- **Оптимистичные тумблеры**: `*Enabled` обновляются оптимистично и
  откатываются при ошибке (`handleToggle*`). Цвет точки следует за состоянием
  тумблера автоматически (реактивный `useState`).
- **trim()**: значения могут содержать пробелы — сравнивать после `.trim()` (как
  в `resolveUrl`).

## i18n

- Новые пользовательские строки (тексты тултипов) **только через `t(...)`** и
  добавить ключи в каталог `apps/client/public/locales/en-US/translation.json`
  (он английско-ключевой: ключ == значение, напр. `"Configured and enabled"`).
  Если используется warning-вариант — добавить и его строку.
- Комментарии в коде — на английском (правило проекта).

## Тесты

- `resolveCardStatus` — чистая функция, легко юнит-тестируется (Vitest на
  клиенте): `(false, *) → "off"`, `(true, true) → "ready"`, `(true, false) →
  "configured"`. Если экспортировать `*Configured`-предикаты как чистые
  функции от `form.values` — их тоже можно покрыть (особенно наследование Base
  URL у Embeddings/STT).
- Запустить `pnpm --filter client lint` и `pnpm --filter client test`.

## Альтернативы / расширения (вне базового объёма)

- **Брать «настроено» из persisted `settings`** (а не `form.values`): точка строго
  отражает сохранённое состояние, согласовано с персистентным тумблером, но не
  реагирует на ввод до «Save». `settings` (`IAiSettings`) уже содержит
  `chatModel`/`embeddingModel`/`baseUrl`/`embeddingBaseUrl`/`sttModel`/
  `sttBaseUrl` + `hasApiKey`/`hasEmbeddingApiKey`/`hasSttApiKey`.
- **«настроено» = «тест прошёл»** вместо «поля заполнены»: точнее («корректно»),
  но требует автопрогона теста на загрузке (сеть, латентность, лимиты провайдера)
  — против идеи мгновенного индикатора. Не рекомендуется.
- **Учитывать ключ для облачных провайдеров**: если Base URL указывает на
  публичный провайдер (OpenAI/OpenRouter), ключ де-факто обязателен. Можно
  усложнить предикат (`configured` требует ключ, если host не локальный), но это
  хрупкая эвристика — оставляем ключ необязательным.

## Открытые вопросы (согласовать перед реализацией)

- [ ] Случай «включено, но не настроено»: серый (буквально по ТЗ) или отдельный
      warning-цвет (рекомендуется, чтобы не прятать мисконфигурацию)?
- [ ] Что значит «настроено»: «поля модель + Base URL заполнены» (рекомендуется,
      ключ необязателен) — ок? Или требовать ещё и ключ?
- [ ] Источник полей: живой `form.values` (реактивно при вводе, рекомендуется)
      или persisted `settings` (строго сохранённое состояние)?
- [ ] Добавлять ли `Tooltip` с текстовой расшифровкой (рекомендуется для
      доступности) и сохранять ли красный как 4-е состояние «тест упал»?
