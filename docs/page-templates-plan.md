# Шаблоны страниц — живая вставка целой страницы в другие — дизайн

> Статус: **черновик / дизайн**. Реализация ещё не начата.
> Исходный кейс: одну страницу-«шаблон» нужно вставлять в несколько других так,
> чтобы при правке источника вставки обновлялись автоматически.
>
> Принятые на старте решения (выбор пользователя):
> - **Семантика** — живая синхронная вставка (контент источника обновляется в местах вставки), НЕ статическая копия.
> - **Сценарий** — вставка ноды в тело существующей страницы через slash-команду + пикер.
> - **Источник** — обычная страница со спец-флагом `is_template`.

## 1. Что уже есть в кодовой базе (и почему мы это расширяем)

В Gitmost уже реализована **блочная транслюзия** (synced blocks) — она покрывает «вставить ОДИН блок живой ссылкой в другие страницы»:

- Ноды `transclusionSource` / `transclusionReference` — [packages/editor-ext/src/lib/transclusion/](../packages/editor-ext/src/lib/transclusion/).
- Таблицы `page_transclusions` (снапшот каждого source-блока на странице) и `page_transclusion_references` (кто кого ссылается) — [миграция](../apps/server/src/database/migrations/20260501T202258-page-transclusions.ts).
- Сервис [transclusion.service.ts](../apps/server/src/core/page/transclusion/transclusion.service.ts): `lookup`, `lookupWithAccessSet`, `syncPageTransclusions`, `syncPageReferences`, `unsyncReference`, `listReferences`, `insert*ForPages`.
- Контроль доступа: `filterViewerAccessiblePageIds` (членство в space + page-permissions) и публичный share-путь `ShareService.lookupTransclusionForShare` (граф доступа share, токенизация вложений, срезание комментариев).
- Клиент: read-only рендерер [transclusion-content.tsx](../apps/client/src/features/editor/components/transclusion/transclusion-content.tsx), батчинг-контекст [transclusion-lookup-context.tsx](../apps/client/src/features/editor/components/transclusion/transclusion-lookup-context.tsx), вьюха ссылки [transclusion-reference-view.tsx](../apps/client/src/features/editor/components/transclusion/transclusion-reference-view.tsx).
- Синхронизация ссылок происходит в [persistence.extension.ts](../apps/server/src/collaboration/extensions/persistence.extension.ts) (`syncTransclusion` после сохранения документа), **только для Yjs-путей** (живой коллаб). REST-обновления контента сейчас транслюзию не пересинхронизируют.

**Вывод:** нужная фича — это та же транслюзия, но на уровне **целой страницы**, а не блока, плюс пометка источника флагом. ~70 % инфраструктуры переиспользуется; писать с нуля нужно только нодy `pageEmbed`, whole-page lookup, флаг `is_template` и UI-вставку.

### Что НЕ переиспользуем

В БД есть upstream-таблица `Templates` (Docmost), настройка `allowMemberTemplates`, тип избранного `template` и урезанный `TemplateSlashCommand`/`templateExtensions`. **Это другая, статическая механика** («создать страницу из шаблона-копии») и она не подходит под выбранный сценарий (живой синхрон + источник-страница). Не конфликтуем с ней, но и не строим на ней — ведём отдельный флаг `is_template` на странице. Урезанный `TemplateSlashCommand` к нашей фиче отношения не имеет.

## 2. Модель

- **Шаблон** = обычная, живая, редактируемая страница с `pages.is_template = true`. Флаг меняет только то, *как* страница всплывает (пикер шаблонов, опционально — группировка/скрытие в дереве), но не запрещает её редактировать или открывать как обычную.
- **Вставка** = новая Tiptap-нода `pageEmbed` (блочная, `atom`, `isolating`) с атрибутом `sourcePageId`. Рендерится read-only: вьюха тянет **весь** текущий контент страницы-источника и показывает его. Снапшот контента в документе хоста НЕ хранится — только ссылка `sourcePageId`. За счёт этого вставка «живая».
- **Обратные ссылки** = таблица `page_template_references` (`reference_page_id`, `source_page_id`) — чтобы знать «где используется этот шаблон» (для предупреждения при удалении и инвалидации кэша). Аналог `page_transclusion_references`, но whole-page.

## 3. Развилка: отдельная нода `pageEmbed` vs расширение `transclusionReference`

### Вариант A (рекомендуется) — отдельная нода `pageEmbed`
`transclusionReference` адресует конкретный блок по `transclusionId` внутри `sourcePageId`. У whole-page нет `transclusionId`. Можно было бы подставлять sentinel (`transclusionId = '__page__'`), но это засоряет инварианты уже работающей блочной транслюзии и её UNIQUE-констрейнт.

