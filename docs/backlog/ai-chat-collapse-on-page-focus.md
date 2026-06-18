# Авто-сворачивание AI-чата в заголовок при фокусе на странице, разворот по клику

## Контекст (запрос)

Плавающее окно AI-чата (`AiChatWindow`) сейчас перекрывает контент страницы:
если открыть чат и начать читать/листать вики-страницу под ним, окно остаётся
во весь рост и закрывает таблицу/текст (см. скриншот: окно поверх «Аудио-тракт в
умных колонках»). Свернуть можно только вручную — кнопкой «—» (Minimize) в шапке.

Хотим, чтобы окно **само сворачивалось в свою шапку, как только пользователь
переключается на страницу** (кликает мимо окна — в редактор/в контент), и
**разворачивалось обратно по клику на шапку**. Тогда чат не мешает читать
страницу, но остаётся под рукой одним кликом.

Важно: сворачивание — это именно визуальный коллапс (как нынешний Minimize), а
**не** закрытие. Поток ответа агента не должен прерываться.

## Как сейчас устроено (цепочка)

Всё во фронтенде, в одном компоненте окна:
`apps/client/src/features/ai-chat/components/ai-chat-window.tsx`
(+ его CSS `ai-chat-window.module.css`).

- **Состояние «свёрнуто»** уже есть: `const [minimized, setMinimized] = useState(false)`
  — строка ~108.
- **Переключатель** `toggleMinimize` (строки ~319-321) просто инвертирует флаг;
  привязан к кнопке «—» (`IconMinus`) в шапке (строки ~366-374).
- **Визуальный коллапс уже реализован в CSS** (`ai-chat-window.module.css`):
  - `.minimized { height: auto !important; min-height: 0 !important; resize: none; }`
    (строки ~40-44) — окно схлопывается до высоты шапки;
  - `.minimized .content { display: none; }` (строки ~56-58) — тело
    (история + тред) скрывается, но **не размонтируется**: `ChatThread` остаётся
    в DOM, поэтому идущий стрим/`AbortController` не обрывается (это явно описано в
    комментариях у `.content` и в `toggleMinimize`).
  - При `minimized` инлайновая `height` не задаётся (строка ~334), чтобы победила
    auto-высота из CSS; резайз-ручка скрыта (строки ~454-458).
- **Шапка = `.dragBar`** (JSX строки ~338-385) с `onMouseDown={startDrag}`.
  - `startDrag` (строки ~262-314) игнорирует нажатия на кнопках
    (`if ((e.target).closest("button")) return;`, строка ~264) — чтобы «—»/«×»/«+»
    не таскали окно.
  - В `mouseup` (`up`, строки ~290-308) сохраняется итоговая позиция в `geom`.
  - **Клика-для-разворота сейчас нет**: одиночный клик по шапке только инициирует
    перетаскивание, развернуть свёрнутое окно можно лишь повторным нажатием «—».
- Окно смонтировано глобально и плавает над всем: `<AiChatWindow />` в
  `apps/client/src/components/layouts/global/global-app-shell.tsx` (строка ~159),
  `position: fixed`, `z-index: 105` (ниже оверлеев Mantine: modal=200, menu=300,
  notifications=400 — это нам важно, см. «Тонкие моменты»).
- Композер автофокусится при монтировании треда (`autoFocus` в
  `chat-input.tsx`) — это фокус **внутри** окна, не на странице.

Итого: «свёрнутый» вид готов. Нужно добавить **два триггера**: (1) авто-сворот при
взаимодействии со страницей и (2) разворот по клику на шапку.

## Решение (точечное, только клиент)

Файл: `apps/client/src/features/ai-chat/components/ai-chat-window.tsx`
(+ пара строк CSS, опционально + i18n-ключ).

### Часть 1 — авто-сворачивание при взаимодействии со страницей

