# Дерево страниц: кнопки «Развернуть всё» / «Свернуть всё»

Статус: **план, код не менялся.** Фича клиент+сервер. По решению владельца выбран
**серверный путь**: эндпоинт отдаёт **всё поддерево/всё дерево спейса разом**
(«отдать всё»), а клиент за один-два запроса разворачивает дерево целиком. От
клиентского рекурсивного обхода по одному уровню — отказались (см. «Почему так»).

## Суть

В сайдбаре спейса (дерево «Pages») сейчас узлы разворачиваются/сворачиваются
только поодиночке кликом по шеврону. Есть шорткат `*` (разворачивает **сиблингов**
сфокусированного узла, паттерн WAI-ARIA tree), но глобального «развернуть/свернуть
всё дерево» нет.

Хотим: две команды в шапке дерева — **«Развернуть всё»** (раскрыть все ветки
текущего спейса) и **«Свернуть всё»** (схлопнуть до корней). Это навигационная
операция над видом — прав на запись не требует, доступна любому, кто видит спейс.

## Почему так (выбор архитектуры)

Дети узлов **загружаются лениво, по одному уровню**: у свёрнутой ветки
`hasChildren === true`, но `children === []`, а эндпоинт `/pages/sidebar-pages`
отдаёт **только прямых детей** одного `pageId`. «Развернуть всё» поверх такого
API = рекурсивный BFS на десятки-сотни HTTP-запросов (шторм запросов, лимиты,
долгий индикатор, защитный потолок). Это и был отвергнутый вариант.

