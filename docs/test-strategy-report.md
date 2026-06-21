# Отчёт по тест-стратегии — gitmost — 2026-06-21

> Область анализа сознательно **ограничена коммитом `81823fce`**
> «feat(html-embed): sandbox the embed block; split trusted trackers into an admin field».
> Это security-рефактор: html-embed переведён в песочницу (iframe `sandbox="allow-scripts
> allow-popups allow-forms"`, opaque-origin, `srcdoc`), вся прежняя ролевая обвязка стрипа
> удалена, добавлено admin-only поле `settings.trackerHead` (инъекция в `<head>` только
> страниц публичного шаринга). Стратегия покрывает поведения, которые этот коммит ввёл/изменил.

## 1. Исполнительное резюме

- Проанализировано модулей: **8** (по одному `module-testability-analyst` на модуль).
- Предложено тестов в немедленный план (unit / integration / e2e / contract): **13 / 4 / 1 / 1** = 19.
- Отложено за рефакторингом или признано опциональными: **≈8** (см. §5–6).
- Отклонено как малоценные (wiring/тривиальное/уже покрыто): **≈12** (агрегировано в «НЕ тестировать»).
- Покрытие сейчас (проверено инструментом, см. §7): из ~10 security-значимых поведений коммита
  **покрыто 4**, **не покрыто 6**. Прогноз после внедрения плана: **10 из 10**.

Главный вывод: «чистое ядро» (prosemirror-утилиты стрипа) покрыто на **100 %**, но **все новые
security-поверхности коммита не покрыты вовсе**: инъекция `trackerHead` в `<head>` (0 %),
валидация DTO (0 %), клиентские sandbox-атрибуты / валидация `postMessage` / клэмп высоты (0 %),
гейтинг slash-меню (0 %), атрибут `height` в схеме узла (0 %), CASL-гейт на запись `trackerHead` (0 %).

## 2. Рекомендации по модулям

### M1. client-html-embed-rendering (`apps/client/.../editor/components/html-embed/` + `slash-menu/`)
Самая важная клиентская логика — атрибуты sandbox, валидация источника `postMessage` и клэмп
высоты — живёт **внутри React-компонента** `html-embed-view.tsx` как JSX-литерал и inline-замыкания,
поэтому юнит-нетестируема.
- **Извлечь в чистые функции (R-c1/R-c2/R-c3):**
  `html-embed-view.tsx:149-157` → `buildEmbedIframeProps()`; `:74-83` → `isTrustedHeightMessage(event, src)`;
  `:80-82` и `:88-91` (дублируется) → `clampIframeHeight(n)`.
- **Unit-тесты добавить:**
  - `isTrustedHeightMessage` — сообщение из чужого `window` (спуф) отвергается; верный source+неверный
    `type` → null; `height` = NaN/Infinity → null; клэмп границ. *Ловит: инъекцию resize-сообщений.* **[HIGH]**
  - `buildEmbedIframeProps` — sandbox ровно `allow-scripts allow-popups allow-forms`; **нет** `allow-same-origin`;
    задан `srcDoc`, `src` отсутствует. *Ловит: ослабление песочницы → выход в origin/XSS.* **[HIGH]**
  - `getSuggestionItems` (`menu-items.ts:815`) — пункт «HTML embed» виден при тоггле ON, скрыт при OFF/отсутствии
    ключа (default OFF), битый JSON в localStorage → пункт скрыт и без исключения. *Ловит: показ пункта при
    выключенной фиче.* **[HIGH]** (рефактор не нужен)
  - `clampIframeHeight` — границы [40, 4000], отрицательные/0 → MIN. *Ловит: DoS-раздувание layout.* **[MED]**
- **НЕ тестировать:** модалка/`draft`-стейт/плейсхолдеры `HtmlEmbedView` (UI-обвязка, политика уже в чистых
  хелперах); `slash-menu/types.ts` (только типы); `buildSandboxSrcdoc`-строка уже покрыта (`render-raw-html.test.ts`).

### M2. editor-ext-html-embed-schema (`packages/editor-ext/src/lib/html-embed/`)
- **Извлечь (R-e1):** `html-embed.ts:96-104` → `parseHtmlEmbedHeight` / `renderHtmlEmbedHeight` (по образцу уже
  вынесенного `encode/decodeHtmlEmbedSource`).