Слушаем `mousedown`/`pointerdown` на `document` (в capture-фазе), но **только**
когда окно открыто и ещё не свёрнуто. Если нажатие пришло **вне окна** и **не
внутри портала Mantine** — сворачиваем.

```ts
// Auto-collapse the window into its header as soon as the user interacts with
// anything outside it (clicks the page/editor). Active only while open and
// expanded. Capture phase so a child's stopPropagation can't hide the event.
useEffect(() => {
  if (!windowOpen || minimized) return;
  const onPointerDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const el = winRef.current;
    if (!el || !target) return;
    // Inside the window itself -> not an "away" interaction.
    if (el.contains(target)) return;
    // Inside a Mantine portal the chat owns (kebab Menu dropdown, delete-confirm
    // modal, the context-size Tooltip, notifications). Mantine's Portal sets
    // data-portal="true" on its node, so this reliably excludes ALL of them.
    if (target.closest("[data-portal]")) return;
    setMinimized(true);
  };
  document.addEventListener("mousedown", onPointerDown, true);
  return () => document.removeEventListener("mousedown", onPointerDown, true);
}, [windowOpen, minimized]);
```

Почему `mousedown` (а не `focusin`):
- Клик по **не-фокусируемому** элементу страницы (ячейка таблицы, обычный текст —
  ровно случай со скриншота) фокус-событие не порождает, но это и есть «ушёл на
  страницу». `mousedown` ловит любой клик. `focusin` пропустил бы такие клики.
- Минус: `mousedown` не ловит переход фокуса с клавиатуры (Tab в редактор). Если
  это нужно — добавить параллельно `focusin`-слушатель с тем же гардом (см.
  «Открытые вопросы»). По умолчанию — только указатель, как и просит запрос
  («смена фокуса на страницу» = клик мимо окна).

Почему гард `[data-portal]` обязателен:
- Кебаб-меню списка чатов рендерит `Menu.Dropdown` в портал (вне DOM окна) —
  `conversation-list.tsx` строки ~123-149; удаление — `modals.openConfirmModal`
  (строка ~56), тоже портал. Без гарда клик по пункту «Rename»/«Delete» свернул
  бы чат прямо в момент выбора. Mantine на узле портала ставит
  `data-portal="true"` (подтверждено в `node_modules/@mantine/core` →
  `Portal.cjs`), поэтому `target.closest("[data-portal]")` исключает их все
  (а заодно Tooltip размера контекста и нотификации — они тоже порталы).

Регистрация в `useEffect` с deps `[windowOpen, minimized]`: слушатель вешается
только когда `windowOpen && !minimized`, и снимается при сворачивании/закрытии —
не делаем лишней работы и не дёргаем `setMinimized(true)` повторно.

### Часть 2 — разворот по клику на шапку

Нужно отличить **клик** по шапке (развернуть) от **перетаскивания** свёрнутой
плашки (она остаётся таскаемой). Нельзя просто навесить `onClick` на `.dragBar`:
браузер шлёт `click` и в конце драга (mousedown+mouseup на том же элементе), и
плашка разворачивалась бы после любого перетаскивания.

Решение — доработать существующий `startDrag`: запомнить стартовые координаты,
а в `mouseup` посчитать смещение; если оно ниже порога (≈4px) **и** окно сейчас
свёрнуто — развернуть.

```ts
const startDrag = useCallback((e: React.MouseEvent): void => {
  if ((e.target as HTMLElement).closest("button")) return;
  const el = winRef.current;
  if (!el) return;
  const sx = e.clientX;
  const sy = e.clientY;
  // ... (ol/ot + move() unchanged)

  const up = (ev: MouseEvent): void => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    document.body.style.userSelect = "";
    // Treat a near-zero-movement press as a click. When minimized, a click on
    // the header expands the window (drag still repositions the collapsed bar).
    const moved =
      Math.abs(ev.clientX - sx) > 4 || Math.abs(ev.clientY - sy) > 4;
    if (!moved && minimizedRef.current) {
      setMinimized(false);
      return; // nothing to persist: position didn't change
    }
    // ... (persist geom as before)
  };
  // ...
}, []);
```

