# Голосовая диктовка в gitmost — проект и план реализации

> Статус: проектный документ, готов к реализации.
> Контекст: gitmost — форк Docmost. В бэкенде уже есть подсистема AI-провайдера
> (per-workspace конфиг с шифрованными ключами) и фича «чат с AI-агентом».
> Цель — добавить голосовой ввод: кнопка-микрофон в чате агента и в редакторе
> страниц; записанное аудио распознаётся **на сервере** через выбранный воркспейсом
> AI-провайдер (Whisper / gpt-4o-transcribe / self-hosted OpenAI-совместимый STT),
> текст вставляется как обычный ввод.

---

## 1. Обзор и принятые решения

Задача распадается на **две оси**, которые проектируются независимо:

- **Куда** ставим микрофон — в чат агента **и** в редактор страниц (оба места).
- **Чем** распознаём — **серверный Whisper через существующий AI-провайдер**
  (а не браузерный Web Speech API и не локальный whisper в браузере).

Почему серверный STT через AI-провайдер:
- Точно ложится на существующую подсистему: модель строится из per-workspace
  конфига с шифрованными ключами — по тому же шаблону, что `getEmbeddingModel`.
- `baseUrl` у драйвера `openai` уже поддерживает OpenAI-совместимые эндпоинты →
  можно подключить self-hosted whisper (`speaches` / `faster-whisper-server` /
  `whisper.cpp`) и не выпускать аудио из контура.
- Работает во всех браузерах (включая Firefox), ключ не утекает на клиент.

Технический факт (проверено по установленным пакетам): `ai@6` экспортирует
`experimental_transcribe`, а `@ai-sdk/openai` даёт
`.transcription('whisper-1' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe')`.
Нативную `TranscriptionModel` в AI SDK даёт только OpenAI-совместимый драйвер;
`gemini`/`ollama` нативного STT не имеют (см. «Подводные камни»).

Фича состоит из **четырёх частей**, которые можно катить по очереди:

1. **Креды STT** — интерфейс к настройкам Whisper с паритетом LLM/эмбеддингов.
2. **Построитель модели + эндпоинт** — `getTranscriptionModel` и `/transcribe`.
3. **Переключатель видимости** — фича-флаг `ai.dictation` (кнопка в чате и страницах).
4. **Клиентский захват + кнопка** — `MediaRecorder`, хук `useDictation`, `MicButton`.

---

## 2. Часть 1 — Креды STT (паритет с LLM и эмбеддингами)

Сейчас у провайдера ровно два независимых набора параметров. STT добавляется третьим
по той же схеме:

| | модель (не-секрет) | base URL (не-секрет) | API-ключ (секрет) |
|---|---|---|---|
| Чат | `chatModel` | `baseUrl` | `apiKeyEnc` |
| Эмбеддинги | `embeddingModel` | `embeddingBaseUrl` → fallback на `baseUrl` | `embeddingApiKeyEnc` → fallback на `apiKeyEnc` |
| **STT** | **`sttModel`** | **`sttBaseUrl`** → fallback на `baseUrl` | **`sttApiKeyEnc`** → fallback на `apiKeyEnc` |

Принцип хранения (наследуем без изменений):
- **Не-секреты** (`*Model`, `*BaseUrl`) — в `workspaces.settings.ai.provider` (JSON).
- **Секрет** (ключ) — только в таблице `ai_provider_credentials`, зашифрованным,
  отдельной колонкой на каждое назначение.
- Наружу ключ не возвращается — только булев `hasXxxApiKey`.
- Пустые STT-ключ/URL падают на чат-значения (как у эмбеддингов).

### 2.1. Миграция БД
Новая миграция по образцу `20260618T120000-ai-embedding-credentials.ts`:

```ts
// 20260618T130000-ai-stt-credentials.ts
// Encrypted, STT-specific provider key. Separate from api_key_enc (chat key) so the
// transcription model can use a different token. NULL -> falls back to api_key_enc.
up:   alterTable('ai_provider_credentials').addColumn('stt_api_key_enc', 'text')
down: alterTable('ai_provider_credentials').dropColumn('stt_api_key_enc')
```

### 2.2. Тип таблицы
`apps/server/src/database/types/ai-provider-credentials.types.ts`, рядом с `embeddingApiKeyEnc`:

```ts
// Encrypted, STT-specific provider key. Falls back to apiKeyEnc when null.
sttApiKeyEnc: string | null;
```
(`Insertable/Updatable/Selectable` и `find().selectAll()` подхватят колонку сами.)

