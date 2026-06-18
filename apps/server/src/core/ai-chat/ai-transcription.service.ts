import { Injectable } from '@nestjs/common';
import { AiService } from '../../integrations/ai/ai.service';

/**
 * Transcribes uploaded audio to text using the per-workspace STT model.
 * Delegates to AiService, which picks the OpenAI-multipart or OpenRouter-JSON
 * path. Never logs the audio or the key.
 */
@Injectable()
export class AiTranscriptionService {
  constructor(private readonly ai: AiService) {}

  // Transcribe an uploaded audio buffer. `format` is the container hint.
  async transcribe(
    workspaceId: string,
    audio: Uint8Array,
    format: string,
  ): Promise<string> {
    return this.ai.transcribe(workspaceId, audio, format);
  }
}
