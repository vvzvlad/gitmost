# Потоковая диктовка (realtime STT) — дизайн

> Статус: **черновик / дизайн**. Реализация ещё не начата.
> Исходный кейс: при диктовке текст должен появляться **по мере речи**, а не одним
> куском после остановки записи.
>
> Принятые на старте предпосылки (требуют подтверждения, см. §3 «Развилки»):
> - **Семантика** — настоящий realtime: аудио стримится во время речи, частичные
>   расшифровки (`delta`) дописываются в редактор немедленно (~150–300 мс до
>   первого частичного текста на проводном соединении).
> - **Провайдер** — OpenAI Realtime API (или совместимый: Azure OpenAI). Это
>   ломает текущую провайдер-агностичность диктовки (см. §2) — realtime становится
>   **опциональной** возможностью поверх существующей пакетной диктовки, а не
>   заменой ей.

---

## 1. Что есть сейчас (пакетная диктовка)

Текущая диктовка — строго «запиши целиком → отправь → получи весь текст», без
какого-либо стрима:

**Клиент.**
- [use-dictation.ts](../apps/client/src/features/dictation/hooks/use-dictation.ts) —
  стейт-машина захвата на `MediaRecorder`. Чанки копятся в `chunksRef` в
  `recorder.ondataavailable`, но **никуда не уходят по ходу записи**; единый `Blob`
  собирается только в `recorder.onstop` и одним `multipart`-POST отправляется на
  транскрипцию. Кодек — сжатый `audio/webm;codecs=opus` (Safari: `audio/mp4`).
- [dictation-service.ts](../apps/client/src/features/dictation/services/dictation-service.ts) —
  `transcribeAudio(blob, filename)` → `POST /ai-chat/transcribe`.
- [mic-button.tsx](../apps/client/src/features/dictation/components/mic-button.tsx) —
  кнопка с состояниями `idle → recording → transcribing → idle`.
- [dictation-group.tsx](../apps/client/src/features/editor/components/fixed-toolbar/groups/dictation-group.tsx) —
  снапшотит каретку в `onStart`, вставляет **готовый** текст в зафиксированную
  позицию, клампит её под текущий размер документа (учёт коллаб-дрейфа).
- В чате — тот же `MicButton` в [chat-input.tsx](../apps/client/src/features/ai-chat/components/chat-input.tsx),
  текст дописывается в черновик сообщения.