**Решение — отдать всё одним запросом на сервере.** У бэкенда уже есть готовые
кирпичи для рекурсивной выборки поддерева с учётом прав (используются в
`movePageToSpace`):
- `pageRepo.getPageAndDescendants(parentPageId, { includeContent: false })`
  ([page.repo.ts:557](apps/server/src/database/repos/page/page.repo.ts#L557)) —
  рекурсивный CTE: страница + все потомки одним запросом.
- `pageRepo.getPageAndDescendantsExcludingRestricted(parentPageId, opts)`
  ([page.repo.ts:612](apps/server/src/database/repos/page/page.repo.ts#L612)) —
  то же, но **обрезает закрытые (restricted) поддеревья прямо в SQL** (один
  запрос, не тянет лишнее).
- `pageService.filterAccessibleTreePages(allPages, rootId, userId, spaceId)`
  ([page.service.ts:1136](apps/server/src/core/page/services/page.service.ts#L1136))
  — точечная фильтрация дерева по правам с сохранением целостности (для
  per-page permissions сверх restricted-спейсов).
- `pageRepo.withHasChildren(eb)`
  ([page.repo.ts:539](apps/server/src/database/repos/page/page.repo.ts#L539)) —
  вычисление `hasChildren` в SQL (при отдаче всего дерева `hasChildren` можно и
  вывести на клиенте — у узла есть дети, если в ответе есть страница с
  `parentPageId === id`).

Плюсы серверного пути: один-два запроса вместо сотен; предсказуемо даже на
тысячах страниц; права считаются на сервере (единый источник правды); на клиенте
нет BFS/ограничителя параллелизма/защитного потолка. Минус — нужна работа на
бэкенде (новый рекурсивный режим эндпоинта) и контроль размера ответа.

## Где сейчас живёт код (точные места)

### Клиент — фича `apps/client/src/features/page/tree/`
- **Состояние раскрытия** —
  [open-tree-nodes-atom.ts](apps/client/src/features/page/tree/atoms/open-tree-nodes-atom.ts):
  `openTreeNodesAtom`, тип `OpenMap = Record<string, boolean>` (id → раскрыт ли),
  **персист в localStorage**, ключ `openTreeNodes:{workspaceId}:{userId}`.
  ⚠ **Карта общая для всех спейсов воркспейса.**
- **Данные дерева** —
  [tree-data-atom.ts](apps/client/src/features/page/tree/atoms/tree-data-atom.ts):
  `treeDataAtom: SpaceTreeNode[]`, накопительно по спейсам; на рендере
  фильтруется по `spaceId`.
- **Модель узла** —
  [types.ts](apps/client/src/features/page/tree/types.ts): `SpaceTreeNode`
  (`id`, `spaceId`, `hasChildren`, `children`, `name`, `icon`, `position`,
  `parentPageId`, `canEdit`, `slugId`).
- **Обёртка/тоггл/загрузка** —
  [space-tree.tsx](apps/client/src/features/page/tree/components/space-tree.tsx):
  `filteredData` (стр. 184-187, узлы текущего спейса), `handleToggle` (стр.
  164-182, ленивая загрузка уровня), `spaceIdRef` (стр. 46-47, защита от гонок).
- **Модель-операции** —
  [tree-model.ts](apps/client/src/features/page/tree/model/tree-model.ts):
  `find`, `appendChildren`, `visible`, `siblingsOf`.
- **HTTP-загрузка** —
  [page-query.ts](apps/client/src/features/page/queries/page-query.ts) +
  [page-service.ts](apps/client/src/features/page/services/page-service.ts):
  `getSidebarPages` / `getAllSidebarPages` (паджинируют **один уровень**),
  `fetchAllAncestorChildren`, утилиты `buildTree` / `buildTreeWithChildren` /
  `mergeRootTrees` ([utils.ts](apps/client/src/features/page/tree/utils/utils.ts)).
- **Шапка дерева (куда вешать команды)** —
  [space-sidebar.tsx:117-149](apps/client/src/features/space/components/sidebar/space-sidebar.tsx#L117):
  `SpaceMenu` (дропдаун на `IconDots`, стр. 172-281, уже с `Menu.Item`/
  `Menu.Divider`) + кнопка «+» (Create page).

### Сервер — фича `apps/server/src/core/page/`
- **Эндпоинт сайдбара** —
  [page.controller.ts:540](apps/server/src/core/page/page.controller.ts#L540)
  `POST /pages/sidebar-pages` (`SidebarPageDto`: `spaceId | pageId`),
  CASL-скоуп на спейс, отдаёт **один уровень**.
- **Сервис** —
  [page.service.ts:304](apps/server/src/core/page/services/page.service.ts#L304)
  `getSidebarPages(spaceId, pagination, pageId?, userId?, spaceCanEdit?)`:
  выборка одного уровня + `withHasChildren` + **двухветочная фильтрация прав** —
  если в спейсе нет ограничений (`pagePermissionRepo.hasRestrictedPagesInSpace`)
  → `canEdit = spaceCanEdit`; иначе per-page фильтр через
  `filterAccessiblePageIdsWithPermissions` + корректировка `hasChildren` по
  `getParentIdsWithAccessibleChildren`. **Эту же логику прав надо повторить в
  рекурсивном режиме.**

## Решение

### Серверная часть — «отдать всё поддерево» одним запросом

Добавить рекурсивный режим выдачи дерева. Варианты оформления (выбрать на ревью):
- флаг `recursive: true` (и опц. `depth`) к существующему `POST /pages/sidebar-pages`, **или**
- отдельный эндпоинт `POST /pages/tree` (`{ spaceId }` → всё дерево спейса;
  `{ pageId }` → всё поддерево страницы).

Контракт ответа: **плоский список элементов в точно том же shape, что и текущий
`/pages/sidebar-pages`** (`id`, `slugId`, `title`, `icon`, `position`,
`parentPageId`, `spaceId`, `hasChildren`, `canEdit`), чтобы клиентские
`buildTree`/`buildTreeWithChildren` собрали дерево без изменений. Порядок — по
`position` (collate "C"), как сейчас.

Сервисный метод (эскиз), переиспользует существующие кирпичи:
```ts
// Whole subtree (pageId) or whole space tree (spaceId only) in a single query,
// permission-filtered, returned as a flat list matching the sidebar item shape.
async getSidebarPagesTree(spaceId, userId, spaceCanEdit, pageId?) {
  const hasRestrictions = await this.pagePermissionRepo.hasRestrictedPagesInSpace(spaceId);

  // Seed: a single page subtree, or all root pages of the space.
  // - restricted space  -> *ExcludingRestricted (prunes closed subtrees in SQL)
  // - open space         -> plain recursive descendants
  // For the whole-space case add a space-rooted recursive CTE (seed:
  // parentPageId is null AND spaceId = ? AND deletedAt is null), mirroring
  // getPageAndDescendants/...ExcludingRestricted.
  let pages = hasRestrictions
    ? await this.pageRepo.getSpaceDescendantsExcludingRestricted(spaceId, pageId, { includeContent: false })
    : await this.pageRepo.getSpaceDescendants(spaceId, pageId, { includeContent: false });

  // Fine-grained per-page permissions on top of restricted pruning.
  if (hasRestrictions) {
    pages = await this.filterAccessibleTreePages(pages, pageId ?? null, userId, spaceId);
  }

  // Derive hasChildren from the returned set; stamp canEdit (per-page when
  // restricted, else spaceCanEdit). Same two-branch logic as getSidebarPages().
  return shapeAsSidebarItems(pages, { hasRestrictions, spaceCanEdit /*, permissionMap */ });
}
```
Где `getSpaceDescendants` / `getSpaceDescendantsExcludingRestricted` — новые
тонкие обёртки над существующими рекурсивными CTE (для случая «всё дерево спейса»
— CTE, засеянный корнями спейса вместо одного `parentPageId`).

**Важно про права:** обязательно сохранить **обе ветки** фильтрации из
`getSidebarPages` (restricted / не-restricted) и корректировку `hasChildren`,
иначе рекурсивный эндпоинт начнёт отдавать страницы, к которым у пользователя нет
доступа. Это критичная грань — на ревью проверить отдельно.

### Клиентская часть — упрощённый `expandAll`

Поскольку дерево приходит целиком, BFS/параллелизм/потолок не нужны.

`page-service.ts` — новый вызов:
```ts
// Fetch the whole space tree (all roots + descendants) in one shot.
export async function getSpaceTree(params: { spaceId: string; pageId?: string }): Promise<IPage[]> {
  const req = await api.post("/pages/tree", params); // or /sidebar-pages { recursive: true }
  return req.data.items;
}
```

`space-tree.tsx` — превратить `SpaceTree` в `forwardRef` и выставить
`useImperativeHandle`:
```ts
export type SpaceTreeApi = {
  expandAll: () => Promise<void>;
  collapseAll: () => void;
  isExpanding: boolean;
};

const expandAll = useCallback(async () => {
  const startSpaceId = spaceIdRef.current;
  setIsExpanding(true);
  try {
    // One request: the entire space tree, permission-filtered server-side.
    const items = await getSpaceTree({ spaceId: startSpaceId });
    if (spaceIdRef.current !== startSpaceId) return;        // space switched — abort

    const fullTree = buildTreeWithChildren(items);
    setData((prev) => {
      // Replace current-space nodes with the full tree; keep other spaces intact.
      const others = prev.filter((n) => n?.spaceId !== startSpaceId);
      return [...others, ...mergeRootTrees(prev.filter((n) => n?.spaceId === startSpaceId), fullTree)];
    });

    // Open every branch node of the current space.
    const branchIds = collectBranchIds(fullTree);           // nodes with children
    setOpenTreeNodes((prev) => {
      const next = { ...prev };
      for (const id of branchIds) next[id] = true;
      return next;
    });
  } catch (err) {
    // Never swallow: log full error + show the real reason (project convention).
    console.error("[tree] expandAll failed", err);
    notifications.show({ color: "red",
      message: t("Couldn't expand the tree: {{reason}}", { reason: err?.response?.data?.message ?? err?.message ?? String(err) }) });
  } finally {
    setIsExpanding(false);
  }
}, [/* setData, setOpenTreeNodes, t */]);
```

`collapseAll` — снимать раскрытие **только у узлов текущего спейса** (карта общая):
```ts
const collapseAll = useCallback(() => {
  // The open-map is shared across spaces; clearing it wholesale would drop
  // other spaces' expanded state. Collapse only current-space ids.
  const ids = new Set<string>();
  const walk = (nodes: SpaceTreeNode[]) => {
    for (const n of nodes) { ids.add(n.id); if (n.children?.length) walk(n.children); }
  };
  walk(filteredData);
  setOpenTreeNodes((prev) => {
    const next = { ...prev };
    for (const id of ids) next[id] = false;
    return next;
  });
}, [filteredData, setOpenTreeNodes]);
```

`space-sidebar.tsx` — `const treeRef = useRef<SpaceTreeApi | null>(null)`, передать
в `<SpaceTree ref={treeRef} ... />`, и подвесить команды в шапке. **Без
`canManage`-гейта** — это операция над видом, не над данными.

## UX-развилка по размещению

В шапке уже два значка (`IconDots` меню + `IconPlus` создать). Варианты:
- **(1) Две `ActionIcon`** «развернуть»/«свернуть» (`IconChevronsDown` /
  `IconChevronsUp`) → 4 значка в узкой шапке, явно и в один клик.
- **(2) Одна `ActionIcon`-тоггл** развернуть↔свернуть → 3 значка, компактнее, но
  состояние менее очевидно.
- **(3) Два `Menu.Item`** в `SpaceMenu` (`Развернуть всё` / `Свернуть всё` +
  `Menu.Divider`) → шапка не растёт, но в два клика и менее заметно.

> **Рекомендация:** **(3)** как самый чистый по вёрстке (узкая колонка) либо
> **(1)**, если важна доступность в один клик. Тултипы/`aria-label`:
> `t("Expand all")` / `t("Collapse all")`; во время загрузки — `loading`/
> `disabled` (`isExpanding`).

## Тонкие моменты / edge cases

- **Права в рекурсивном эндпоинте.** Самый важный пункт: повторить **обе** ветки
  фильтрации (restricted / открытый спейс) и корректировку `hasChildren` из
  `getSidebarPages`. Предпочесть `*ExcludingRestricted` (обрезает закрытые
  поддеревья в SQL) + `filterAccessibleTreePages` для per-page прав. На ревью —
  тест: пользователь без доступа к ветке не должен видеть её через «развернуть
  всё».
- **Размер ответа.** Всё дерево спейса может быть большим. `content` **не**
  тянуть (`includeContent: false`). Прикинуть потолок (число узлов) и поведение
  при очень больших спейсах — отдавать всё или ограничить + честно сообщить
  (конвенция: не молчать про усечение).
- **Скоуп карты раскрытия.** `openTreeNodesAtom` общая для спейсов — и
  `expandAll`, и `collapseAll` работают **только по узлам текущего спейса**.
- **Гонки при смене спейса.** Запрос асинхронный; сверяться с
  `spaceIdRef.current` и прерывать мёрдж/раскрытие, если спейс сменился (паттерн
  уже есть в эффектах `space-tree.tsx`).
- **Мёрдж с уже загруженным.** Полное дерево вмёрджить в `treeDataAtom`, заместив
  узлы текущего спейса (`mergeRootTrees`/замена ветки), **не трогая** узлы
  других спейсов.
- **Ошибки не глотать.** Любой сбой — `console.error` с полным объектом **и**
  уведомление с реальной причиной (`err.response?.data?.message`/`err.message`),
  не «что-то пошло не так» (CLAUDE.md «Errors must never be swallowed»).
- **Индикатор.** На крупном спейсе запрос заметный — кнопку в `loading`, чтобы не
  было повторных кликов/ощущения зависания.
- **Рост localStorage-карты.** `expandAll` пишет много ключей; для удалённых
  страниц ключи «висят». Не критично; уборка карты — отдельная задача.
- **Пустой спейс / одни листья.** Кнопки — no-op; «развернуть» можно `disabled`.
- **Шорткат `*`** (развернуть сиблингов,
  [doc-tree.tsx](apps/client/src/features/page/tree/components/doc-tree.tsx)) не
  трогаем — дополняем его.
- **Виртуализация.** Дерево на `@tanstack/react-virtual` — раскрытие тысяч строк
  рендер не убьёт (рисуются видимые), но резко меняет высоту скролла; проверить,
  что позиция/скролл не прыгают.

## Тесты / проверка

- **Сервер:** `pnpm --filter server test` (unit на новый сервисный метод).
  Кейсы: открытый спейс (видно всё), restricted-спейс (закрытые ветки и их
  поддеревья **не** попадают в ответ), per-page права (`canEdit`), корректный
  `hasChildren`, порядок по `position`, `content` не тянется.
- **Клиент:** `pnpm --filter client lint`, `pnpm --filter client test`.
- **Ручная:** глубокий спейс → «развернуть всё» раскрывает все уровни одним
  запросом, индикатор работает; «свернуть всё» схлопывает до корней и **не**
  теряет состояние другого спейса (переключиться туда-обратно); перезагрузка —
  состояние сохраняется (localStorage); смена спейса в середине загрузки —
  корректно прерывается; пустой спейс — без поломок; имитация ошибки сети — видно
  конкретное уведомление, ошибка залогирована.

## Открытые вопросы

1. **Оформление эндпоинта:** флаг `recursive` к `/pages/sidebar-pages` против
   отдельного `/pages/tree`. (Контракт ответа в обоих — плоский список в shape
   текущего сайдбара.)
2. **Размещение команд:** две иконки (1) / одна-тоггл (2) / пункты меню (3).
   Рекомендация — (3) или (1).
3. **Потолок размера ответа:** отдавать дерево любого размера или ограничить
   (число узлов) и как сообщать про усечение.
