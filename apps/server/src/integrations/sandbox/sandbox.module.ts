import { Global, Module } from '@nestjs/common';
import { SandboxController } from './sandbox.controller';
import { SandboxStore } from './sandbox.store';

/**
 * In-RAM blob sandbox: a SINGLE shared SandboxStore (the @Injectable singleton)
 * is written to by the stash tool (via McpService / AiChatToolsService) and read
 * back by the anonymous SandboxController. Marked @Global so the same store
 * instance is injectable everywhere without import churn — put() and get() MUST
 * hit the same Map. EnvironmentService (caps/TTL/public URL) is provided by the
 * global EnvironmentModule.
 */
@Global()
@Module({
  controllers: [SandboxController],
  providers: [SandboxStore],
  exports: [SandboxStore],
})
export class SandboxModule {}
