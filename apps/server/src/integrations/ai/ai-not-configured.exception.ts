import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Thrown when no usable AI provider config exists for the workspace (missing
 * driver / chat model / API key). Maps to HTTP 503 (§6.2/§6.4).
 */
export class AiNotConfiguredException extends ServiceUnavailableException {
  constructor(message = 'AI provider not configured') {
    super(message);
  }
}