### 2.3. Репозиторий кредов
`apps/server/src/database/repos/ai-chat/ai-provider-credentials.repo.ts` — добавить
два метода-близнеца к `upsertEmbeddingKey`/`clearEmbeddingKey`:
- `upsertSttKey(workspaceId, driver, sttApiKeyEnc, trx?)` — `onConflict` трогает только
  `sttApiKeyEnc` + `updatedAt`, чат/эмбеддинг-ключи не затрагиваются.
- `clearSttKey(workspaceId, driver, trx?)` — `set({ sttApiKeyEnc: null })`.

### 2.4. Серверные типы
`apps/server/src/integrations/ai/ai.types.ts`:
- `AiProviderSettings`: `+ sttModel?`, `+ sttBaseUrl?`.
- `ResolvedAiConfig`: `+ sttApiKey?` (`sttModel`/`sttBaseUrl` приходят через `extends Partial<AiProviderSettings>`).
- `MaskedAiSettings`: `+ sttModel?`, `+ sttBaseUrl?`, `+ hasSttApiKey: boolean`.

### 2.5. DTO
`apps/server/src/integrations/ai/dto/update-ai-settings.dto.ts`: `+ sttModel?`,
`+ sttBaseUrl?`, `+ sttApiKey?` — все `@IsOptional() @IsString()`.

### 2.6. AiSettingsService
`apps/server/src/integrations/ai/ai-settings.service.ts`:
- `UpdateAiSettingsInput`: `+ sttModel?`, `+ sttBaseUrl?`, `+ sttApiKey?`.
- `resolve()`: добавить `sttModel: provider.sttModel`;
  `config.sttBaseUrl = provider.sttBaseUrl || provider.baseUrl`; в блоке
  `driver !== 'ollama'` — `config.sttApiKey = creds?.sttApiKeyEnc ? decrypt(...) : config.apiKey`.
- `getMasked()`: `hasSttApiKey = !!creds?.sttApiKeyEnc`; вернуть `sttModel`, `sttBaseUrl` (RAW), `hasSttApiKey`.
- `update()`: добавить `'sttModel'`, `'sttBaseUrl'` в whitelist не-секретных полей;
  вынуть `sttApiKey` из dto; расширить guard
  `if (apiKey !== undefined || embeddingApiKey !== undefined || sttApiKey !== undefined)`;
  добавить блок записи STT-ключа (write-only: `''`→`clearSttKey`, непустой→encrypt+`upsertSttKey`).

### 2.7. ⚠️ Второй whitelist (легко пропустить)
`apps/server/src/database/repos/workspace/workspace.repo.ts`, метод
`updateAiProviderSettings` имеет **собственный** массив `ALLOWED`
(`['driver','chatModel','embeddingModel','baseUrl','embeddingBaseUrl','systemPrompt']`),
который собирает JSON в SQL. Без добавления `'sttModel'`, `'sttBaseUrl'` сюда поля
**молча не сохранятся**. Это второй обязательный whitelist помимо service.

### 2.8. Клиент — типы и сервис
`apps/client/src/features/workspace/services/ai-settings-service.ts`:
- `IAiSettings`: `+ sttModel?`, `+ sttBaseUrl?`, `+ hasSttApiKey: boolean`.
- `IAiSettingsUpdate`: `+ sttModel?`, `+ sttBaseUrl?`, `+ sttApiKey?`.
(Эндпоинты `/workspace/ai-settings*` и query-хуки не меняются.)

### 2.9. Клиент — UI формы
`apps/client/src/features/workspace/components/settings/components/ai-provider-settings.tsx`
— блок STT по образцу embedding-блока:
- `formSchema` + `initialValues`: `sttModel`, `sttBaseUrl`, `sttApiKey` (строки).
- состояние `hasSttApiKey`, `sttKeyCleared`; гидрация из `settings`; `handleClearSttKey`;
  в `buildPayload` — та же write-only семантика (typed→set, cleared→`''`, untouched→omit)
  под гейтами `showApiKey`/`showBaseUrl`.
- поля: «STT model» (`TextInput`), «STT base URL» (`TextInput`, под `showBaseUrl`,
  placeholder «Leave empty to use the chat base URL»), «STT API key» (`PasswordInput`
  + «Clear key», под `showApiKey`, placeholder-fallback «Leave empty to use the chat API key»).

### 2.10. i18n
Эмбеддинг-строки лежат только в `en-US/translation.json` (ru-RU работает через фолбэк
на ключ). Для паритета — добавить в `en-US` исходные строки: «STT model», «STT base URL»,
«STT API key». «Clear key», «•••• set», «Leave empty to use the chat API key» переиспользуются.

### 2.11. Семантика ключа (write-only)

