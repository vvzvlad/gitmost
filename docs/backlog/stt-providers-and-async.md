# STT: дополнительные провайдеры и переход на асинхронную схему

> Статус: беклог / план развития. Контекст — фича «голосовая диктовка» (STT,
> speech-to-text): кнопка-микрофон в чате агента и в редакторе, аудио
> распознаётся на сервере через AI-провайдер воркспейса. Документ фиксирует
> (1) какие ещё форматы STT-API имеет смысл поддержать и как, и (2) как в
> будущем перейти с текущей синхронной схемы (push-to-talk) на асинхронную.

## 1. Где мы сейчас

Распознавание построено как **синхронный запрос-ответ**:

- Клиент пишет звук (`MediaRecorder`), POST-ит blob → сервер распознаёт →
  возвращает `{ text }`, который вставляется в ввод. Никакого состояния задачи нет.
- Клиентская часть: `apps/client/src/features/dictation/` (`hooks/use-dictation.ts`,
  `components/mic-button.tsx`, `services/dictation-service.ts`).
- Эндпоинт: `POST /ai-chat/transcribe`
  (`apps/server/src/core/ai-chat/ai-chat.controller.ts`) — фича-гейт
  `settings.ai.dictation`, throttle, лимит 25 МБ, whitelist mime, вывод реальной
  ошибки провайдера (`describeProviderError`), формат контейнера выводится из mime.
- Тонкая обёртка: `apps/server/src/core/ai-chat/ai-transcription.service.ts` →
  делегирует в `AiService.transcribe(workspaceId, audio, format)`.
- Выбор кодировки запроса — **явное** поле `sttApiStyle`
  (`apps/server/src/integrations/ai/ai.types.ts`, `SttApiStyle`,
  `STT_API_STYLES`):
  - `multipart` — OpenAI-совместимый `POST /v1/audio/transcriptions` (form-data)
    через AI SDK (`createOpenAI(...).transcription()` + `experimental_transcribe`);
  - `json` — OpenRouter-стиль: `POST {baseURL}/audio/transcriptions`,
    `Content-Type: application/json`, тело `{ model, input_audio: { data:<base64>, format } }`,
    ответ `{ text }` (`AiService.transcribeJsonBase64`).
- Поле прокладывается как любой не-секрет: `resolve()` / `getMasked()` /
  whitelist в `AiSettingsService.update`
  (`apps/server/src/integrations/ai/ai-settings.service.ts`) **и** массив
  `ALLOWED` в `WorkspaceRepo.updateAiProviderSettings`
  (`apps/server/src/database/repos/workspace/workspace.repo.ts`).
- UI: селектор «Request format» на карточке Voice / STT
  (`apps/client/.../settings/components/ai-provider-settings.tsx`) +
  кнопка «Test endpoint» (бэкенд-проба — тихий WAV через тот же `transcribe`).

**Важно:** `multipart` уже покрывает почти всю экосистему — её реализуют OpenAI,
Azure OpenAI (Whisper), Groq, Together, Fireworks, DeepInfra, vLLM, LM Studio,
whisper.cpp/llama.cpp server, `speaches`, `faster-whisper-server`, WhisperX.
Для них **новый формат не нужен**, достаточно base URL + модель + ключ.
`json` покрывает OpenRouter. Ось `sttApiStyle` — это абстракция над
*контрактом запроса/ответа*: каждый реально иной контракт = одно значение enum
+ одна ветка-энкодер.

### Точки расширения для нового СИНХРОННОГО формата (чек-лист)

1. `ai.types.ts` — добавить значение в `SttApiStyle` и `STT_API_STYLES`.
2. `dto/update-ai-settings.dto.ts` — `@IsIn(STT_API_STYLES)` подхватит автоматически.
3. `ai.service.ts` — ветка в `transcribe()` + приватный энкодер
   (по образцу `transcribeJsonBase64`): сборка запроса, заголовок авторизации,
   `!res.ok` → бросок со статусом+телом (без утечки ключа), парс ответа в `text`.
4. Клиент: `ai-settings-service.ts` (тип `SttApiStyle`), опция в `<Select>`
   на карточке Voice / STT, i18n-строки.
