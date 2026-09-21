import { forwardRef, Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyController } from './api-key.controller';
import { TokenModule } from '../auth/token.module';
import { AuthModule } from '../auth/auth.module';

// Core (non-EE) API-key feature: issuance REST endpoints + the shared validator
// consumed by jwt.strategy (REST) and McpService (the /mcp Bearer router).
// DatabaseModule (global) provides ApiKeyRepo/UserRepo/WorkspaceRepo; CaslModule
// (global) provides WorkspaceAbilityFactory; TokenModule provides TokenService
// (the no-exp api-key signer). ApiKeyService is exported so AuthModule (for
// jwt.strategy) and McpModule (for the /mcp router) can inject it directly,
// replacing the absent EE `ee/api-key` dynamic require.
@Module({
  // forwardRef(AuthModule): the reveal endpoint's password step-up uses
  // AuthService.verifyUserCredentials. AuthModule already imports ApiKeyModule
  // (for JwtStrategy), so the two form a cycle that forwardRef resolves.
  imports: [TokenModule, forwardRef(() => AuthModule)],
  controllers: [ApiKeyController],
  providers: [ApiKeyService],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}
