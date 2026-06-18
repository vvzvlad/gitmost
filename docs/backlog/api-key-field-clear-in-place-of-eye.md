# Поле «API key»: убрать бесполезный «глазок», поставить Clear на его место

Статус: **план, код не менялся.** UI-задача на клиенте. Бэкенда не касается.

## Суть

В настройках AI-провайдера (Workspace settings → AI) у каждого из трёх
эндпоинтов есть поле `PasswordInput` для API-ключа. Когда ключ уже сохранён на
сервере, поле показывает плейсхолдер `•••• set`, а справа — встроенный в
Mantine `PasswordInput` тогл видимости («глазок»). Под полем отдельной строкой
висит ссылка **Clear**.

Проблема: **«глазок» бессмысленен.** Поле ключа — write-only буфер: реальный
ключ в него никогда не загружается (сервер отдаёт только факт «ключ есть»,
`hasApiKey`, см. `ai-provider-settings.tsx:120-130, 154-177`). Когда ключ
сохранён, буфер пустой → нажатие «глазка» показывает пустоту. Полезного смысла
нет.

Хотим: **в состоянии «ключ сохранён» показывать кнопку Clear прямо на месте
«глазка» (в правой секции поля), а не отдельной ссылкой снизу.** Сделать это во
**всех трёх эндпоинтах** (Chat / LLM, Embeddings, Voice / STT).

## Где править (точные места)

Один файл:
[ai-provider-settings.tsx](apps/client/src/features/workspace/components/settings/components/ai-provider-settings.tsx)

Три одинаковых по структуре блока — `<Stack gap={4}>` с `PasswordInput` + ссылкой
`<Anchor>Clear</Anchor>` снизу:

1. **Chat / LLM** — строки ~433-445 (`apiKey`, `hasApiKey`, `handleClearKey`).
2. **Embeddings** — строки ~538-560 (`embeddingApiKey`, `hasEmbeddingApiKey`,
   `handleClearEmbeddingKey`).
3. **Voice / STT** — строки ~657-679 (`sttApiKey`, `hasSttApiKey`,
   `handleClearSttKey`).

Обработчики очистки (`handleClearKey` / `handleClearEmbeddingKey` /
`handleClearSttKey`, строки 239-255) и вся логика буферов/payload
(`buildPayload`, строки 179-222) — **остаются без изменений.** Меняется только
разметка трёх полей.

## Ключевой факт Mantine (подтверждён по докам)

У `PasswordInput`: **если передать свой `rightSection`, встроенный тогл
видимости («глазок») не рендерится** (Mantine docs, PasswordInput → «Usage
without visibility toggle»: *“When the `rightSection` prop is used, the
visibility toggle button is not rendered.”*).

То есть «поставить Clear на место глазка» = передать в `PasswordInput`
`rightSection` с кнопкой Clear. Отдельный костыль для скрытия глазка не нужен.

## Рекомендуемое поведение

Показывать Clear в правой секции **только когда ключ сохранён И буфер пуст**
(`hasApiKey && form.values.apiKey.length === 0`). Как только пользователь
начинает вводить НОВЫЙ ключ (буфер непустой) — возвращать дефолтный «глазок»:
вот тут он осмыслен (проверить, что набрал). После клика по Clear обработчик
ставит `hasApiKey=false` → `rightSection` снова `undefined` → поле становится
обычным пустым `PasswordInput` с глазком для ввода свежего ключа. Поведение
самосогласованное.

Альтернатива (проще, но грубее): показывать Clear всегда, пока `hasApiKey`
(без проверки буфера). Тогда при вводе нового поверх старого глазка не будет.
Допустимо, но теряем удобную проверку набранного. Рекомендуется вариант с
проверкой буфера.

## Эскиз правки (на примере Chat-поля; для двух других — аналогично)

Было:
```tsx
<Stack gap={4}>
  <PasswordInput
    label={t("API key")}
    placeholder={hasApiKey ? t("•••• set") : ""}
    autoComplete="off"
    {...form.getInputProps("apiKey")}
  />
  {hasApiKey && (
    <Anchor component="button" type="button" c="red" size="xs" onClick={handleClearKey}>
      {t("Clear")}
    </Anchor>
  )}
</Stack>
```

