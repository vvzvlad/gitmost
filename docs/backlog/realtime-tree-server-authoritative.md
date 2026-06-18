# Realtime-дерево: сделать обновления сервер-авторитетными (как контент)

## Контекст (проблема)

Контент страницы синхронизируется между пользователями в реальном времени всегда,
а **дерево страниц в сайдбаре не обновляется**, когда кто-то создаёт / перемещает /
удаляет страницу — у других участников спейса (а часто и у самого автора в соседней
вкладке) дерево «застывает» до ручного refetch (перезагрузка страницы или
переключение спейса).

Причина — в том, что это два разных realtime-канала с разной «авторитетностью»:

- **Контент — сервер-авторитетный (Yjs / Hocuspocus).** Любое изменение текста
  проходит через collab-сервер (`apps/server/src/collaboration/`) и раздаётся всем
  подписчикам документа независимо от того, кто и каким способом редактировал.
- **Дерево — ретрансляция, инициируемая клиентом.** Броадкаст изменения дерева
  делает **браузер автора**, а не сервер. Сервер только пересылает уже готовое
  сообщение другим клиентам и **сам по событиям жизненного цикла страницы ничего
  не вещает**.

Поэтому дерево обновляется у других **только если** страница создана через UI-дерево,
в открытой вкладке, при живом сокете, и вкладка не закрылась/не сменила URL в течение
~50 мс после действия. **Любой другой путь создания/изменения страницы броадкаста не
даёт вообще:** AI-агент (`core/ai-chat/tools/`), встроенный MCP `/mcp` и standalone
`@docmost/mcp`, REST API напрямую, импорт markdown/zip, копирование/дублирование
страницы, фоновые серверные операции.

Цель фичи: **перенести источник истины tree-событий на сервер** — чтобы дерево
обновлялось у всех в спейсе при любом способе изменения, надёжно, по аналогии с
контентом.

## Как сейчас устроено (цепочка)

### Клиентский relay (единственный текущий источник tree-событий)

- `apps/client/src/features/page/tree/hooks/use-tree-mutation.ts`
  - `handleCreate` (строки ~133-191): после успешного `createPageMutation` делает
    оптимистичную вставку в `treeDataAtom`, затем через `setTimeout(50)` —
    `emit({ operation: "addTreeNode", spaceId, payload: { parentId, index, data } })`.
  - `handleMove` (~46-131): оптимистично двигает узел, затем `emit("moveTreeNode", …)`.
  - `handleDelete` (~207-254): удаляет узел, затем `emit("deleteTreeNode", …)`.
  - `handleRename` (~193-205): оптимистично меняет имя, **emit НЕ делает**.
- `apps/client/src/features/websocket/use-query-emit.ts`: `emit` — это просто
  `socket?.emit("message", input)`.

### Сервер — только пересылка

- `apps/server/src/ws/ws.gateway.ts` (`@SubscribeMessage('message')`, ~64-69):
  если `wsService.isTreeEvent(data)` — отдаёт в `wsService.handleTreeEvent`.
- `apps/server/src/ws/ws.service.ts` `handleTreeEvent` (~27-58):
  `client.broadcast.to(getSpaceRoomName(spaceId)).emit('message', data)` — пересылка
  пришедшего от клиента события в комнату спейса (с учётом ограничений доступа).
- `apps/server/src/database/listeners/page.listener.ts`: слушает `PAGE_CREATED` /
  `PAGE_UPDATED` / `PAGE_DELETED` / `PAGE_SOFT_DELETED` / `PAGE_RESTORED`, но **только
  ставит задачи в очереди (search / AI)** — WebSocket не трогает.

### Что уже есть для серверного броадкаста (но не используется)

- `apps/server/src/ws/ws-tree.service.ts` — `WsTreeService` с методами
  `notifyPermissionGranted` (строит готовый payload `addTreeNode`) и
  `notifyPageRestricted` (payload `deleteTreeNode`). **Нигде не вызывается** (мёртвый
  код) — но это точный шаблон формата событий и доказательство, что инфраструктура
  серверного броадкаста работоспособна.
- `WsService.emitCommentEvent(spaceId, pageId, data)` (~66-87) — образец
  **серверного** броадкаста в комнату спейса с проверкой ограничений доступа
  (`spaceHasRestrictions` → `hasRestrictedAncestor` → `broadcastToAuthorizedUsers`).
- `WsModule` — `@Global`, экспортирует `WsService` и `WsTreeService`.

### Приёмник на клиенте (переиспользуем как есть)