5. Проба «Test endpoint» работает автоматически (идёт через тот же `transcribe`).

## 2. Кандидаты на новые синхронные форматы

Ранжировано по польза/трудозатраты. Все — синхронные (request→response),
вписываются в текущую модель без переделки.

### 2.1. Deepgram — самый сильный кандидат
- `POST https://api.deepgram.com/v1/listen`, аудио **сырыми байтами в теле**
  (`Content-Type: audio/*`) или JSON `{ "url": ... }`; параметры (`model`,
  `language`, `smart_format`) — в query.
- Авторизация: заголовок `Authorization: Token <key>` (не `Bearer`).
- Ответ — свой JSON: `results.channels[0].alternatives[0].transcript`.
- Значение enum: `deepgram`. Энкодер шлёт байты + Token-заголовок и вынимает
  transcript из вложенной структуры.

### 2.2. Gemini (нативно) — переиспользует существующий драйвер
- У воркспейса уже может быть драйвер `gemini`. Транскрипция = `generateContent`
  с инлайн-аудио (`inlineData: { mimeType, data:<base64> }`) и промптом
  «transcribe verbatim».
- Плюс: один ключ на чат + STT. Минус: это LLM, а не STT-эндпоинт — латентность
  и качество отличаются, формат ответа надо чистить (модель может «болтать»).
- Значение enum: `gemini` (или ветка по `cfg.driver === 'gemini'`).

### 2.3. ElevenLabs Scribe — ниша, растёт
- `POST https://api.elevenlabs.io/v1/speech-to-text`, multipart, заголовок
  `xi-api-key: <key>` (не `Authorization`), поле `model_id`, свой ответ.
- Значение enum: `elevenlabs`.

### Groq — отдельный формат НЕ нужен
OpenAI-совместимый multipart. Работает уже сейчас: поставить base URL Groq и
модель `whisper-large-v3` при `sttApiStyle = multipart`.

## 3. Что НЕ влезает в синхронную модель (и почему)

Эти провайдеры **по своей природе асинхронные** (upload → poll/webhook) или
батч-ориентированные; их нельзя дождаться одним коротким HTTP-ответом, поэтому
они требуют именно асинхронной схемы из раздела 4 (а не ещё одного значения
`sttApiStyle`):

- **AssemblyAI** — upload → создать job → polling статуса / webhook.
- **AWS Transcribe** — job на основе S3, long-running.
- **Google Cloud Speech-to-Text** — `longrunningrecognize` (operation polling).
- **Azure Speech (batch transcription)** — job + polling.
- **Gladia, Speechmatics, Rev.ai** — job + polling/webhook.

Их подключение = новая фича с очередью и состоянием задачи, а не маленькая ветка.

## 4. Будущая асинхронная схема (целевая архитектура)

Зачем переходить (драйверы):
- **Длинная диктовка / батч**: запись > 25 МБ или длиннее пары минут не лезет
  в один синхронный запрос (см. лимит в контроллере) и держит HTTP-соединение.
- **Async-провайдеры** (раздел 3) вообще не поддаются синхронной модели.
- **Живая транскрипция** (промежуточный текст по мере речи) — отдельная, но
  смежная цель.
- Устойчивость: ретраи, наблюдаемость, разъединение клиента и провайдера.

### 4.1. Модель задачи (job-based)

Ввести сущность «задача транскрипции» и гонять её через очередь (у нас уже есть
BullMQ на Redis и `AI_QUEUE` — по образцу RAG-индексатора в
`apps/server/src/core/ai-chat/embedding/`):

1. Клиент загружает аудио → сервер кладёт его во временное хранилище
   (`StorageService`: local/S3/Azure) и создаёт запись задачи в новой таблице
   `transcription_jobs` (миграция только добавляет таблицу — см. правила в
   CLAUDE.md): `id, workspaceId, userId, status (queued|processing|done|error),
   provider/sttApiStyle, audioRef, resultText, errorText, createdAt, updatedAt`.