**Сервер.**
- Эндпоинт `POST /ai-chat/transcribe` в
  [ai-chat.controller.ts](../apps/server/src/core/ai-chat/ai-chat.controller.ts#L195-L281):
  гейт `settings.ai.dictation === true` (иначе 403), приём файла до 25 МБ,
  whitelist MIME, троттлинг 20 req/min на пользователя, маппинг MIME→`format`,
  вызов `AiTranscriptionService.transcribe()`.
- [ai-transcription.service.ts](../apps/server/src/core/ai-chat/ai-transcription.service.ts) —
  тонкая обёртка над `AiService.transcribe()`.
- [ai.service.ts](../apps/server/src/integrations/ai/ai.service.ts#L120-L187) —
  два пути по `sttApiStyle`: `multipart` (AI SDK `experimental_transcribe`,
  OpenAI/speaches/faster-whisper/Ollama) и `json` (base64 на
  `{baseURL}/audio/transcriptions`, OpenRouter). Оба возвращают **весь текст за
  один вызов**, без SSE/WS.
- Конфиг STT — per-workspace в `settings.ai.provider` (`sttModel`, `sttBaseUrl`,
  `sttApiStyle`), ключ зашифрован в `ai_provider_credentials`, расшифровывается
  только в [ai-settings.service.ts](../apps/server/src/integrations/ai/ai-settings.service.ts#L113-L157)
  (`resolve`) и **никогда не логируется и не уходит клиенту** (только маска
  `hasSttApiKey`).

**Вывод.** «По мере речи» в текущей архитектуре невозможно в принципе: текст
рисуется одним куском в `onstop`. Нужен принципиально другой транспорт.

---

## 2. Главное архитектурное противоречие

Пакетная диктовка **провайдер-агностична**: работает с любым OpenAI-совместимым
`/audio/transcriptions` (включая self-hosted speaches/faster-whisper и Ollama)
просто через `sttBaseUrl` + `sttApiStyle`.

Realtime STT — **не** часть OpenAI-совместимого REST. Это отдельный протокол
(WebSocket/WebRTC + событийная модель), который реализуют единицы провайдеров:
OpenAI Realtime, Azure OpenAI Realtime, и (с другим набором событий) пара сторонних
вроде Together AI. Self-hosted whisper-серверы его, как правило, **не умеют**.

Поэтому realtime нельзя «просто включить» вместо пакетной диктовки. Дизайн исходит
из того, что:

1. Пакетная диктовка (§1) **остаётся** как дефолт и фоллбэк.
2. Realtime — **опциональная** возможность, доступная только когда workspace
   настроен на realtime-совместимый провайдер (новый флаг/поле конфига, см. §5).
3. Если realtime не настроен или соединение не поднялось — UI прозрачно
   деградирует к пакетному пути.

---

## 3. Контракт провайдера (OpenAI Realtime, transcription session)

Сверено с актуальной документацией (ссылки в конце). Ключевые факты:

**Создание сессии и эфемерный токен.**
- REST `POST /v1/realtime/transcription_sessions` (в GA-вариантах —
  `POST /v1/realtime/client_secrets` с телом-конфигом сессии) возвращает
  `client_secret.value` — **эфемерный** токен с коротким TTL для браузера.
  Постоянный ключ воркспейса при этом наружу не отдаётся.
  > На момент реализации сверить точный эндпоинт и форму тела с текущими доками —
  > API эволюционирует.

**Транспорт.**
- **WebRTC** — рекомендуется для браузерного аудио (захват + воспроизведение).
- **WebSocket** — для серверных аудио-пайплайнов:
  `wss://api.openai.com/v1/realtime?intent=transcription`, заголовки
  `Authorization: Bearer <key>` и `OpenAI-Beta: realtime=v1`.

**Формат входного аудио.** `pcm16` (raw 16-bit PCM, mono), частота 16 кГц или
24 кГц; либо `g711`. **Не** webm/opus и **не** mp4 — то есть текущий
`MediaRecorder`-путь для realtime неприменим (см. §6, AudioWorklet).

**События клиент→сервер.**
- `transcription_session.update` (или `session.update`) — конфиг модели/VAD/языка.
- `input_audio_buffer.append` — чанк аудио (base64 PCM16).
- `input_audio_buffer.commit` — закрыть сегмент вручную (когда VAD выключен).

**События сервер→клиент.**
- `conversation.item.input_audio_transcription.delta` — поле `delta` с
  инкрементальным текстом (частичная расшифровка).
- `conversation.item.input_audio_transcription.completed` — поле `transcript` с
  финальным текстом сегмента. У обоих есть `item_id` для сопоставления сегментов.
- `error` — ошибки сессии.

**Turn detection / VAD.** `turn_detection: { type: "server_vad" }` —
сервер сам нарезает речь на сегменты и эмитит `completed` на границе паузы; для
непрерывной диктовки это удобнее ручного commit. Модели: `gpt-4o-transcribe`,
`gpt-4o-mini-transcribe`, потоковая `gpt-realtime-whisper` (у неё настраиваемая
задержка `delay`: `minimal…xhigh` — баланс «латентность ↔ качество»).

> Важно: `delta`-события дают **черновой** текст, который последующие события
> могут **переписать**. UI должен уметь заменять ранее показанный частичный текст
> (см. §3 «Развилка B» про вставку в редактор).

---

## 4. Развилка A — транспорт: прямое WebRTC vs серверный WS-прокси

### Вариант A1 — браузер ↔ OpenAI напрямую (WebRTC, эфемерный токен)
Наш сервер только минтит эфемерный токен (`/realtime/transcription_sessions`
постоянным ключом воркспейса), браузер сам устанавливает WebRTC к OpenAI и
получает `delta`/`completed`.

- **Плюсы:** минимальная латентность (нет лишнего хопа), аудио не идёт через наш
  сервер (нет нагрузки на bandwidth), меньше серверного кода.
- **Минусы:**
  - Работает **только** с настоящим OpenAI/Azure (нужна поддержка эфемерных
    токенов и WebRTC) — `sttBaseUrl` на self-hosted/прокси-шлюз тут бесполезен.
  - Браузер устанавливает соединение с внешним хостом напрямую — мимо нашего
    [ssrf-guard](../apps/server/src/core/ai-chat/external-mcp/ssrf-guard.ts) и
    серверного троттлинга/гейтинга на уровне каждого сообщения (гейт можно
    проверить только в момент минтинга токена).
  - Эфемерный токен живёт в браузере (короткий TTL смягчает, но это всё же
    выдача наружу производного секрета).
  - WebRTC в браузере (`RTCPeerConnection`, SDP-оффер, обмен через REST) — больше
    клиентской машинерии и краевых случаев.

### Вариант A2 (рекомендуется) — браузер ↔ наш сервер (WS) ↔ OpenAI (WS)
Браузер шлёт PCM16-чанки по WebSocket на наш новый gateway; сервер держит upstream
WS к `wss://api.openai.com/v1/realtime?intent=transcription` с **постоянным**
ключом воркспейса и проксирует `delta`/`completed` обратно браузеру.

- **Плюсы:**
  - Ключ **никогда не покидает сервер** — ровно как в текущем коде
    ([ai-settings.service.ts](../apps/server/src/integrations/ai/ai-settings.service.ts#L138-L154)),
    эфемерные токены не нужны.
  - Работает с **любым** realtime-совместимым эндпоинтом через `sttBaseUrl`
    (OpenAI, Azure, будущий self-hosted), и upstream-URL проходит через
    SSRF-валидацию перед коннектом.
  - Гейт `settings.ai.dictation`, аутентификация (JWT воркспейса), троттлинг и
    лимиты длительности/объёма применяются **на сервере** на каждом соединении.
  - Совместимо с тем, что в проекте **уже есть WebSocket-инфраструктура** —
    коллаб-сервер на Hocuspocus + Socket.IO-адаптер на Redis
    ([collaboration/](../apps/server/src/collaboration/)), и Fastify-приложение.
- **Минусы:**
  - Аудио идёт через наш сервер (≈ десятки кбит/с на сессию для PCM16@24k ⇒
    ~48 КБ/с; терпимо, но это нагрузка и нужно ограничивать конкуррентность).
  - Двойной хоп добавляет немного латентности (доли сотни мс).
  - Нужен новый WS-gateway и аккуратный proxy-стейт (бэкпрешер, очистка сокетов).

**Решение (предлагается): A2.** Он единственный согласуется с инвариантами
кодовой базы — «ключ только на сервере», провайдер-агностичность через `baseURL`,
SSRF-guard, серверные гейты и троттлинг. A1 оставить как возможную оптимизацию
латентности «потом», если упрёмся в bandwidth.

Дальнейший дизайн исходит из **A2**.

---

## 5. Развилка B — куда писать частичный текст в редакторе

`delta` — черновой текст, который может быть переписан. Слепо вставлять каждую
`delta` в документ Tiptap нельзя: (1) каждая правка документа порождает Yjs-апдейт,
шумит в истории/коллабе и тяжела; (2) переписывание ранее показанного текста
превращается в постоянные replace по диапазону.

### Вариант B1 — провизорная вставка в документ + замена диапазона
Вставляем `delta` прямо в документ, запоминаем диапазон провизорного текста,
на каждую новую `delta`/`completed` заменяем этот диапазон. На `completed` —
«фиксируем» (диапазон становится обычным текстом).

- **Плюсы:** текст сразу «настоящий», работает для любого приёмника (редактор и
  чат единообразно), не нужен слой декораций.
- **Минусы:** активный коллаб + история засоряются промежуточными апдейтами;
  замена диапазона воюет с коллаб-дрейфом (диапазон надо ремапить, как уже делает
  [dictation-group.tsx](../apps/client/src/features/editor/components/fixed-toolbar/groups/dictation-group.tsx#L24-L26));
  откат при отмене сложнее.

### Вариант B2 (рекомендуется для редактора) — ProseMirror-декорация для interim, коммит только финала
Частичный текст показываем виджет-декорацией (inline widget) у каретки — он **не
часть документа**, не порождает Yjs-апдейтов и не попадает в историю. В документ
коммитим только текст из `completed`-сегмента (как сейчас — `insertContentAt` в
снапшот каретки, с тем же клампом под коллаб-дрейф).

- **Плюсы:** ноль мусора в коллабе/истории до финала; отмена = просто снять
  декорацию; финальная вставка переиспользует уже существующую и проверенную
  логику `dictation-group`.
- **Минусы:** нужна небольшая ProseMirror-плагин-декорация (новый код); «по мере
  речи» виден interim как подсветка-призрак, а в документ «оседает» по сегментам
  (на паузах VAD) — на практике это естественный UX (как у системных диктовок).

### Для чата
В [chat-input.tsx](../apps/client/src/features/ai-chat/components/chat-input.tsx)
приёмник — обычный `textarea`/draft, декораций нет. Там проще **B1-подобно**:
показывать `interim` как «хвост» черновика (например, отдельным стейтом, который
рендерится приглушённо), а на `completed` дописывать в основной черновик. То есть
интерфейс хука должен отдавать и `interim`, и `final` (см. §6).

**Решение (предлагается):** редактор — **B2** (декорация + коммит финала), чат —
показ interim-хвоста + коммит финала. Единый хук realtime отдаёт оба потока,
а приёмник сам решает, как показывать interim.

---

## 6. Детальный дизайн (A2 + B2)

### 6.1 Клиент: захват аудио (PCM16 через Web Audio API)
`MediaRecorder` отдаёт сжатый webm/opus — для realtime **не подходит**. Нужен
сырой PCM16:

1. `getUserMedia({ audio: true })` (как сейчас).
2. `AudioContext` + `AudioWorkletNode` (новый worklet-процессор): забирает
   Float32-фреймы, ресемплит к 24 кГц mono, конвертит в Int16, шлёт в основной
   поток.
3. Чанки PCM16 → base64 → событие `input_audio_buffer.append` на наш WS-gateway
   (батчинг ~каждые 100–250 мс, чтобы не спамить сообщениями).
4. На стоп — закрыть worklet, остановить треки (как в текущем `stopTracks`),
   дослать остаток.

Новый код, в идеале — отдельный хук `use-realtime-dictation.ts` рядом с
[use-dictation.ts](../apps/client/src/features/dictation/hooks/use-dictation.ts),
с тем же «фасадом» (`status/start/stop/cancel`) **плюс** колбэки `onInterim(text)`
и `onFinal(text)`. `MicButton` выбирает реализацию (realtime vs batch) по флагу из
конфига воркспейса; вся остальная обвязка (тултипы, состояния, обработка ошибок,
гард двойного клика, очистка на unmount) переиспользуется один-в-один.

> AudioWorklet требует безопасного контекста (HTTPS/localhost) — то же ограничение,
> что уже есть у `getUserMedia` в текущем хуке. Нужен бандл worklet-файла через
> Vite (`?url`/`?worker`); сверить с тем, как проект собирает воркеры.

### 6.2 Сервер: WS-gateway + realtime-прокси
Новый модуль внутри `core/ai-chat` (рядом с `ai-transcription.service.ts`):

- **WS endpoint** (например, `ws://…/ai-chat/realtime-transcribe`). Поднять либо
  как Nest WebSocketGateway, либо как Fastify-WS-роут — выбрать по тому, что уже
  используется в проекте (Socket.IO-адаптер на Redis в
  [collaboration/](../apps/server/src/collaboration/)). На коннекте:
  - аутентификация JWT воркспейса (как у остальных `/ai-chat` маршрутов);
  - гейт `settings.ai.dictation === true` (иначе закрыть с понятным кодом/причиной);
  - троттлинг/лимит одновременных realtime-сессий на пользователя и на воркспейс
    (realtime дороже пакетной диктовки — нужен явный потолок).
- **Резолв конфига** через `AiSettingsService.resolve(workspaceId)`: нужны
  `sttModel`, `sttBaseUrl||baseUrl`, `sttApiKey`. **До** коннекта прогнать
  upstream-URL через [ssrf-guard](../apps/server/src/core/ai-chat/external-mcp/ssrf-guard.ts).
- **Upstream WS** к `wss://<base>/realtime?intent=transcription` (npm `ws`),
  заголовки `Authorization: Bearer <sttApiKey>` + `OpenAI-Beta: realtime=v1`.
  Сразу отправить `transcription_session.update` с моделью/языком/`server_vad`.
- **Прокси:** PCM16 от браузера → `input_audio_buffer.append` в upstream;
  `…transcription.delta` / `…completed` / `error` из upstream → клиенту
  (можно прозрачно ретранслировать, либо нормализовать в свой минимальный формат
  `{type:'interim'|'final'|'error', text, itemId}` — предпочтительно
  нормализовать, чтобы не привязывать клиент к сырой схеме OpenAI и упростить
  будущую поддержку Azure/иных).
- **Очистка:** при закрытии любого из двух сокетов — закрыть второй, освободить
  ресурсы; таймаут простоя; лимит длительности сессии (аналог 120 с в текущем
  хуке) и лимит суммарного объёма аудио.

Расширить `AiService` (или новый `AiRealtimeService`) методом, инкапсулирующим
upstream-WS, чтобы контроллер/gateway оставался тонким — симметрично текущему
`transcribe()`.

### 6.3 Конфиг воркспейса
Добавить в [ai.types.ts](../apps/server/src/integrations/ai/ai.types.ts) и в
[ai-settings.service.ts](../apps/server/src/integrations/ai/ai-settings.service.ts):
- `sttRealtime?: boolean` — включает realtime-путь для воркспейса.
- `sttRealtimeModel?: string` — модель realtime (например `gpt-4o-mini-transcribe`
  / `gpt-realtime-whisper`); если пусто — фоллбэк на `sttModel`.
- (опц.) `sttRealtimeBaseUrl?` — если realtime-эндпоинт отличается от `sttBaseUrl`.

Ключ переиспользуется (`sttApiKey` → fallback `apiKey`), новых секретов не нужно.
В `getMasked` отдавать новые **несекретные** поля; в `resolve` — как сейчас.
UI настроек (Workspace settings → AI) — добавить тумблер «Realtime dictation» и
поле модели рядом с существующими STT-полями; кнопка «Test endpoint» для realtime
делает короткий тестовый коннект (открыть сессию, послать ~0.5 с тишины, дождаться
`session.created`/`error`, закрыть) и возвращает `ok|error` через
`describeProviderError`-подобную нормализацию.

### 6.4 Клиентский конфиг-гейт
Realtime-кнопку показывать только если `workspace.settings.ai.dictation === true`
**и** `…ai.provider.sttRealtime === true`. Иначе — текущая пакетная кнопка. Маска
настроек должна отдавать эти флаги клиенту (несекретные).

---

## 7. Безопасность и соответствие конвенциям

- **Ключ только на сервере** (вариант A2): постоянный ключ не уходит клиенту,
  эфемерные токены не используются — инвариант
  [§8 ai-settings](../apps/server/src/integrations/ai/ai-settings.service.ts#L38-L45)
  сохранён. Ключ не логируется.
- **SSRF:** upstream realtime-URL валидируется через
  [ssrf-guard.ts](../apps/server/src/core/ai-chat/external-mcp/ssrf-guard.ts)
  перед коннектом (особенно если разрешаем кастомный `sttRealtimeBaseUrl`).
- **Гейт/авторизация/троттлинг** — на сервере, на каждом WS-коннекте; плюс жёсткий
  лимит одновременных realtime-сессий (это дорого) и лимит длительности.
- **Обработка ошибок (конвенция проекта).** Любая ошибка (upstream `error`,
  разрыв сокета, провайдер-таймаут, не настроен realtime, отказ микрофона):
  - на сервере — лог полностью (имя/сообщение/стек/`cause`, статус upstream) и
    отдача клиенту **конкретной** причины (не «Something went wrong»), через
    нормализатор уровня `describeProviderError`;
  - на клиенте — `console.error(<context>, err)` + нотификация с реальной причиной
    (как уже сделано в
    [use-dictation.ts](../apps/client/src/features/dictation/hooks/use-dictation.ts#L187-L213)).
- **Деградация:** realtime недоступен/упал на старте → молча используем пакетную
  диктовку (она всегда есть); realtime упал в середине → коммитим уже полученные
  `completed`-сегменты, показываем причину, предлагаем продолжить пакетно.

---

## 8. Краевые случаи

- **Коллаб-дрейф:** между `start` и каждым `completed` документ мог измениться —
  ремап/кламп позиции вставки (логика уже есть в `dictation-group`); для interim
  декорация привязывается к текущей каретке, не к абсолютной позиции.
- **Отмена записи:** снять декорацию, ничего не коммитить, закрыть оба сокета.
- **Тишина/нет речи:** VAD не эмитит сегментов — корректно завершить без вставки.
- **Длинная диктовка:** server_vad нарезает на сегменты автоматически; следить за
  лимитом длительности и объёма.
- **Переписывание interim:** поздние `delta` правят ранние — UI всегда показывает
  последнюю версию текущего (ещё не `completed`) сегмента.
- **Языки/пунктуация:** прокидывать `language` в конфиг сессии (или авто);
  модель сама расставляет пунктуацию.
- **Несколько вкладок / двойной старт:** гард как в текущем хуке + серверный лимит
  сессий.
- **Старые браузеры без AudioWorklet:** фоллбэк на пакетную диктовку.

---

## 9. Поэтапный план реализации

1. **Конфиг и гейт.** `ai.types.ts` + `ai-settings.service.ts` (`sttRealtime`,
   `sttRealtimeModel`), маска, UI-тумблер и «Test endpoint». Без транспорта —
   просто читается/пишется.
2. **Серверный realtime-прокси.** WS-gateway + `AiRealtimeService` (upstream WS к
   OpenAI, SSRF, гейт, троттлинг, нормализация событий, очистка). Покрыть
   юнит/моками парс событий и закрытие сокетов.
3. **Клиентский захват PCM16.** AudioWorklet-процессор + `use-realtime-dictation`
   (фасад `status/start/stop/cancel` + `onInterim/onFinal`), подключение к WS.
4. **UI interim.** B2-декорация в редакторе + коммит финала через существующую
   `dictation-group`-логику; в чате — interim-хвост + коммит. Переключение
   realtime/batch в `MicButton` по флагу конфига.
5. **Закалка.** Лимиты, таймауты, фоллбэки, нотификации с реальными причинами,
   нагрузочная проверка одновременных сессий.

---

## 10. Открытые вопросы / риски

- **Подтвердить семантику** (предпосылки в шапке): нужен именно realtime «по мере
  речи» (A2/B2), а не просто «прогрессивный вывод после стопа» (`stream:true` на
  `gpt-4o-transcribe` — гораздо дешевле и проще, но текст идёт только **после**
  остановки записи).
- **Точная форма Realtime API** (эндпоинт сессии, имена событий, формат аудио)
  меняется — сверить с актуальными доками на момент реализации.
- **Стоимость/латентность** realtime заметно выше пакетной диктовки — нужен явный
  потолок одновременных сессий и, возможно, явное предупреждение админу.
- **Нагрузка на наш сервер** (аудио через прокси) — измерить на реальной
  конкуррентности; при необходимости позднее добавить путь A1 (WebRTC напрямую).
- **AudioWorklet-бандлинг** под Vite — проверить, как проект собирает воркеры.
- Совместимость с Azure OpenAI Realtime (другой хост/версия API) — учесть в
  нормализации событий, чтобы клиент не зависел от сырой схемы.

---

## 11. Ориентир по затрагиваемым файлам

Новые:
- `apps/client/src/features/dictation/hooks/use-realtime-dictation.ts`
- `apps/client/src/features/dictation/audio/pcm16-worklet.*` (worklet + загрузчик)
- `apps/client/src/features/editor/.../dictation-interim-decoration.*` (ProseMirror-плагин)
- `apps/server/src/core/ai-chat/ai-realtime.service.ts` (+ WS-gateway)

Изменяемые:
- [ai.types.ts](../apps/server/src/integrations/ai/ai.types.ts),
  [ai-settings.service.ts](../apps/server/src/integrations/ai/ai-settings.service.ts) —
  новые поля конфига + маска.
- [ai.service.ts](../apps/server/src/integrations/ai/ai.service.ts) — realtime
  test-connection (если делать через AiService).
- [mic-button.tsx](../apps/client/src/features/dictation/components/mic-button.tsx) —
  выбор realtime/batch по флагу.
- [dictation-group.tsx](../apps/client/src/features/editor/components/fixed-toolbar/groups/dictation-group.tsx),
  [chat-input.tsx](../apps/client/src/features/ai-chat/components/chat-input.tsx) —
  обработка `onInterim/onFinal`.
- Настройки AI в клиенте (Workspace settings → AI) — тумблер + модель + тест.
- AI-модуль сервера ([app.module.ts](../apps/server/src/app.module.ts) /
  `ai-chat`-модуль) — регистрация gateway.

---

## Источники

- [Realtime transcription — OpenAI API](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [Create transcription session — OpenAI API Reference](https://developers.openai.com/api/reference/resources/realtime/subresources/transcription_sessions/methods/create)
- [Speech to text — OpenAI API](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Realtime and audio — OpenAI API](https://developers.openai.com/api/docs/guides/realtime)
</content>
</invoke>