| Действие в форме | Что уходит в payload | Эффект на сервере |
|---|---|---|
| Ввели значение | `sttApiKey: "<key>"` | encrypt + `upsertSttKey` |
| Нажали «Clear key» | `sttApiKey: ""` | `clearSttKey` (→ fallback на чат-ключ) |
| Не трогали | поле отсутствует | ключ без изменений |

---

## 3. Часть 2 — Построитель модели и эндпоинт транскрипции

### 3.1. Исключение
Новый `apps/server/src/integrations/ai/ai-stt-not-configured.exception.ts` — копия
`ai-embedding-not-configured.exception.ts` (HttpException 503).

### 3.2. Построитель модели
Метод в `apps/server/src/integrations/ai/ai.service.ts` — зеркало `getEmbeddingModel`:

```ts
import { experimental_transcribe as transcribe, type TranscriptionModel } from 'ai';

// Build the transcription model. STT always speaks the OpenAI-compatible
// /v1/audio/transcriptions API (only @ai-sdk/openai exposes .transcription()).
// Reuses the chat API key; sttBaseUrl falls back to the chat baseUrl.
async getTranscriptionModel(workspaceId: string): Promise<TranscriptionModel> {
  const cfg = await this.aiSettings.resolve(workspaceId);
  if (!cfg?.sttModel) throw new AiSttNotConfiguredException();
  const baseURL = cfg.sttBaseUrl || cfg.baseUrl; // stt-specific, else chat
  // apiKey may be unused for keyless self-hosted whisper; pass a placeholder.
  return createOpenAI({ apiKey: cfg.sttApiKey ?? 'unused', baseURL })
    .transcription(cfg.sttModel);
}
```

### 3.3. Сервис транскрипции
Новый `apps/server/src/core/ai-chat/ai-transcription.service.ts`:

```ts
// Transcribe an uploaded audio buffer using the workspace STT model.
async transcribe(workspaceId: string, audio: Uint8Array): Promise<string> {
  const model = await this.ai.getTranscriptionModel(workspaceId);
  const { text } = await transcribe({ model, audio });
  return text.trim();
}
```

### 3.4. Эндпоинт
Добавить в `apps/server/src/core/ai-chat/ai-chat.controller.ts` (там уже есть
`JwtAuthGuard`, `UserThrottlerGuard`, throttle-инфра). Шаблон загрузки файла — как в
`attachment.controller.ts` (`@UseInterceptors(FileInterceptor)` + `req.file(...)`):

```ts
@HttpCode(HttpStatus.OK)
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
@Throttle({ [AI_CHAT_THROTTLER]: { limit: 20, ttl: 60000 } })
@Post('transcribe')
@UseInterceptors(FileInterceptor)
async transcribe(@Req() req, @AuthUser() user, @AuthWorkspace() workspace) {
  // Gate: dictation must be explicitly enabled for the workspace.
  const settings = (workspace.settings ?? {}) as { ai?: { dictation?: boolean } };
  if (settings.ai?.dictation !== true) throw new ForbiddenException('Dictation is disabled');

  const file = await req.file({ limits: { fileSize: 25 * 1024 * 1024, files: 1 } }); // Whisper 25MB cap
  if (!file) throw new BadRequestException('No audio uploaded');
  // validate file.mimetype ∈ {audio/webm, audio/mp4, audio/mpeg, audio/wav, audio/ogg}
  const buf = await file.toBuffer();
  const text = await this.aiTranscription.transcribe(workspace.id, buf);
  return { text };
}
```

### 3.5. Wiring
`ai-chat.module.ts` — зарегистрировать `AiTranscriptionService` в `providers`
(инжектит `AiService`; `AiModule` уже импортируется ради чата).

---

## 4. Часть 3 — Переключатель видимости кнопки

Новый булев фича-флаг **`settings.ai.dictation`** в ряду с `ai.chat` / `ai.generative` /
`ai.mcp` / `ai.search`. ⚠️ Не путать с `settings.ai.provider.*` (креды STT из части 1):
- `settings.ai.provider.*` → *как* работает распознавание.
- `settings.ai.dictation` → *показывать ли* кнопку. Две независимые сущности, обе нужны.

### 4.1. Сервер (паттерн `aiChat`)
- DTO `apps/server/src/core/workspace/dto/update-workspace.dto.ts`:
  `+ @IsOptional() @IsBoolean() aiDictation: boolean;`.
- `apps/server/src/core/workspace/services/workspace.service.ts` — блок-близнец `aiChat`:

