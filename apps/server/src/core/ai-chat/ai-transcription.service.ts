import { Injectable } from '@nestjs/common';
import { experimental_transcribe as transcribe } from 'ai';
import { AiService } from '../../integrations/ai/ai.service';

/**
 * Transcribes uploaded audio to text using the per-workspace STT model.
 * Thin wrapper over the AI SDK's experimental_transcribe; never logs the
 * audio or the key.
 */
@Injectable()
export class AiTranscriptionService {
  constructor(private readonly ai: AiService) {}

  // Transcribe an uploaded audio buffer using the workspace STT model.
  async transcribe(workspaceId: string, audio: Uint8Array): Promise<string> {
    const model = await this.ai.getTranscriptionModel(workspaceId);
    const { text } = await transcribe({ model, audio });
    return text.trim();
  }
}