Стало:
```tsx
{/* The key field is write-only: the stored key never loads back, so the
    built-in visibility toggle reveals nothing. Replace it with a Clear action
    in the right section. Passing rightSection suppresses the eye (Mantine).
    While typing a new key (buffer non-empty) fall back to the default eye. */}
<PasswordInput
  label={t("API key")}
  placeholder={hasApiKey ? t("•••• set") : ""}
  autoComplete="off"
  rightSection={
    hasApiKey && form.values.apiKey.length === 0 ? (
      <Tooltip label={t("Clear")}>
        <ActionIcon
          variant="subtle"
          color="red"
          size="sm"
          aria-label={t("Clear")}
          onClick={handleClearKey}
        >
          <IconX size={16} />
        </ActionIcon>
      </Tooltip>
    ) : undefined
  }
  rightSectionPointerEvents="all"
  {...form.getInputProps("apiKey")}
/>
```

Изменения по каждому из трёх блоков:
- Убрать обёртку `<Stack gap={4}>…</Stack>` и ссылку `<Anchor>Clear</Anchor>`
  снизу (Clear переезжает внутрь поля). После удаления `Stack` второй ребёнок
  `<Group grow>` — сам `PasswordInput`; раскладка «Model | API key» в две
  колонки сохраняется.
- Подставить свои переменные/обработчики: эндпоинт 2 — `hasEmbeddingApiKey` /
  `embeddingApiKey` / `handleClearEmbeddingKey`; эндпоинт 3 — `hasSttApiKey` /
  `sttApiKey` / `handleClearSttKey`.

## Тонкости / на что смотреть

- **Импорты.** Добавить `ActionIcon`, `Tooltip` из `@mantine/core` и `IconX`
  из `@tabler/icons-react` (рядом с уже импортируемым `IconPencil`). После
  переезда Clear внутрь поля `Anchor` может стать неиспользуемым — проверить и
  убрать из импорта, иначе словим lint-ошибку `no-unused-vars`.
- **Кликабельность правой секции.** У `Input`/`PasswordInput` правая секция по
  умолчанию не всегда принимает клики — задать `rightSectionPointerEvents="all"`,
  чтобы клик по Clear срабатывал.
- **Тип кнопки.** `ActionIcon` рендерит `<button>` (по умолчанию `type="button"`).
  Формы как `<form onSubmit>` тут нет — Save висит на отдельной `type="button"`
  кнопке (строки 735-744), так что случайного сабмита не будет. Для надёжности
  можно явно проставить `type="button"`.
- **i18n.** Новый строковый ключ не нужен: `t("Clear")` уже используется
  (бывшая ссылка). Тултип и `aria-label` переиспользуют его. Плейсхолдер
  `•••• set` не трогаем.
- **Ширина правой секции.** Иконка X помещается в штатный размер секции (как и
  глазок). Если решат оставить именно слово «Clear» текстом вместо иконки —
  понадобится `rightSectionWidth`, иначе текст обрежется. Рекомендуется
  иконка + тултип (компактно, как глазок).
- **Доступность.** Обязателен `aria-label={t("Clear")}` на `ActionIcon` (иконка
  без видимого текста).

## Опционально (вне «трёх эндпоинтов»)

Тот же паттерн «бесполезный глазок + Clear снизу» есть в форме внешнего
MCP-сервера —
[ai-mcp-server-form.tsx](apps/client/src/features/workspace/components/settings/components/ai-mcp-server-form.tsx)
(поле Authorization-заголовков, `PasswordInput` строка ~193, плейсхолдер
`•••• set` строка ~196, `Anchor`-Clear строки ~207-209, обработчик
`handleClearHeaders`). В запросе он не входит в «три эндпоинта», но логически
страдает тем же. Можно причесать заодно для единообразия — отдельным мелким
шагом, по той же схеме.