- **Unit-тесты добавить:**
  - `parseHtmlEmbedHeight` — «120»→120, отсутствует→null, **«abc»→NaN (ДЕФЕКТ, см. §4)**, «120px»→120. **[MED]**
  - `renderHtmlEmbedHeight` — 120→`{data-height:"120"}`, null→`{}`, 0→`{}`, NaN→`{}`. **[MED]**
  - round-trip render→parse — 120↔120, 0→null (lossy), NaN→null — фиксирует асимметрию. **[MED]**
- **Contract-тест добавить:** markdown export/import узла с `data-height` — явно зафиксировать, что `height`
  **теряется** (маркер несёт только base64-source). *Ловит: молчаливую потерю/непреднамеренное появление.* **[MED]**
- **НЕ тестировать:** `parseHTML`-селектор, `renderHTML`-`mergeAttributes`, `addCommands/addNodeView` (wiring);
  base64-кодек source — уже полностью покрыт (`html-embed-codec.spec.ts`).

### M3. client-workspace-settings-ui (`apps/client/.../workspace/.../settings/`)
Реальная граница безопасности — на сервере; здесь тесты ловят UX-регрессии видимости, а не сам бордер.
Конвенция проекта (см. `ai-provider-settings.spec.tsx`) — выносить логику в чистые хелперы и юнит-тестировать их.
- **Извлечь (R-cs1/R-cs2):** мерж-логику `applyHtmlEmbedToWorkspace` / `applyTrackerHeadToWorkspace`
  (force-set значения даже если ответ его опускает; сохранение пустой строки; не затирать прочие `settings`-ключи).
- **Unit-тесты добавить:** мерж обоих хелперов (ключ, пустая строка, сохранность соседних ключей). **[MED]**
- **Component/Integration-тест добавить:** `TrackerSettings` для не-админа — textarea **и** Save кнопка `disabled`
  (поле остаётся в DOM by design — проверять `disabled`, не отсутствие). *Ловит: редактируемость trackerHead не-админом
  (UX-утечка привилегии).* **[MED]**
- **НЕ тестировать:** `WorkspaceSettings`-страница (рендерит карточки по порядку, ветвлений нет); типы
  `IWorkspace*`; точные строки локализации (тавтологичный snapshot); виджеты Mantine (сторонние).

### M4. server-prosemirror-html-embed-util (`apps/server/src/common/helpers/prosemirror/html-embed.util.ts`)
Чистые функции над PM-деревом — идеальный unit-уровень. **Покрытие 100 %** (проверено), но есть узкие
edge-пробелы в существующих спеках.
- **Unit-тесты добавить:**
  - `stripHtmlEmbedNodes` — несколько embed-сиблингов на одном уровне и в разных ветвях; deep-clone vs shared
    reference (вложенный сохранённый узел — новый объект); `content` не-массив / пустой `[]`. **[MED]**
  - `hasHtmlEmbedNode` — embed только в глубоком потомке (3+ уровня); `content: []`. **[MED]**
- **НЕ тестировать:** `HTML_EMBED_NODE_NAME` (константа); привязка тоггл→стрип на share-пути (уже покрыто
  на уровне реального консьюмера в `share-html-embed.spec.ts`); base64-кодек (это `@docmost/editor-ext`).
- **Открытый риск:** `prepareContentForShare` вызывает `getProsemirrorContent()` перед стрипом; если оттуда
  приходит **инстанс PM-`Node` (класс)**, а не POJO, то `{ ...node }` (line 39) теряет прототип/методы. Спеки
  гоняют только POJO — контракт на границе не проверен.

### M5. server-collab-import-write-paths (collaboration + import)
Коммит удалил ролевой стрип на путях записи (collab REST/MCP+socket, импорт). Новое поведение —
**сквозной pass-through**: html-embed сохраняется. Это уже покрыто **ниже по пирамиде**
(`html-embed-import-detect.spec.ts` гоняет реальный `markdownToHtml`→`htmlToJson`).
- **Новых html-embed-тестов не требуется** — поведение «стрип отсутствует» = pass-through, уже зафиксировано.
- **Опционально (вне scope коммита):** `extractTitleAndRemoveHeading` (`import.service.ts:161`) — единственная
  ветвящаяся чистая логика модуля, не покрыта; требует R-i1 (вынос в leaf-модуль, т.к. сервис не грузится в jest —
  см. §5). **[LOW]**