- **Плюсы:** проверенный блочный путь не трогаем (нулевой риск регрессии); чистое разделение; при этом переиспользуем хелперы (рендерер, батчинг, контроль доступа).
- **Минусы:** чуть больше нового кода (новая нода, вьюха, эндпоинт, таблица).

### Вариант B — расширить `transclusionReference` на whole-page (`transclusionId = null`)
- **Плюсы:** максимум переиспользования (та же нода, lookup, unsync, ремап при duplicate).
- **Минусы:** NULL в UNIQUE-констрейнте Postgres ведёт себя нетривиально (NULL-ы различны); ломаются инварианты рабочей фичи; риск регрессии блочной транслюзии.

**Решение:** Вариант A. Дальше дизайн исходит из `pageEmbed`.

## 4. Модель данных (миграции)

Соглашение по именованию: `apps/server/src/database/migrations/YYYYMMDDThhmmss-description.ts`. Только ДОБАВЛЯЕМ столбцы/таблицы. После — `pnpm --filter server migration:codegen` для регенерации `src/database/types/db.d.ts`.

**Миграция 1 — флаг шаблона:**
```sql
ALTER TABLE pages ADD COLUMN is_template boolean NOT NULL DEFAULT false;
-- частичный индекс под пикер шаблонов
CREATE INDEX pages_is_template_idx ON pages (workspace_id) WHERE is_template;
```

**Миграция 2 — обратные ссылки whole-page (можно отложить до фазы 2, см. §9):**
```sql
CREATE TABLE page_template_references (
  id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reference_page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE, -- где встроено
  source_page_id    uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE, -- какой шаблон
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reference_page_id, source_page_id)
);
CREATE INDEX page_template_references_source_idx ON page_template_references (source_page_id);
CREATE INDEX page_template_references_ws_idx     ON page_template_references (workspace_id);
```

## 5. Бэкенд

### 5.1. Флаг `is_template`
- Тоггл: новый `POST /pages/toggle-template` (или поле в существующем `POST /pages/update`) → `pages.is_template`. Авторизация — стандартная CASL (право `Edit` на page/space, как у прочих мутаций страницы).
- `is_template` добавить в выдачу `pageRepo.findById` (колонка уже попадёт в `pages` select; убедиться, что отдаётся клиенту в `IPage`).
- Поиск: расширить search-suggestions фильтром `onlyTemplates` (для пикера показывать только `is_template = true`).

### 5.2. Whole-page lookup (для авторизованных)
Новый эндпоинт `POST /pages/template/lookup`:
```
Body: { sourcePageIds: string[] }   // ≤ 50, как у block-lookup
Resp: { items: Array<
          | { sourcePageId, title, icon, content, sourceUpdatedAt }
          | { sourcePageId, status: 'no_access' | 'not_found' }
        > }
```
- Доступ: переиспользовать `filterViewerAccessiblePageIds` (членство в space + `pagePermissionRepo.filterAccessiblePageIds`). Если страница недоступна → `no_access`; удалена/нет → `not_found`.
- Контент: брать `pages.content`; **срезать `comment`-марки** (комментарии принадлежат источнику) через `removeMarkTypeFromDoc(doc, 'comment')` — как делает share-путь.
- `not_template`: можно НЕ запрещать встраивать не-шаблон (флаг — это про обнаружение в пикере, а не жёсткий констрейнт). Решение: lookup отдаёт контент любой доступной страницы; пикер же показывает только шаблоны. Это упрощает и не создаёт «битых» вставок, если со страницы потом сняли флаг.

### 5.3. Синхронизация обратных ссылок
- Добавить `collectPageEmbedsFromPmJson(doc)` рядом с [transclusion-prosemirror.util.ts](../apps/server/src/core/page/transclusion/utils/transclusion-prosemirror.util.ts) — обход PM JSON, сбор `pageEmbed` нод → `{ sourcePageId }[]` (дедуп).
- Добавить `syncPageTemplateReferences(referencePageId, workspaceId, pmJson)` (diff с `page_template_references`) и дёрнуть его в `persistence.extension.syncTransclusion`.
- **Известный пробел:** REST-обновления контента (агент/AI через `updatePageContent`) не вызывают `syncTransclusion`. Для нашей фичи это терпимо: lookup работает по `sourcePageId` из самой ноды, а рассинхрон затронет только обратную таблицу (UI «где используется»). Отметить как follow-up.