```ts
if (typeof updateWorkspaceDto.aiDictation !== 'undefined') {
  const prev = settingsBefore?.ai?.dictation ?? false;
  if (prev !== updateWorkspaceDto.aiDictation) {
    before.aiDictation = prev; after.aiDictation = updateWorkspaceDto.aiDictation; // audit
  }
  await this.workspaceRepo.updateAiSettings(workspaceId, 'dictation', updateWorkspaceDto.aiDictation, trx);
}
// ...и delete updateWorkspaceDto.aiDictation; в блоке удалений
```
Generic-хелпер `workspaceRepo.updateAiSettings(workspaceId, prefKey, value)` уже пишет
`settings.ai.<prefKey>` — **менять не нужно**.

### 4.2. Клиент
- Тип `apps/client/src/features/workspace/types/workspace.types.ts`, в `IWorkspaceSettings.ai`:
  `+ dictation?: boolean;`.
- Тумблер в `ai-chat-settings.tsx` — второй `Switch` рядом с «AI chat»: оптимистичный
  `setChecked`, `updateWorkspace({ aiDictation: value })`, синхронизация
  `workspaceAtom.settings.ai.dictation`, откат при ошибке, `disabled={!isAdmin}`.

### 4.3. Гейтинг кнопки — две точки
- **Чат** — `ai-chat/components/chat-input.tsx`: `MicButton` рендерить только при
  `workspace?.settings?.ai?.dictation === true`. `chat-input` сейчас не читает
  `workspaceAtom` — добавить `useAtomValue(workspaceAtom)` либо прокинуть булев пропсом
  из `ai-chat-window`. (Сам чат виден только при `ai.chat === true`, т.е. в чате
  микрофон = `ai.chat && ai.dictation`.)
- **Страницы** — `editor/components/fixed-toolbar/fixed-toolbar.tsx`: уже читает
  `workspaceAtom`/`isGenerativeAiEnabled`. Добавить
  `const isDictationEnabled = workspace?.settings?.ai?.dictation === true;` и обернуть
  группу диктовки этим условием.

---

## 5. Часть 4 — Клиентский захват и кнопка

Новая общая фича-папка `apps/client/src/features/dictation/` (используется и чатом, и редактором).

### 5.1. API-функция — `services/dictation-service.ts`
```ts
// POST audio as multipart; server returns { text }. Uses the shared axios client.
export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("file", blob, "speech.webm");
  const req = await api.post<{ text: string }>("/ai-chat/transcribe", form);
  return req.data.text;
}
```

### 5.2. Хук — `hooks/use-dictation.ts`
Машина состояний `idle | recording | transcribing | error`:
- `getUserMedia({ audio: true })`, `new MediaRecorder(stream, { mimeType })` — выбор
  `audio/webm;codecs=opus`, фолбэк `audio/mp4` (Safari) через `MediaRecorder.isTypeSupported`.
- `start()/stop()/cancel()`; на `stop` собрать чанки в Blob → `transcribeAudio` → колбэк `onText(text)`.
- Авто-стоп по `maxDurationMs` (напр. 120 с); освобождать треки (`track.stop()`) в финале.
- Ошибки: `NotAllowedError` (нет доступа), `NotFoundError` (нет микрофона), сетевые/503 (STT не настроен).

### 5.3. Кнопка — `components/mic-button.tsx`
Mantine `ActionIcon` + `@tabler/icons-react`: `IconMicrophone` (idle) →
`IconPlayerStopFilled`/пульсация (recording) → `Loader` (transcribing). `Tooltip`,
`aria-label`, i18n. Пропсы `onText`, `disabled`.

### 5.4. Интеграция
- **Чат**: в `chat-input.tsx` — `<MicButton onText={(text) => setValue(v => v ? `${v} ${text}` : text)} />`
  перед кнопкой Send; `disabled={isStreaming || disabled}`.
- **Редактор**: новый `groups/dictation-group.tsx` для тулбара; использует `useDictation`,
  вставляет `editor.chain().focus().insertContent(text).run()`. **Важно:** курсор/selection
  может «уплыть» за время async-распознавания — сохранять позицию до записи и вставлять в неё.

---

## 6. Подводные камни (учесть при реализации)
1. **Только OpenAI-совместимый STT.** `gemini`/`ollama` не дают нативной `.transcription()`.
   STT-путь всегда OpenAI-совместимый; для self-hosted — `speaches`/`faster-whisper-server`
   (отдают `/v1/audio/transcriptions`), `sttBaseUrl` на них. Если `sttModel` не задан → 503
   (`AiSttNotConfigured`), кнопка скрыта/выдаёт ошибку.