- `apps/client/src/features/websocket/use-tree-socket.ts` (`socket.on("message")`):
  - `addTreeNode` (~55-74): вставляет узел; **идемпотентен** —
    `if (treeModel.find(prev, event.payload.data.id)) return prev;` (повторная
    доставка того же id безопасна).
  - `moveTreeNode` (~75-117), `deleteTreeNode` (~119-138), `updateOne` (~36-54).
- `apps/client/src/features/websocket/use-query-subscription.ts`: на те же события
  синхронизирует кэш TanStack Query сайдбара (`invalidateOnCreatePage`,
  `updateCacheOnMovePage`, `invalidateOnDeletePage`).

## Целевое поведение

При **любом** способе изменения структуры (UI, AI-агент, MCP, REST API, импорт,
копирование, фоновые операции) сервер сам рассылает соответствующее tree-событие всем
клиентам в комнате спейса (с учётом ограничений доступа), и у всех участников дерево
обновляется без ручного refetch:

- создание страницы → `addTreeNode`;
- перемещение/переупорядочивание → `moveTreeNode`;
- мягкое/жёсткое удаление → `deleteTreeNode`;
- восстановление из корзины → `addTreeNode` (или `refetchRootTreeNodeEvent`);
- (расширение) переименование / смена иконки → `updateOne`;
- (расширение) перенос между спейсами → `deleteTreeNode` в старом спейсе +
  `addTreeNode` в новом.

## Решение (архитектура)

Перенести генерацию tree-событий на сервер и сделать его единственным источником
истины. Состоит из трёх частей: (1) серверный эмиттер, (2) обогащённые доменные
события, (3) удаление клиентского relay.

### 1. Серверный метод броадкаста tree-события

В `WsService` добавить метод по образцу `emitCommentEvent` — рассылка в комнату спейса
с учётом ограничений доступа. Не исключаем автора: повторная доставка безопасна
благодаря идемпотентности приёмника (см. edge cases).

```ts
// apps/server/src/ws/ws.service.ts
// Server-origin tree broadcast. Mirrors emitCommentEvent: respects per-space page
// restrictions, then fans the event out to everyone in the space room. The author
// is NOT excluded — the client receiver is idempotent (addTreeNode early-returns if
// the node id already exists), so the author's optimistic node is preserved and
// non-UI creators (MCP / AI / API) still see their own page appear.
async emitTreeEvent(spaceId: string, pageId: string, data: any): Promise<void> {
  const room = getSpaceRoomName(spaceId);
  const hasRestrictions = await this.spaceHasRestrictions(spaceId);
  if (!hasRestrictions) {
    this.server.to(room).emit('message', data);
    return;
  }
  const isRestricted = await this.pagePermissionRepo.hasRestrictedAncestor(pageId);
  if (!isRestricted) {
    this.server.to(room).emit('message', data);
    return;
  }
  await this.broadcastToAuthorizedUsers(room, null, pageId, data);
}
```

`WsTreeService` расширить методами, которые строят payload и вызывают `emitTreeEvent`
(переиспользуя формат из существующих `notifyPermissionGranted`/`notifyPageRestricted`):

```ts
// apps/server/src/ws/ws-tree.service.ts
async broadcastPageCreated(page: TreeNodeData): Promise<void> {
  await this.wsService.emitTreeEvent(page.spaceId, page.id, {
    operation: 'addTreeNode',
    spaceId: page.spaceId,
    payload: {
      parentId: page.parentPageId ?? null,
      // Receivers should place by `position`, not this index — see edge cases.
      index: 0,
      data: {
        id: page.id, slugId: page.slugId,
        name: page.title ?? '', title: page.title, icon: page.icon,
        position: page.position, spaceId: page.spaceId,
        parentPageId: page.parentPageId, hasChildren: false, children: [],
      },
    },
  });
}

async broadcastPageDeleted(page: TreeNodeData): Promise<void> {
  await this.wsService.emitTreeEvent(page.spaceId, page.id, {
    operation: 'deleteTreeNode',
    spaceId: page.spaceId,
    payload: { node: { id: page.id, slugId: page.slugId, parentPageId: page.parentPageId } },
  });
}

async broadcastPageMoved(p: MovedTreeNodeData): Promise<void> {
  await this.wsService.emitTreeEvent(p.spaceId, p.id, {
    operation: 'moveTreeNode',
    spaceId: p.spaceId,
    payload: {
      id: p.id, parentId: p.parentPageId ?? null, oldParentId: p.oldParentId ?? null,
      index: 0, position: p.position,
      pageData: { id: p.id, slugId: p.slugId, title: p.title, icon: p.icon,
        position: p.position, spaceId: p.spaceId, parentPageId: p.parentPageId,
        hasChildren: p.hasChildren },
    },
  });
}
```

