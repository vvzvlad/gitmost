# Стриминговая (по тишине) диктовка под фиче-тогглом, по умолчанию ВЫКЛ

Статус: **открыто.**

## Контекст

Стриминговая диктовка (нарезка по тишине через Silero VAD,
`@ricky0123/vad-web`) уже в `develop` и сейчас **жёстко включена**: `MicButton`
получает проп `streaming` литералом `true` в двух местах — редактор
([dictation-group.tsx](../../apps/client/src/features/editor/components/fixed-toolbar/groups/dictation-group.tsx))
и чат
([chat-input.tsx](../../apps/client/src/features/ai-chat/components/chat-input.tsx)).
Фича экспериментальная:

- тяжёлые ассеты (ONNX-модель + ORT-wasm, 13–26 МБ, грузятся в браузер при
  первом использовании);
- задержка инициализации модели на первом клике (компиляция wasm + подъём
  inference-сессии — повторяется на каждую загрузку страницы);
- много мелких запросов на `/ai-chat/transcribe` (по одному на сегмент речи)
  вместо одного на запись.

Её нужно сделать **opt-in на воркспейс, по умолчанию выключенной**, с обычной
батч-диктовкой как дефолтом и фолбэком.

## Цель

Спрятать стриминговый путь за булевым флагом воркспейса
`settings.ai.dictationStreaming` (default `false`). Выкл → текущая стабильная
батч-диктовка. Вкл → стриминговая.

**Минимализм (явно):** один булев флаг, переиспользуем существующую STT-модель
и эндпоинт `/ai-chat/transcribe`, **без новых полей провайдера / модели /
эндпоинта / секретов** — осознанное требование после претензий к realtime-PR
(#118) за лишние поля настроек.

## Дизайн

### Сервер

- В типе AI-настроек
  ([integrations/ai/ai.types.ts](../../apps/server/src/integrations/ai/ai.types.ts))
  и в
  [dto/update-ai-settings.dto.ts](../../apps/server/src/integrations/ai/dto/update-ai-settings.dto.ts)
  добавить `dictationStreaming?: boolean` рядом с уже существующим флагом
  `dictation`. Проверить, валидируется ли апдейт настроек по whitelist
  (`ai-settings.service.ts`) — если да, внести ключ; иначе passthrough.
- Это **только клиентский поведенческий флаг**: эндпоинт транскрипции и
  STT-модель не меняются (стриминг переиспользует `/ai-chat/transcribe`).
  Флаг просто отдаётся в составе `settings.ai`, который клиент уже читает.

### Клиент

- Тип
  [features/workspace/types/workspace.types.ts](../../apps/client/src/features/workspace/types/workspace.types.ts)
  (`settings.ai`, рядом с `dictation?: boolean`): добавить
  `dictationStreaming?: boolean`.
- UI
  [ai-provider-settings.tsx](../../apps/client/src/features/workspace/components/settings/components/ai-provider-settings.tsx):
  добавить Switch «Streaming dictation (cut on pauses)» **внутри/рядом** с
  тумблером «Voice dictation» — активен только когда `dictation` включена (это
  под-режим диктовки). Оптимистичный апдейт по образцу `dictation`
  (см. `handleDictationToggle` и запись `ai: { ...ai, dictation: value }`),
  пишет `settings.ai.dictationStreaming`. Default off. Новый i18n-ключ.
- Гейтинг: в `dictation-group.tsx` и `chat-input.tsx` заменить жёсткий
  `streaming` (литерал `true`) на `streaming={settings.ai.dictationStreaming === true}`.
  Проп `streaming` у `MicButton` уже выбирает хук (`useStreamingDictation` vs
  `useDictation`) — там менять ничего не нужно.

## Критерии приёмки

- Свежий воркспейс (флага нет) → mic-кнопка использует **батч**-диктовку;
  ассеты VAD (ONNX/wasm) **не грузятся** (ленивый `import()` в
  `useStreamingDictation.start()` срабатывает только при `streaming` и клике,
  которого при выкл не будет — оба хука инертны до `start()`).
- Тоггл вкл → стриминговая диктовка работает и в редакторе, и в чате.
- Тоггл выкл → возврат к батчу; стриминговые ассеты не подгружаются.
- Нет новых полей модели / эндпоинта / секрета — переиспользуется
  диктовочная STT-модель и `/ai-chat/transcribe`.
- Флаг персистится на воркспейс и гейтится как прочие `settings.ai.*`.

## Затрагиваемые файлы (указатели)

- **Сервер:** `integrations/ai/ai.types.ts`,
  `integrations/ai/dto/update-ai-settings.dto.ts`,
  `integrations/ai/ai-settings.service.ts` (если есть нормализация/whitelist).
- **Клиент:** `features/workspace/types/workspace.types.ts`,
  `features/workspace/components/settings/components/ai-provider-settings.tsx`
  (Switch + i18n), `features/editor/components/fixed-toolbar/groups/dictation-group.tsx`,
  `features/ai-chat/components/chat-input.tsx`.

## Заметки / краевые случаи

- Батч-диктовка остаётся дефолтом и фолбэком (в т.ч. если стриминговая
  инициализация падает).
- Подтвердить, что выкл-состояние не тянет ни одного VAD-байта: `MicButton`
  хоть и вызывает оба хука безусловно (правило хуков), оба инертны до
  `start()`, поэтому при `streaming=false` модель/wasm не запрашиваются.
- **Не** добавлять отдельные модель/эндпоинт под стриминг — переиспользовать
  диктовочные (явное требование после realtime-PR).

## Вне scope

- Preload / мгновенный старт и латентность инициализации модели — отдельный
  follow-up.
- Realtime-websocket путь (PR #118, [streaming-dictation-plan.md](../streaming-dictation-plan.md))
  — не мержится.