2. **Формат аудио по браузерам.** Chrome/FF → `webm/opus`, Safari → `mp4`. Whisper принимает оба.
3. **Лимит 25 МБ / длина.** Авто-стоп по таймеру; чанкинг длинной диктовки — на будущее.
4. **Secure context.** `getUserMedia` работает только по `https`/`localhost`.
5. **Гонки.** Микрофон `disabled` во время `transcribing`; Send `disabled` во время записи;
   в редакторе — восстановить selection.
6. **Два whitelist'а провайдер-полей** (service + `workspace.repo` `ALLOWED`) — оба требуют новых ключей.
7. **Флаг vs наличие STT-кредов.** Консистентно с `ai.chat`: переключатель — единственный
   гейт *видимости*; рантайм отдаёт 503, если STT не настроен. Опционально — мягкая подсказка в админ-UI.

## 7. Безопасность
- Колонка `stt_api_key_enc` шифруется тем же `SecretBoxService`; таблица не в `baseFields`,
  наружу не отдаётся; маскированный ответ содержит лишь `hasSttApiKey`.
- Эндпоинт `/transcribe`: `JwtAuthGuard` + workspace-scope + throttle + лимит размера +
  whitelist mime + фича-гейт 403. Аудио и ключ не логируются.
- `sttBaseUrl` задаёт только админ (низкий SSRF-риск; при желании — прогнать через
  существующий `ssrf-guard` из external-mcp).

## 8. Порядок реализации
1. **Креды STT** (часть 1): миграция + тип таблицы + repo + server-типы + DTO +
   `AiSettingsService` (оба whitelist'а!) + client service + UI + i18n.
2. **Переключатель** (часть 3): DTO + блок в `workspace.service` + client-тип + тумблер + гейтинг.
3. **Построитель + эндпоинт** (часть 2): исключение + `getTranscriptionModel` +
   `AiTranscriptionService` + `/transcribe` + wiring + security.
4. **Захват + кнопка** (часть 4): фича `dictation` (service + `useDictation` + `MicButton`) +
   интеграция в чат и редактор.
5. Тесты + i18n.

Каждый пункт — отдельная порция работ; после каждого изменения кода — цикл ревью.

## 9. Полный список затрагиваемых файлов

**Бэкенд**
- `apps/server/src/database/migrations/20260618T130000-ai-stt-credentials.ts` (new)
- `apps/server/src/database/types/ai-provider-credentials.types.ts`
- `apps/server/src/database/repos/ai-chat/ai-provider-credentials.repo.ts`
- `apps/server/src/integrations/ai/ai.types.ts`
- `apps/server/src/integrations/ai/dto/update-ai-settings.dto.ts`
- `apps/server/src/integrations/ai/ai-settings.service.ts`
- `apps/server/src/integrations/ai/ai.service.ts`
- `apps/server/src/integrations/ai/ai-stt-not-configured.exception.ts` (new)
- `apps/server/src/database/repos/workspace/workspace.repo.ts` (массив `ALLOWED`)
- `apps/server/src/core/workspace/dto/update-workspace.dto.ts`
- `apps/server/src/core/workspace/services/workspace.service.ts`
- `apps/server/src/core/ai-chat/ai-transcription.service.ts` (new)
- `apps/server/src/core/ai-chat/ai-chat.controller.ts`
- `apps/server/src/core/ai-chat/ai-chat.module.ts`

**Фронтенд**
- `apps/client/src/features/workspace/services/ai-settings-service.ts`
- `apps/client/src/features/workspace/components/settings/components/ai-provider-settings.tsx`
- `apps/client/src/features/workspace/types/workspace.types.ts`
- `apps/client/src/features/workspace/components/settings/components/ai-chat-settings.tsx`
- `apps/client/src/features/ai-chat/components/chat-input.tsx`
- `apps/client/src/features/editor/components/fixed-toolbar/fixed-toolbar.tsx`
- `apps/client/src/features/dictation/` (new: services/hooks/components)
- `apps/client/src/features/editor/components/fixed-toolbar/groups/dictation-group.tsx` (new)
- `apps/client/public/locales/en-US/translation.json`

## 10. Открытые решения
- **Нейминг в UI.** Идентификаторы — `stt*` (в ряд с `embedding*`); лейблы — «STT …».
  Если нужно явно «Whisper» в UI — единственная косметическая развилка.
- **Один флаг или два.** Сейчас один `ai.dictation` на оба места. При необходимости
  раздельного управления — расщепляется на `ai.dictationChat` + `ai.dictationPages`.
- **Realtime.** Первый заход — push-to-talk (записал-распозналось-вставилось). Живой
  стриминг с промежуточным текстом — отдельная фаза.
