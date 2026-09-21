import { forwardRef, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SignupService } from './services/signup.service';
import { TokenModule } from './token.module';
import { ApiKeyModule } from '../api-key/api-key.module';

@Module({
  // ApiKeyModule supplies ApiKeyService, injected into JwtStrategy so an
  // api_key Bearer/cookie token is validated directly (replacing the absent EE
  // `ee/api-key` dynamic require). forwardRef: ApiKeyModule imports AuthModule
  // back (for the reveal step-up), so the two form a cycle.
  imports: [TokenModule, WorkspaceModule, forwardRef(() => ApiKeyModule)],
  controllers: [AuthController],
  providers: [AuthService, SignupService, JwtStrategy],
  exports: [SignupService, AuthService],
})
export class AuthModule {}