- **НЕ тестировать:** конструкторы/DI, `onLoadDocument/onStoreDocument` (hocuspocus/yjs/BullMQ/Kysely-обвязка),
  `updatePageContent`/`withYdocConnection` (pass-through), очередь импорта (FS/DB-wiring).
- **Грепы dangling-ссылок:** `htmlEmbedAllowed`, `canAuthorHtmlEmbed`, `stripDisallowedHtmlEmbedNodes`,
  `collectHtmlEmbedSources` → **0 ссылок** в `apps/`/`packages/`. DI согласован, битых инъекций нет.

### M6. server-page-transclusion (`page.service.ts`, `page.controller.ts`, `transclusion.service.ts`)
Удалён параметр `callerRole` у `PageService.create` и стрип у create/duplicate/unsync.
- **Integration-тесты добавить (мок-репозитории):**
  - `unsyncReference` сохраняет htmlEmbed (замена удалённого `transclusion-unsync-html-embed.spec.ts`,
    инвертированная на «сохраняет»). *Ловит: повторное появление стрипа.* **[MED]** (рефактор не нужен)
- **Отложены за рефакторингом (НЕ обещать без него):** `create`/`duplicatePage` сохраняют htmlEmbed (нужен R-p1 —
  сервис не грузится в jest); контракт `page.controller`→`create` ровно с 4 аргументами (нужен R-p2 — снять
  спек из exclude-листа). Контрактный тест критичен: оба удалённый `callerRole` и `provenance` были трейлинг-
  опциональными → устаревший вызов с `user.role` сдвинул бы аргумент в слот `provenance` (тихий баг).
- **НЕ тестировать:** DB-оркестрацию create/duplicate (insertPage/insertMany/позиции/вотчеры), удаление
  `WorkspaceRepo` из конструктора (деталь реализации), `parseProsemirrorContent` (не менялся).
- **Греп `callerRole`:** в активном дереве **0 ссылок** (совпадения только в отдельном git-worktree).

### M7. server-share-trackerhead (`share-seo.controller.ts`, `share.service.ts`) — **SECURITY-CRITICAL**
- **Извлечь (R-s1):** `share-seo.controller.ts:97-103` → `injectTrackerHead(html, trackerHead): string`
  (verbatim-конкатенация + guard на пустое/whitespace/не-строку + позиция перед `</head>`).
- **Unit-тесты добавить:** `injectTrackerHead` — непустой сниппет вставлен **дословно** перед `</head>`;
  спецсимволы `< > & "` не экранируются (фиксирует намеренный no-escape); пустая/whitespace/не-строка →
  html без изменений; позиция — только перед **первым** `</head>`, не в `<body>`. *Ловит: потерю инъекции,
  вставку не туда (XSS-позиционирование), случайное экранирование, `[object Object]`.* **[HIGH]**
- **Integration-тесты добавить (контроллер с моками; застабить `fs.existsSync`→true, `fs.readFileSync`→фикстура):**
  - сниппет присутствует → есть в `<head>`; пустой → разметка не ломается;
  - **нет share → инъекции НЕ происходит** (даже если у workspace настроен trackerHead) — ключевой негатив;
  - **нет workspace → инъекции НЕ происходит**; wrong-workspace → `getShareForPage` отбрасывает чужой share. **[HIGH]**
- **Уже покрыто:** стрип на share-read-пути (`share-html-embed.spec.ts:77-262`: ON/OFF/absent/fail-closed,
  `updatePublicAttachments`, transclusion-for-share). `trackerHead`-инъекция — **0 % (проверено)**.
- **НЕ тестировать:** `sendIndex`/резолв workspace по host (wiring), сборку meta-тегов (не менялась),
  CASL-гейт записи (другой модуль — M8).

### M8. server-workspace-settings (`workspace.service.ts`, `dto/update-workspace.dto.ts`)
Единственный admin-гейт `trackerHead` — на контроллере (`workspace.controller.ts:90-95`,
`ability.cannot(Manage, Settings)`); ни DTO, ни сервис не ролевые.
- **Unit-тесты добавить (class-validator):**
  - `trackerHead` — валидная строка ок; ровно 20000 символов ок; 20001 → ошибка `maxLength`; не-строка → `isString`. **[HIGH]**
  - `htmlEmbed` — true/false ок; не-boolean (`"true"`, `1`) → `isBoolean` (важно: глобальный pipe `transform:true`
    **не** коэрсит строку — проверить, что `"true"` отвергается). **[HIGH]**