### 2. Источник событий: обогатить payload и/или эмитить из сервиса post-commit

Главная сложность — листенеру нужны поля, которых нет в `PageEvent`
(`{ pageIds, workspaceId }`), а дочитывание из БД по `pageId` гонится с транзакцией
(`insertPage`/`removePage` эмитят событие, иногда находясь внутри ещё не
закоммиченного `trx` — отдельный SELECT может не увидеть строку). Два варианта (см.
«Открытые вопросы», по умолчанию — **A**):

**Вариант A (рекомендуется): обогатить доменные события снимком узла.** Добавить в
payload событий тонкие поля дерева, чтобы листенер не читал БД:

```ts
// apps/server/src/database/listeners/page.listener.ts (PageEvent)
export class PageEvent {
  pageIds: string[];
  workspaceId: string;
  // Optional tree snapshots so the WS listener can broadcast without a DB read
  // (avoids the in-transaction visibility race on PAGE_CREATED / PAGE_SOFT_DELETED).
  pages?: TreeNodeSnapshot[]; // { id, slugId, title, icon, position, spaceId, parentPageId }
}
```

`insertPage` уже делает `returning(this.baseFields)` — снимок собирается из `result`
без доплат. `removePage` знает удаляемые `pageIds`; для `deleteTreeNode` достаточно
`{ id, slugId, parentPageId, spaceId }`, которые можно вернуть из того же `withRecursive`.

**Вариант B: эмитить tree-broadcast из сервиса после завершения операции (post-commit).**
Внедрить `WsTreeService` в `PageService` и вызывать `broadcastPage*` после успешного
`insertPage`/`removePage`/`movePage` (когда транзакция уже закоммичена и данные на
руках). Минус — размазывает realtime-логику по доменному сервису вместо одного
листенера.

### 3. Отдельное событие для перемещения

`movePage` сейчас эмитит общий `PAGE_UPDATED` — он непригоден: (а) не несёт
`oldParentId`/`position`, (б) срабатывает также на rename и сохранение контента (шум,
ложные `moveTreeNode`). Ввести выделенное событие:

```ts
// apps/server/src/common/events/event.contants.ts
PAGE_MOVED = 'page.moved',
```

`pageService.movePage()` знает старого родителя (читает страницу до апдейта), новый
`parentPageId` и новый `position` — эмитить `PAGE_MOVED` с полным снимком (вариант A)
после апдейта. Листенер вешает `@OnEvent(EventName.PAGE_MOVED)` →
`wsTreeService.broadcastPageMoved(...)`.

### 4. Новый листенер в модуле ws

```ts
// apps/server/src/ws/listeners/page-ws.listener.ts
@Injectable()
export class PageWsListener {
  constructor(private readonly wsTree: WsTreeService) {}

  @OnEvent(EventName.PAGE_CREATED)
  async onCreated(e: PageEvent) {
    for (const p of e.pages ?? []) await this.wsTree.broadcastPageCreated(p);
  }

  @OnEvent(EventName.PAGE_SOFT_DELETED)
  @OnEvent(EventName.PAGE_DELETED)
  async onDeleted(e: PageEvent) {
    for (const p of e.pages ?? []) await this.wsTree.broadcastPageDeleted(p);
  }

  @OnEvent(EventName.PAGE_MOVED)
  async onMoved(e: PageMovedEvent) { await this.wsTree.broadcastPageMoved(e); }

  @OnEvent(EventName.PAGE_RESTORED)
  async onRestored(e: PageEvent) {
    // Restore can re-attach a subtree; simplest correct option is a root refetch
    // hint (see edge cases) instead of N addTreeNode events.
    // await this.wsTree.broadcastRefetchRoot(spaceId);
  }
}
```

Зарегистрировать `PageWsListener` в `WsModule.providers`. `WsTreeService` уже там;
`PageRepo` доступен из глобального `DatabaseModule` (если выберем вариант B/дочитывание).

### 5. Убрать клиентский relay (источник истины — только сервер)

После включения серверного броадкаста убрать `emit(...)` из
`use-tree-mutation.ts` (`handleCreate`/`handleMove`/`handleDelete`) и связанный
`setTimeout(50)`. Оптимистичные локальные обновления **оставить** (мгновенный отклик у
автора). Тогда на каждую операцию будет ровно один броадкаст (серверный), исчезает
гонка 50 мс и зависимость от того, успел ли браузер автора отправить событие.