### 5.4. Публичный share-путь (фаза 2)
Зеркалить `ShareService.lookupTransclusionForShare` → `POST /shares/template/lookup`:
- источник-шаблон резолвится, только если он сам попадает в граф доступа share (его шарили / есть расшаренный предок с `includeSubPages`);
- токенизация вложений источника, срезание комментариев, схлопывание `not_found → no_access` (анти-утечка).
- **UX-нюанс:** шаблоны обычно лежат вне расшаренного поддерева → по умолчанию в публичном share они дадут `no_access` (вьюха покажет плейсхолдер). Это безопасный дефолт (без случайной утечки). Альтернатива «запекать контент шаблона в хост для share-зрителя» — отдельное решение, фаза 3.

### 5.5. Ремап при дублировании страниц
В `duplicatePage` ([page.service.ts](../apps/server/src/core/page/services/page.service.ts)) уже ремапятся `mention` и `transclusionReference.sourcePageId`. Добавить ремап `pageEmbed.sourcePageId` (если источник тоже в копируемом наборе → указать на новую копию; иначе оставить как есть). Плюс `insertTemplateReferencesForPages` по аналогии с `insertReferencesForPages`.

### 5.6. Регистрация ноды в серверной схеме (критично!)
Нода `pageEmbed` должна быть зарегистрирована в **серверном** `tiptapExtensions` ([collaboration.util.ts](../apps/server/src/collaboration/collaboration.util.ts)), иначе сервер вырежет её при сохранении/коллаборации (та же ловушка, что описана в [arbitrary-html-embed-plan.md](./arbitrary-html-embed-plan.md) §2). MCP-зеркало схемы (`packages/mcp/src/lib/`) — обновлять не обязательно для MVP (MCP может трактовать ноду как opaque), отметить как follow-up.

## 6. Клиент

### 6.1. Нода `pageEmbed`
- Новый модуль `packages/editor-ext/src/lib/page-embed/page-embed.ts`: `Node.create({ name:'pageEmbed', group:'block', atom:true, isolating:true })`, атрибут `sourcePageId` с `parseHTML`/`renderHTML` через `data-source-page-id` (для round-trip HTML↔JSON и paste). Экспорт в `packages/editor-ext/src/index.ts`.
- Регистрация в клиентских `mainExtensions` ([extensions.ts](../apps/client/src/features/editor/extensions/extensions.ts)) и серверной схеме (§5.6).

### 6.2. NodeView `page-embed-view.tsx`
- Тянет whole-page контент через `useTemplateLookup` (расширить/обобщить батчинг-паттерн `transclusion-lookup-context.tsx`, или TanStack Query с ключом `sourcePageId`).
- Тело рендерит read-only вложенным редактором по образцу [transclusion-content.tsx](../apps/client/src/features/editor/components/transclusion/transclusion-content.tsx) (изоляция событий, `editable=false`, `UniqueID` с `updateDocument:false`).
- Шапка: иконка+заголовок шаблона со ссылкой на источник, кнопка «обновить», меню «отвязать → превратить в статическую копию» (новый `unsyncPageEmbed`, запекает текущий контент в документ хоста — по образцу `unsyncReference`).
- **Защита от циклов** (см. §7.1).

### 6.3. Slash-команда + пикер
- Slash-пункт `/template` (или `/embed page`) открывает пикер страниц — переиспользовать [mention-list.tsx](../apps/client/src/features/editor/components/mention/mention-list.tsx) + search-query с фильтром `onlyTemplates` → вставляет `pageEmbed` с выбранным `sourcePageId`.

### 6.4. Пометить страницу как шаблон
- Тоггл «Сделать шаблоном / Снять» в меню узла дерева ([space-tree-node-menu.tsx](../apps/client/src/features/page/tree/components/space-tree-node-menu.tsx)) и/или в «...» меню заголовка страницы → мутация на `POST /pages/toggle-template`.
- (Опционально, фаза 2) Галерея/раздел «Шаблоны».

## 7. Краевые случаи (главное)

### 7.1. Циклы / бесконечная рекурсия (самое важное)
A встраивает B, B встраивает A → бесконечная вложенность на клиенте. Сервер из lookup отдаёт «сырой» контент одного уровня и зациклиться не может — **гард обязателен на клиенте**:
- React-контекст с цепочкой `sourcePageId` предков; если текущий `sourcePageId` уже в цепочке → рендерить плейсхолдер «циклическая вставка», не рекурсировать.
- Жёсткий лимит глубины вложенности (например, 5).
- При выборе в пикере запрещать вставку самой текущей страницы (self-embed). Полное обнаружение циклов на вставке (обход графа) — избыточно, опираемся на рендер-гард.