Подводный камень — **stale closure**: `startDrag` обёрнут в `useCallback([])`,
поэтому замыкает устаревший `minimized`. Два варианта:
- держать `minimizedRef = useRef(minimized)` и синхронизировать его в эффекте
  (`minimizedRef.current = minimized`) — тогда `useCallback([])` остаётся (как в
  коде выше); **рекомендуется**, не пересоздаёт хендлер;
- либо добавить `minimized` в deps `useCallback` — проще, но пересоздаёт `startDrag`
  на каждом тоггле (дёшево, но дёргает `onMouseDown`-проп).

Кнопка «—» остаётся как явный тоггл (`toggleMinimize` уже инвертирует флаг), так
что развернуть можно и ей. Менять её не нужно.

### Часть 3 (рекомендуется) — аффорданс и доступность шапки

- **Курсор**: в свёрнутом виде шапка кликабельна — заменить `grab` на `pointer`:
  ```css
  /* ai-chat-window.module.css — hint that the collapsed header expands on click */
  .minimized .dragBar { cursor: pointer; }
  ```
- **Клавиатура/скринридер**: `.dragBar` — это `div`. В свёрнутом состоянии дать
  ему `role="button"`, `tabIndex={0}`, `aria-label={t("Expand")}` и обработчик
  Enter/Space → `setMinimized(false)`. Иначе развернуть без мыши нельзя.

## Тонкие моменты / edge cases

- **Стрим не прерывается.** Авто-сворот выставляет `minimized=true` — `ChatThread`
  остаётся смонтированным (только `.content` скрывается). Ответ агента
  достреливается в фоне; развернув шапку, пользователь видит результат. Это
  желаемое поведение (он специально ушёл читать страницу).
- **Автофокус композера при открытии.** Открытие окна автофокусит textarea —
  это `focus` **внутри** окна, а не внешний `mousedown`, поэтому ложного
  немедленного сворота не будет.
- **Перетаскивание окна** (mousedown по шапке) — это нажатие **внутри**
  `winRef.current`, гард `el.contains(target)` его пропускает: drag не сворачивает.
- **Резайз** нативной ручкой — mousedown тоже внутри окна, не сворачивает.
- **Порталы дочерних компонентов** (кебаб-меню, confirm-модалка, tooltip,
  нотификации) исключены гардом `[data-portal]` — клик по ним не сворачивает.
  Это ключевая причина не использовать «голый» contains-only outside-click.
- **Capture-фаза** слушателя: ловим `mousedown` даже если кто-то на странице
  вызывает `stopPropagation` в bubble-фазе. На клики внутри окна/порталов не
  влияет (их отсекают гарды).
- **Повторный авто-сворот** не происходит: при `minimized` слушатель снят (deps
  эффекта). Разворот по клику снова навешивает слушатель — цикл корректен.
- **Состояние при закрытии/открытии.** Компонент при `!windowOpen` возвращает
  `null`, но **не размонтируется**, поэтому `minimized` переживает закрытие.
  Желательно при каждом открытии показывать окно **развёрнутым**: добавить
  `setMinimized(false)` в эффект, срабатывающий на переход `windowOpen → true`
  (можно в тот же `useLayoutEffect`, что вычисляет геометрию, строки ~238-241).
  См. «Открытые вопросы».
- **z-index/оверлеи.** Окно (105) ниже modal/menu/notifications — поэтому
  confirm-модалка удаления и кебаб-меню рисуются **над** окном; даже если бы чат
  свернулся за ними, они продолжали бы работать. Но гард `[data-portal]` всё равно
  не даёт сворачиваться при работе с ними.