> Безопасный порядок выката: серверный броадкаст можно включить, **не** удаляя relay
> сразу — приёмник идемпотентен, дубль `addTreeNode`/`deleteTreeNode` безвреден (второй
> — no-op). Это позволяет проверить серверный путь в изоляции, затем удалить relay
> отдельным коммитом. `moveTreeNode` при двойной доставке тоже идемпотентен по позиции.

## Тонкие моменты / edge cases

- **Гонка видимости транзакции.** Главная причина выбрать вариант A (снимок в
  событии): `insertPage`/`removePage` эмитят событие, находясь иногда внутри
  незакоммиченного `trx`; отдельный SELECT в листенере может не увидеть строку.
  Существующие листенеры (search/AI) не страдают, т.к. лишь ставят отложенную задачу,
  выполняемую после коммита. Синхронный re-fetch для броадкаста — нет.
- **Двойная вставка у автора.** Не исключаем автора из рассылки: приёмник `addTreeNode`
  делает `if (treeModel.find(prev, id)) return prev` — у UI-автора оптимистичный узел
  уже есть, серверное событие игнорируется (и не затирает редактируемое имя). У
  non-UI автора (MCP/AI/API) узла нет — он его получит. Это и есть аргумент против
  `emitToSpaceExceptUsers([creatorId])`: исключение автора сломало бы non-UI случай.
- **Порядок/позиция.** Сервер не знает локальный `index` каждого получателя (корневой
  список пагинируется, у клиентов разный набор загруженных узлов). Поэтому в payload
  кладём `position` (фракционный индекс — реальный порядок), а приёмник `addTreeNode`
  стоит доработать так, чтобы вставлять **по `position`** среди уже загруженных
  сиблингов, а не по абсолютному `index` отправителя. Сейчас `treeModel.insert`
  принимает `index`; нужна вставка с сортировкой по `position` (или отдельный
  `insertByPosition`). Без этого порядок у получателей может разойтись.
- **Пагинация корня → дубликаты.** Если новая корневая страница по `position` попадает
  за пределы уже загруженного «окна» корневого инфинит-списка, прямая вставка в атом
  может позже задвоиться при подгрузке следующей страницы. `use-query-subscription.ts`
  уже инвалидирует кэш сайдбара на `addTreeNode` (`invalidateOnCreatePage`) — следить,
  чтобы оба приёмника (`useTreeSocket` мутирует атом, `useQuerySubscription`
  инвалидирует query) сходились к одному состоянию и не дублировали узлы.
- **Перенос между спейсами (`movePageToSpace`).** Сейчас эмитит `PAGE_MOVED_TO_SPACE`
  **без листенера**. Корректный realtime: в **старом** спейсе — `deleteTreeNode`, в
  **новом** — `addTreeNode` (для всего перенесённого поддерева — вероятно проще
  `refetchRootTreeNodeEvent` на оба спейса). Вынести в отдельный пункт объёма.
- **Восстановление из корзины (`PAGE_RESTORED`).** Может вернуть целое поддерево и
  переприкрепить его к родителю. N точечных `addTreeNode` хрупки по порядку — проще
  отправить `refetchRootTreeNodeEvent` (он уже поддержан и сервером-пересыльщиком, и
  `use-query-subscription`), пусть клиенты перезапросят корень спейса.
- **Rename / иконка.** `handleRename` сейчас emit не делает, а `updateOne` хоть и
  обрабатывается приёмником, серверно не рассылается → переименования тоже не
  пропагируются. Естественное расширение этой же фичи: на `PAGE_UPDATED`, когда
  изменились `title`/`icon`, слать `updateOne` (но фильтровать, чтобы не слать на
  каждое сохранение контента). Вынесено в расширения, чтобы не раздувать базовый объём.
- **Каскадное мягкое удаление.** `removePage` удаляет всё поддерево и эмитит **все**
  `pageIds` потомков. Для дерева достаточно одного `deleteTreeNode` по корню удаляемого
  поддерева (клиент `treeModel.remove` убирает узел с детьми). Слать событие только по
  корню удаления, а не по каждому потомку, иначе лишний трафик.
- **Ограничения доступа** наследуются бесплатно из `emitCommentEvent`-паттерна
  (`spaceHasRestrictions` → `hasRestrictedAncestor` → `broadcastToAuthorizedUsers`):
  закрытые страницы не утекут неавторизованным.
- **Мёртвый `WsTreeService`.** Его текущие `notifyPermissionGranted` /
  `notifyPageRestricted` нигде не вызываются — заодно проверить, не должны ли они
  вызываться при смене прав доступа на страницу (отдельный, но смежный баг realtime).
- **Идемпотентность move/delete.** `moveTreeNode` (place по позиции) и `deleteTreeNode`
  (`if (!find) return prev`) тоже безопасны к повторной доставке — это позволяет
  поэтапный выкат (п. 5).