- **Integration-тест добавить:** `WorkspaceController.updateWorkspace` с ability роли MEMBER → `ForbiddenException`,
  `workspaceService.update` **не вызывается**; OWNER/ADMIN → вызывается. *Ловит: запись `trackerHead` не-админом.* **[HIGH]**
- **Уже покрыто:** call-shape персиста настроек (`workspace-html-embed.spec.ts`: htmlEmbed/trackerHead через
  `updateSetting`, audit-diff, «отсутствует → не вызывается»). **Но валидация там обойдена `as any`** — это не покрытие валидации.
- **НЕ тестировать:** соседние поля DTO (не менялись), SQL-тело `updateSetting` (kysely/PG — нужен реальный Postgres,
  отложено), `delete dto.trackerHead`-чистку (деталь), декларации CASL-фабрики (wiring).

## 3. Сквозные аспекты
- **Contract-тесты:** один — markdown round-trip узла html-embed теряет `height` (M2). Кросс-сервисных контрактов нет.
- **Property-based:** кандидат — `stripHtmlEmbedNodes` (инвариант: в результате нет узлов `htmlEmbed` при любой
  форме дерева; вход не мутируется). Реализуемо после того, как edge-кейсы из M4 пройдут.
- **Дымовой/нагрузочный:** не применимо к scope коммита.
- **Test-data factories:** фабрика PM-дока с произвольно вложенными `htmlEmbed` (для M4/M6); фикстура `index.html`
  с маркерами `<!--meta-tags-->`/`</head>` (для M7); билдер `UpdateWorkspaceDto`-payload (для M8).

## 4. Обнаруженные дефекты и антипаттерны
- **[ДЕФЕКТ, low-med] `html-embed.ts:98-100`** парсит `data-height` голым `parseInt` → на мусоре возвращает **NaN**
  (соседний `drawio.ts:105-109` защищён `isNaN(...)?null`). NaN-высота утекает в PM-JSON и ломает resize в NodeView.
  Рекомендация: добавить тот же guard `isNaN`; тест M2 фиксирует исправление.
- **[Антипаттерн] Тесты-заглушки, исключённые из CI.** `page.service.spec.ts`, `page.controller.spec.ts`,
  `workspace.service.spec.ts` — в `jest.testPathIgnorePatterns` (не запускаются) **и** содержат лишь
  `expect(...).toBeDefined()`. Создают ложное ощущение покрытия create/duplicate/controller — фактически **0 %**.
- **[Антипаттерн] Обход валидации.** `workspace-html-embed.spec.ts` зовёт `service.update('w1', {...} as any)`,
  минуя DTO/`ValidationPipe` — «безопасность trackerHead» там не проверяется.
- **[Блокер тестируемости] Сервисы не грузятся в jest.** `PageService`/`ImportService` тянут ESM-зависимость
  `@sindresorhus/slugify`, не входящую в `transformIgnorePatterns` (`apps/server/package.json:208`) — поэтому
  удалённые спеки использовали source-pin. Блокирует integration-тесты путей записи (см. рефакторинги).
- **[Риск] Param-shift** после удаления `callerRole` (M6) — не покрыт.
- **[Риск] PM-`Node` vs POJO** на входе `stripHtmlEmbedNodes` (M4) — не покрыт.
- Order-dependent / flaky тестов в scope **не обнаружено**; существующие спеки детерминированы.

## 5. Необходимые рефакторинги перед написанием тестов
- **R-s1** — вынести `injectTrackerHead` из `share-seo.controller.ts:97-103` → блокирует unit-тесты M7 (HIGH).
- **R-c1/R-c2/R-c3** — вынести `buildEmbedIframeProps` / `isTrustedHeightMessage` / `clampIframeHeight` из
  `html-embed-view.tsx` → блокирует unit-тесты M1 (sandbox, source-validation, clamp; HIGH).
- **R-e1** — вынести `parse/renderHtmlEmbedHeight` из `html-embed.ts:96-104` → блокирует unit-тесты M2.
- **R-cs1/R-cs2** — вынести мерж-хелперы настроек (M3) → блокирует unit-тесты мержа.
- **R-p1** — сделать `PageService` загружаемым в jest (добавить `@sindresorhus/slugify` в `transformIgnorePatterns`
  **или** вынести вывод контента в чистый модуль) → блокирует `create`/`duplicatePage`-тесты (M6).
