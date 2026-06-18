# Удаление нерабочих импортов (DOCX / PDF / Confluence)

Контекст: DOCX, PDF и Confluence-импорт опирались на приватный EE-модуль,
который выпилен из репозитория. В community-сборке эти пути либо бросают
"enterprise license" (DOCX/PDF), либо молча ничего не делают (Confluence).
Решено убрать эти форматы целиком.

## Уже сделано (фронтенд) — лежит в рабочем дереве, НЕ закоммичено

- `apps/client/src/features/page/components/page-import-modal.tsx`
  — убраны кнопки Word (DOCX), PDF, Confluence + связанный мёртвый код
  (импорты иконок `IconFileTypeDocx`/`IconFileTypePdf`/`ConfluenceIcon`,
  рефы `docxFileRef`/`pdfFileRef`/`confluenceFileRef`, ветка `confluence`
  в `handleZipUpload`, сбросы docx/pdf в `handleFileUpload`).
  Остались рабочие: Markdown, HTML, Notion, generic-zip.
- `apps/client/src/components/icons/confluence-icon.tsx` — удалён (git rm),
  больше нигде не импортируется.

Статус git на момент записи:
- `D  apps/client/src/components/icons/confluence-icon.tsx`
- `M  apps/client/src/features/page/components/page-import-modal.tsx`

Предложенное сообщение коммита для фронтенд-части уже сформулировано
(refactor(import): remove non-functional DOCX/PDF/Confluence import buttons).

## Осталось сделать (бэкенд) — ТЕКУЩАЯ ЗАДАЧА: удалить заглушки

Заглушки = EE-require шимы, которые throw/return. Точки правок:

1. `apps/server/src/integrations/import/services/import.service.ts`
   - удалить метод `processDocx` (~160-194) — EE-require → BadRequestException.
   - удалить метод `processPdf` (~196-230) — то же.
   - в `importPage` удалить ветки диспетчера `else if (.docx)` и `else if (.pdf)`
     (~76-91); оставить `.md` и `.html`.
   - удалить вычисление `pageId` (~65-69): после удаления docx/pdf оно всегда
     `undefined`, поэтому убрать и спред `...(pageId ? { id: pageId } : {})`
     в `insertPage` (~115).
   - `uuid7` (импорт, стр. 26) — НЕ трогать: используется в `importZip`
     (`const fileTaskId = uuid7();`, ~320).
   - `moduleRef` (конструктор ~45, импорт `ModuleRef` стр. 31) — ПРОВЕРИТЬ:
     использовался только в processDocx/processPdf? Если да — убрать параметр
     конструктора и импорт. (grep был прерван, нужно перепроверить.)

2. `apps/server/src/integrations/import/services/file-import-task.service.ts`
   - удалить ветку `if (fileTask.source === FileImportSource.Confluence) {...}`
     (~118-138) — EE-require с тихим `return`.
   - после удаления проверить, что импорт `FileImportSource` всё ещё нужен
     (Generic/Notion используются на ~109-110 — нужен).

3. `apps/server/src/integrations/import/import.controller.ts`
   - стр. 54: `validFileExtensions = ['.md', '.html', '.docx', '.pdf']`
     → `['.md', '.html']`.
   - стр. ~101-106 `sourceMap`: убрать записи `'.docx': 'docx'` и `'.pdf': 'pdf'`.
   - стр. 164: `validZipSources = ['generic', 'notion', 'confluence']`
     → `['generic', 'notion']`.
   - стр. 167: текст ошибки → "must either be generic or notion".

4. `apps/server/src/integrations/import/utils/file.utils.ts`
   - стр. 13: убрать `Confluence = 'confluence'` из enum `FileImportSource`
     (после удаления ветки значение не используется).
     ПРОВЕРИТЬ grep'ом, что больше нет ссылок на `FileImportSource.Confluence`.

5. `apps/server/src/common/features.ts`
   - стр. 9: `CONFLUENCE_IMPORT: 'import:confluence'` — ПРОВЕРИТЬ использование
     по серверу и клиенту; если не используется — убрать.

## Вне scope (НЕ заглушки — рабочий, но теперь недостижимый код)

- `isConfluenceImport`-обвязка в
  `apps/server/src/integrations/import/services/import-attachment.service.ts`
  (стр. 57, 67, 98, 674, 682, 756, 770) и confluence-стриппинг путей в
  `apps/server/src/integrations/import/utils/import.utils.ts` (стр. 45-62).
  Это реальная логика разбора вложений, а не заглушка. После удаления
  Confluence-импорта флаг `isConfluenceImport` никогда не станет true →
  код станет мёртвым, но он внутри shared-сервиса, которым пользуются
  generic/notion. Удаление — отдельный, более рискованный рефакторинг.
  Решение: пока оставить (либо отдельной задачей).
- Комментарий в миграции `20250521T154949-file_tasks.ts:11` "(generic, notion,
  confluence)" — это просто комментарий, схему/старые миграции не трогаем.

## Открытые вопросы (проверить перед/во время реализации; grep был прерван)

- [ ] `moduleRef` в import.service.ts — используется только docx/pdf?
- [ ] Все ссылки на `FileImportSource.Confluence` — только удаляемая ветка?
- [ ] `CONFLUENCE_IMPORT` / `import:confluence` — где используется (сервер+клиент)?
- [ ] `isConfluenceImport=true` ставится где-то кроме удалённого EE-модуля?

## Процесс

- Режим делегирования (по умолчанию). Бэкенд-правка нетривиальна →
  делегировать general-purpose кодеру, затем обязательный прогон `review`.
- Не коммитить; в конце предложить сообщение коммита. Учесть, что фронтенд-
  правки уже лежат в рабочем дереве (можно одним коммитом или отдельными).
