import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Thrown when no usable STT (speech-to-text) config exists for the workspace
 * (missing driver / sttModel). Distinct from the chat & embedding variants so
 * the transcription endpoint can 503 independently of chat/embeddings being
 * configured.
 */
export class AiSttNotConfiguredException extends ServiceUnavailableException {
  constructor() {
    // User-facing copy: the client surfaces this 503 message verbatim in the
    // dictation toast, so keep it consistent with the client's fallback copy.
    super('Voice dictation is not configured');
  }
}