2. Сервер ставит job в очередь (новый `QueueJob.TRANSCRIBE` на `AI_QUEUE` или
   отдельная очередь) и сразу отвечает клиенту `{ jobId, status: 'queued' }`.
3. Консьюнер берёт job, читает аудио, вызывает провайдера:
   - **синхронные** провайдеры (multipart/json/deepgram/…) — просто выполняются
     внутри воркера и завершают job (тот же код `AiService.transcribe`, но без
     HTTP-таймаута запроса клиента);
   - **асинхронные** провайдеры (AssemblyAI и т.п.) — воркер сабмитит job
     провайдеру и либо поллит статус, либо ждёт webhook (нужен публичный
     callback-эндпоинт), затем дописывает результат.
4. Результат сохраняется в задачу; аудио **сразу удаляется** (или по TTL).

Главная мысль: **единая job-модель поглощает и sync-, и async-провайдеров** —
для синхронных воркер завершает задачу за один проход, для асинхронных ведёт её
до готовности. `sttApiStyle` остаётся осью выбора энкодера.

### 4.2. Доставка результата клиенту

Варианты (от простого к «живому»):
- **Polling**: клиент дёргает `POST /ai-chat/transcribe/status { jobId }` каждые
  N секунд до `done|error`. Просто, надёжно, первый шаг.
- **SSE / WebSocket push**: переиспользовать существующую Socket.IO/Redis-инфру
  (как у коллаборации) и слать обновление статуса в сессию пользователя.
- **Live-стриминг** (отдельная фаза): WebSocket-мост к realtime-API провайдера
  (Deepgram streaming, OpenAI Realtime) с промежуточным текстом. Это уже не
  job-модель, а постоянное соединение; держать как самостоятельный режим.

### 4.3. Путь миграции (без слома текущего UX)

- Сохранить нынешний синхронный `POST /ai-chat/transcribe` для **коротких**
  клипов (push-to-talk остаётся мгновенным) — это «быстрый путь».
- Добавить job-путь для **длинных/батч** записей и для async-провайдеров.
- Клиентский хук `use-dictation` получает развилку: короткая запись → sync,
  длинная (по длительности/размеру) → job + статус. UI: индикатор
  «распознаётся…» уже есть (`transcribing`), добавить состояние «в очереди».
- `sttApiStyle` расширяется теми же шагами из раздела 1; async-провайдеры
  добавляются только в job-путь.

### 4.4. На что обратить внимание при реализации

- **Хранение аудио**: временное, с обязательной очисткой (TTL/после job).
  Не логировать аудио и ключи (см. правило об ошибках в CLAUDE.md).
- **Безопасность**: job скоупится воркспейсом и пользователем (CASL), статус
  доступен только владельцу job; webhook-эндпоинт для async — с проверкой
  подписи/секрета и через `ssrf-guard`, если зовём наружу.
- **Лимиты/квоты**: throttle на постановку задач; ограничение длины/размера;
  бюджет на параллельные job.
- **Ошибки**: каждая неудача job пишет полную причину в лог и в `errorText`,
  пользователю показывается конкретное объяснение (а не «не получилось»).
- **Идемпотентность/ретраи**: BullMQ `jobId`, removeOnComplete/Fail, дедуп
  повторных постановок (как в RAG-реиндексе).
- **Миграции**: новая таблица только добавляется; следить за порядком
  таймстампов при мёрдже веток (см. CLAUDE.md → «Migration ordering»).

## 5. Рекомендация (приоритеты)

1. Оставить текущие `multipart` + `json` — этого хватает большинству, включая
   self-hosted.
2. Если нужен облачный не-OpenAI вариант — добавить **Deepgram** (синхронно,
   маленькая ветка).
3. **Gemini-нативный** — дёшево, раз драйвер `gemini` уже есть.
4. Async-схему (раздел 4) делать, когда появится реальная потребность в длинной
   диктовке / батче / async-провайдерах; начинать с job-модели + polling, затем
   push, и только потом live-стриминг.

> Перед реализацией любого провайдера — сверить актуальную форму запроса/ответа
> по его документации (API дрейфуют), затем добавить значение `sttApiStyle` +
> энкодер по чек-листу из раздела 1.