- **Touch.** Драг сейчас на mouse-событиях (десктоп-фича). Для единообразия
  внешний слушатель можно сделать `pointerdown` вместо `mousedown` (покроет тач),
  но тогда и порог-клик в `up` стоит считать на pointer-событиях. По умолчанию —
  `mousedown`, как у драга.

## i18n

- Новые пользовательские строки — **только через `t(...)`** и добавить ключ в
  `apps/client/public/locales/en-US/translation.json` (каталог ключ==значение).
  Достаточно `"Expand"` (для `aria-label`/`title` шапки в свёрнутом виде).
  В шапке уже есть `t("Minimize")`, `t("Close")`, `t("New chat")`.
- Комментарии в коде — на английском (правило проекта).

## Тесты

- Вынести чистые хелперы и покрыть Vitest:
  - `shouldCollapseOnOutsidePointer(target, windowEl): boolean`
    (`windowEl.contains(target)` + `target.closest("[data-portal]")`) —
    `(внутри окна) → false`, `(в портале) → false`, `(на странице) → true`.
  - `isHeaderClick(dx, dy, threshold=4): boolean` — порог клик-vs-драг.
- Компонентный тест (`@testing-library/react`): открыть окно → диспатчить
  `mousedown` по `document.body` → окно получает класс `.minimized`; клик по
  `.dragBar` (без движения) в свёрнутом виде → класс снят. Проверить, что
  `mousedown` по узлу с `data-portal` сворота не вызывает.
- Прогнать `pnpm --filter client lint` и `pnpm --filter client test`.

## Файлы к изменению

- `apps/client/src/features/ai-chat/components/ai-chat-window.tsx`
  — внешний `mousedown`-эффект (Часть 1); доработка `startDrag` + `minimizedRef`
  (Часть 2); опц. `setMinimized(false)` при открытии; a11y-атрибуты на `.dragBar`.
- `apps/client/src/features/ai-chat/components/ai-chat-window.module.css`
  — опц. `.minimized .dragBar { cursor: pointer; }`.
- `apps/client/public/locales/en-US/translation.json` — ключ `"Expand"` (если
  добавляем aria/title).

## Альтернативы / расширения (вне базового объёма)

- **`useClickOutside` из `@mantine/hooks`** вместо ручного слушателя. Минус:
  порталы дочерних меню/модалок нужно явно передавать как `nodes` для игнора, а
  они создаются динамически — ручной гард `[data-portal]` проще и надёжнее.
  Поэтому ручной слушатель предпочтительнее.
- **Учитывать клавиатурный фокус** (`focusin`) дополнительно к `mousedown` — если
  захотим сворачивать и при Tab в редактор.
- **Не сворачивать во время стрима** — если решим, что во время генерации окно
  должно оставаться раскрытым (противоречит идее «ушёл читать страницу», поэтому
  по умолчанию сворачиваем всегда).
- **Анимация коллапса/разворота** (height/opacity transition) — косметика, можно
  добавить позже в `.window`/`.content`.

## Принятые решения (базовый объём)

- **Триггер авто-сворота — только клик** (`mousedown` в capture-фазе).
  `focusin` не добавляем: запрос — про переключение на страницу кликом, а клик по
  не-фокусируемому контенту (ячейка таблицы) фокус-событие не даёт.
- **При каждом открытии окна показываем его развёрнутым** —
  `setMinimized(false)` на переход `windowOpen → true`. Свёрнутое состояние не
  «залипает» между сессиями открытия.
- **Во время стрима сворачиваем как обычно.** Поток не прерывается (`ChatThread`
  остаётся смонтированным), результат виден после разворота — это и есть смысл
  «ушёл читать страницу».
- **Клавиатурный разворот шапки входит в базовый объём** — в свёрнутом виде
  `.dragBar` получает `role="button"`, `tabIndex={0}`, `aria-label={t("Expand")}`
  и обработку Enter/Space. Доступность без мыши обязательна.