- **R-p2** — снять `page.controller.spec.ts`/`page.service.spec.ts` из exclude-листа и переписать → блокирует
  контракт-тест 4 аргументов (M6).
- **R-i1** (опц.) — вынести `extractTitleAndRemoveHeading` в leaf-модуль (M5).

## 6. План внедрения (по фазам)
- **Фаза 1 — security-граница, без рефакторинга (макс. ROI).** Integration `ShareSeoController.getShare`
  (M7, incl. негативы no-share/no-workspace); integration CASL-гейт MEMBER→Forbidden (M8); unit-валидация DTO
  `trackerHead`/`htmlEmbed` (M8); unit `getSuggestionItems`-гейтинг (M1); unit edge-кейсы
  `stripHtmlEmbedNodes`/`hasHtmlEmbedNode` (M4); integration `unsyncReference` сохраняет embed (M6).
- **Фаза 2 — извлечения + клиентское ядро.** R-s1/R-c1..3/R-e1/R-cs1..2 и их unit-тесты: `injectTrackerHead`,
  `isTrustedHeightMessage`, `buildEmbedIframeProps`, `clampIframeHeight`, `parse/renderHtmlEmbedHeight` + round-trip,
  contract-тест потери `height`, мерж-хелперы и component-тест `TrackerSettings` (не-админ disabled). Здесь же —
  исправить NaN-парсер высоты (§4).
- **Фаза 3 — инфраструктура тестов.** R-p1/R-p2: разблокировать загрузку `PageService` в jest и un-exclude
  спеков; добавить `create`/`duplicatePage`-preservation и контракт 4 аргументов; завести `@vitest/coverage-v8`
  для измеримого порога покрытия. Опционально — E2E (Playwright).
- **E2E (≤1, user journey «анонимный читатель открывает публичную страницу с вредоносным html-embed»):**
  проверить, что встроенный iframe в реальном браузере не достаёт cookies/сессию/origin читателя — единственная
  гарантия, которую jsdom проверить не может (атрибут sandbox в jsdom не enforce-ится).

## 7. Источники и трассировка фильтров
- Отчёты **8** аналитиков `module-testability-analyst` (по модулю M1–M8).
- **Независимая проверка покрытия** (не доверяя заявлениям аналитиков):
  - server jest, провайдер V8 (дефолтный babel-провайдер падает на SWC-трансформе):
    `html-embed.util.ts` **100/100/100/100**; `share-seo.controller.ts` **0 %**; `update-workspace.dto.ts` **0 %**;
    `share.service.ts` — путь стрипа покрыт; `workspace.service.ts` — ветка персиста настроек покрыта.
    Прогон спеков html-embed/share/workspace — **зелёные** (4 suite / 35 тестов; полный прогон 42 suite / 567 тестов).
  - client/editor-ext vitest — **зелёные** (client 22, editor-ext 25); `@vitest/coverage-v8` не установлен,
    поэтому пробелы подтверждены grep'ом по тестам: sandbox/postMessage/clamp, `html-embed-view`, гейтинг slash-меню,
    `trackerHead`-UI, `data-height` — **нулевые ссылки в тестах**.
- **Фильтрация (по шагам Phase 3):**
  - Шаг 1 (кросс-модульный дедуп): импорт-preservation (M5) и привязка тоггл→стрип сведены к нижнему слою — снято ~2.
  - Шаг 2 (skip-list): wiring/DI/тривиальное/сторонние агрегированы в «НЕ тестировать» — отклонено ~12.
  - Шаг 4 (refactor-blocking): `create`/`duplicate`/контракт-4-арг (M6) переведены в отложенные за R-p1/R-p2.
  - Шаг 6 (adversarial): отброшены `buildSandboxSrcdoc`-hardening (дублирует существующий тест) и
    `extractTitleAndRemoveHeading` (вне scope коммита).
- **Бюджет пирамиды (немедленный план, 19 тестов):** unit+contract 14 (**74 %**), integration 4 (21 %),
  e2e 1 (5 %; абсолют ≤10). Лёгкое смещение к integration оправдано: ценность security-рефактора — на границе
  (CASL-гейт, инъекция в `<head>`, сохранность на путях записи), что по природе integration-уровень.
