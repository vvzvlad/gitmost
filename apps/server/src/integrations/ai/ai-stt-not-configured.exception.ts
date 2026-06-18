import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Thrown when no usable STT (speech-to-text) config exists for the workspace
 * (missing driver / sttModel). Distinct from the chat & embedding variants so
 * the transcription endpoint can 503 independently of chat/embeddings being
 * configured.
 */
export class AiSttNotConfiguredException extends ServiceUnavailableException {
  constructor() {
    super('AI STT model not configured');
  }
}