- **Комментарии в коде — на английском** (правило проекта).

## Объём работ (файлы)

Сервер:
- [ ] `apps/server/src/common/events/event.contants.ts` — добавить `PAGE_MOVED`
      (и при необходимости тип `PageMovedEvent`).
- [ ] `apps/server/src/database/listeners/page.listener.ts` — обогатить `PageEvent`
      снимками узлов (вариант A); экспортировать общий тип снимка.
- [ ] `apps/server/src/database/repos/page/page.repo.ts` — класть снимок в payload
      `PAGE_CREATED` (`insertPage`) и `PAGE_SOFT_DELETED` (`removePage`, только корень
      удаления).
- [ ] `apps/server/src/core/page/services/page.service.ts` — `movePage` эмитит
      `PAGE_MOVED` со старым/новым родителем и `position` (и `movePageToSpace` — для
      расширения).
- [ ] `apps/server/src/ws/ws.service.ts` — `emitTreeEvent(spaceId, pageId, data)`.
- [ ] `apps/server/src/ws/ws-tree.service.ts` — `broadcastPageCreated/Deleted/Moved`
      (+ опц. `broadcastRefetchRoot`).
- [ ] `apps/server/src/ws/listeners/page-ws.listener.ts` — новый листенер.
- [ ] `apps/server/src/ws/ws.module.ts` — зарегистрировать `PageWsListener`.

Клиент:
- [ ] `apps/client/src/features/page/tree/hooks/use-tree-mutation.ts` — убрать
      `emit(...)` и `setTimeout(50)` из create/move/delete (оптимистику оставить).
- [ ] `apps/client/src/features/page/tree/model/tree-model.ts` —
      вставка `addTreeNode` по `position` среди сиблингов (а не по абсолютному index).
- [ ] Проверить согласованность `use-tree-socket.ts` и `use-query-subscription.ts`
      (мутация атома vs инвалидация кэша) — без дубликатов узлов.

## Тесты

- Сервер (Jest): юнит на `WsTreeService.broadcastPage*` — корректный формат payload
  (`operation`, `spaceId`, `payload.data/node/pageData`) для create/delete/move.
  `emitTreeEvent` — рассылка в комнату спейса и ветка ограничений (restricted →
  только авторизованные). Запуск: `pnpm --filter server test`.
- Клиент (Vitest): приёмник `addTreeNode` идемпотентен (повтор того же id — no-op);
  вставка по `position` даёт верный порядок при разном наборе загруженных сиблингов.
- Линт: `pnpm --filter server lint`, `pnpm --filter client lint`.
- Ручная проверка матрицы способов создания: UI-дерево, AI-агент, MCP `/mcp`, REST
  `POST /pages/create`, импорт markdown — во всех случаях дерево обновляется у второго
  пользователя без перезагрузки.

## Альтернативы

- **Только клиентский патч (быстро, не рекомендуется).** Убрать `setTimeout(50)` и/или
  слать `refetchRootTreeNodeEvent` после create. Лечит лишь UI-сценарий между людьми,
  не покрывает AI/MCP/API и остаётся клиент-зависимым — против цели фичи.
- **Сервер всегда шлёт `refetchRootTreeNodeEvent` вместо точечных событий.** Проще
  (не нужен снимок узла, нет проблемы порядка), но грубее: каждый клиент перезапрашивает
  корневое дерево спейса на любое изменение — больше нагрузки и моргание UI. Возможен
  как временный/откатной режим для сложных случаев (restore, move-to-space).
- **Вариант B (эмит из сервиса post-commit)** вместо обогащения событий — см. п. 2.
  Надёжно по транзакциям, но размазывает realtime-логику по доменному сервису.

## Открытые вопросы (согласовать перед реализацией)

- [ ] Источник данных для броадкаста: обогатить доменные события снимком узла
      (**вариант A, рекомендуется**) или эмитить из сервиса post-commit (вариант B)?
- [ ] Удалять клиентский relay сразу в той же задаче или вторым коммитом после
      проверки серверного пути (приёмник идемпотентен — оба варианта безопасны)?
- [ ] `restore` и `move-to-space`: точечные `addTreeNode`/`deleteTreeNode` или более
      простой и устойчивый `refetchRootTreeNodeEvent` на затронутые спейсы?
- [ ] Включать ли в базовый объём rename/иконку (`updateOne` от сервера на
      `PAGE_UPDATED`) или вынести в отдельную задачу?
- [ ] Чинить ли заодно мёртвый `WsTreeService` (broadcast при смене прав доступа) —
      в рамках этой задачи или отдельной?