### 7.2. Удаление шаблона
Удаление страницы-шаблона — soft-delete (корзина) → вставки дают `not_found`/`no_access`, вьюха показывает «шаблон в корзине/не найден». Таблица `page_template_references` позволяет предупредить «используется в N страницах» перед удалением. При восстановлении вставки снова резолвятся.

### 7.3. Доступ
Зритель хоста может не иметь доступа к странице-источнику (другой space/ограничение) → lookup вернёт `no_access`, вьюха — плейсхолдер. Это корректно (без утечки).

### 7.4. Комментарии
Срезать `comment`-марки из встроенного контента (`removeMarkTypeFromDoc`) — комментарии относятся к источнику.

### 7.5. Вложения
Встроенный контент ссылается на вложения источника. Для авторизованных доступ обычный (lookup уже проверил доступ к источнику). Для публичных share — токенизация по образцу share-пути (фаза 2).

### 7.6. Вложенные транслюзии внутри шаблона
Шаблон может содержать `transclusionSource`/`transclusionReference`/`pageEmbed`. При whole-page рендере они отрисуются своими вьюхами (доп. вложенные lookup-и) — работает, но учитывать в гарде глубины (§7.1).

### 7.7. История версий хоста
В истории хоста хранится только нода-ссылка (мелкая), не снапшот. Значит старые версии хоста покажут *текущий* контент шаблона (живой), без point-in-time точности. Снапшот-режим — вне scope, отметить.

### 7.8. Экспорт (Markdown/HTML) и RAG/поиск
`jsonToHtml`/`jsonToMarkdown`/`jsonToText` на сервере не развернут `pageEmbed` (в документе только ссылка) → экспорт и `textContent` хоста не содержат текста шаблона; полнотекстовый/RAG-поиск не найдёт хост по тексту шаблона. Для MVP — плейсхолдер/ссылка; серверное разворачивание вставок при экспорте/индексации — фаза 3.

## 8. Реестр переиспользования

| Что | Файл | Как используем |
| --- | --- | --- |
| Read-only рендерер | `transclusion-content.tsx` | тело `pageEmbed` |
| Батчинг lookup | `transclusion-lookup-context.tsx` | `useTemplateLookup` |
| Контроль доступа | `transclusion.service.ts::filterViewerAccessiblePageIds` / `lookupWithAccessSet` | whole-page lookup |
| Share-путь | `share.service.ts::lookupTransclusionForShare` | `lookupTemplateForShare` (фаза 2) |
| Sync ссылок | `persistence.extension.ts::syncTransclusion` + `collectReferencesFromPmJson` | `+ collectPageEmbedsFromPmJson` / `syncPageTemplateReferences` |
| Unsync→копия | `transclusion.service.ts::unsyncReference` | `unsyncPageEmbed` |
| Пикер страниц | `mention-list.tsx` + search-query | пикер шаблонов (`onlyTemplates`) |
| Ремап при копировании | `page.service.ts::duplicatePage` | `+ ремап pageEmbed.sourcePageId` |
| Меню страницы | `space-tree-node-menu.tsx` | тоггл «Сделать шаблоном» |
| Серверная схема | `collaboration.util.ts::tiptapExtensions` | регистрация `pageEmbed` (критично) |

## 9. Этапность

- **MVP:** флаг `is_template` + тоггл-UI; нода `pageEmbed` + вьюха (живой read-only fetch с гардом циклов); `/template` slash + пикер; auth-эндпоинт lookup; синхронизация ссылок; ремап при duplicate. Без share (на публичных страницах — плейсхолдер), без разворачивания при экспорте. Таблица `page_template_references` — желательна, но можно начать с резолва по in-doc нодам.
- **Фаза 2:** публичный share-lookup; «отвязать → статическая копия»; «используется в N страницах» + предупреждение при удалении; галерея шаблонов.
- **Фаза 3:** разворачивание вставок на сервере для экспорта/RAG/textContent; режим point-in-time снапшота; обновление MCP-зеркала схемы; sync ссылок на REST-пути.

## 10. Открытые вопросы

1. Прятать ли страницы-шаблоны из обычного дерева space или показывать с бейджем? (предлагаю: показывать с бейджем, отдельную «галерею» — фаза 2).
2. Ограничивать ли источник только `is_template`-страницами на бэке, или разрешать встраивать любую доступную (флаг — только для пикера)? (предлагаю второе — меньше «битых» вставок).
3. Нужен ли whole-page embed на публичных share сразу в MVP или плейсхолдер достаточен на старте? (предлагаю плейсхолдер → фаза 2).
