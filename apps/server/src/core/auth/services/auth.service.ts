import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { LoginDto } from '../dto/login.dto';
import { CreateUserDto } from '../dto/create-user.dto';
import { TokenService } from './token.service';
import { SessionService } from '../../session/session.service';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { SignupService } from './signup.service';
import { CreateAdminUserDto } from '../dto/create-admin-user.dto';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import {
  comparePasswordHash,
  hashPassword,
  isUserDisabled,
  nanoIdGen,
} from '../../../common/helpers';
import { throwIfEmailNotVerified } from '../auth.util';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { MailService } from '../../../integrations/mail/mail.service';
import ChangePasswordEmail from '@docmost/transactional/emails/change-password-email';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import ForgotPasswordEmail from '@docmost/transactional/emails/forgot-password-email';
import { UserTokenRepo } from '@docmost/db/repos/user-token/user-token.repo';
import { PasswordResetDto } from '../dto/password-reset.dto';
import { User, UserToken, Workspace } from '@docmost/db/types/entity.types';
import { UserTokenType, CREDENTIALS_MISMATCH_MESSAGE } from '../auth.constants';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { InjectKysely } from 'nestjs-kysely';
import { executeTx } from '@docmost/db/utils';
import { VerifyUserTokenDto } from '../dto/verify-user-token.dto';
import { DomainService } from '../../../integrations/environment/domain.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

// A valid bcrypt hash (cost 10, of an arbitrary throwaway string) used ONLY to
// equalize timing in verifyUserCredentials: when the email does not exist or
// the user is disabled, we still run ONE bcrypt comparison against this hash
// before throwing, so the missing/disabled path takes about the same time as
// the real-user wrong-password path. Without it, the "no bcrypt at all" branch
// returns measurably faster, leaking whether an email is registered (a user-
// enumeration timing oracle, now reachable via /mcp where throttling is only a
// spoofable in-memory limiter). This is never used as a real credential.
// The cost factor MUST match the production saltRounds (12 — see
// common/helpers/utils.ts hashPassword), otherwise the dummy compare runs
// faster than a real wrong-password compare and the timing oracle survives.
const DUMMY_PASSWORD_HASH =
  '$2b$12$q/l637TULK3vU3Cmji0y8utpJS/UiftMi3Jdm4Tsi5EIv/0FE7WV.';

@Injectable()
export class AuthService {
  constructor(
    private signupService: SignupService,
    private tokenService: TokenService,
    private sessionService: SessionService,
    private userSessionRepo: UserSessionRepo,
    private userRepo: UserRepo,
    private userTokenRepo: UserTokenRepo,
    private mailService: MailService,
    private domainService: DomainService,
    private environmentService: EnvironmentService,
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  /**
   * Verify a user's email + password WITHOUT any side effects: it performs the
   * exact same user lookup, password comparison, email-verified and disabled
   * checks as `login()`, but does NOT mint a session/token, does NOT write the
   * USER_LOGIN audit event, and does NOT update lastLoginAt. Returns the matched
   * user on success; throws UnauthorizedException (credentials) or whatever
   * `throwIfEmailNotVerified` throws otherwise.
   *
   * Use this for repeated per-request credential re-validation (e.g. the /mcp
   * anti-fixation check on subsequent requests) where minting a new DB session
   * and audit row on every call would be audit spam / a session-table DoS. The
   * full `login()` reuses it so there is no behaviour drift between the two.
   */
  async verifyUserCredentials(
    loginDto: LoginDto,
    workspaceId: string,
  ): Promise<User> {
    const user = await this.userRepo.findByEmail(loginDto.email, workspaceId, {
      includePassword: true,
    });

    // Single source of truth (see auth.constants): the /mcp brute-force limiter
    // recognises this exact message via isCredentialsFailure.
    const errorMessage = CREDENTIALS_MISMATCH_MESSAGE;
    if (!user || isUserDisabled(user) || !user.password) {
      // SSO/LDAP-only accounts have no local password hash (user.password is
      // null): feeding null to native bcrypt makes it REJECT with
      // "data and hash arguments required", which surfaces as a 500 on
      // /api/auth/login and as a leaky 401 (not recognised by the /mcp
      // brute-force limiter) on /mcp. Treat such accounts like a missing user.
      //
      // Constant-time intent: run ONE bcrypt comparison (against a dummy hash)
      // even when the user is missing/disabled/password-less, so this path takes
      // about the same time as the real-user wrong-password path below. This
      // closes the user-enumeration timing oracle (registered vs. not). The
      // result is intentionally discarded — we always throw the same
      // credentials error (recognised by isCredentialsFailure on /mcp).
      await comparePasswordHash(loginDto.password, DUMMY_PASSWORD_HASH);
      throw new UnauthorizedException(errorMessage);
    }

    const isPasswordMatch = await comparePasswordHash(
      loginDto.password,
      user.password,
    );

    if (!isPasswordMatch) {
      throw new UnauthorizedException(errorMessage);
    }

    throwIfEmailNotVerified({
      isCloud: this.environmentService.isCloud(),
      emailVerifiedAt: user.emailVerifiedAt,
      email: user.email,
      workspaceId,
      appSecret: this.environmentService.getAppSecret(),
    });

    return user;
  }

  async login(loginDto: LoginDto, workspaceId: string) {
    const user = await this.verifyUserCredentials(loginDto, workspaceId);

    user.lastLoginAt = new Date();
    await this.userRepo.updateLastLogin(user.id, workspaceId);

    this.auditService.log({
      event: AuditEvent.USER_LOGIN,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { source: 'password' },
    });

    return this.sessionService.createSessionAndToken(user);
  }

  async register(createUserDto: CreateUserDto, workspaceId: string) {
    const user = await this.signupService.signup(createUserDto, workspaceId);
    return this.sessionService.createSessionAndToken(user);
  }

  async setup(createAdminUserDto: CreateAdminUserDto) {
    const { workspace, user } =
      await this.signupService.initialSetup(createAdminUserDto);

    const authToken = await this.sessionService.createSessionAndToken(user);
    return { workspace, authToken };
  }

  async changePassword(
    dto: ChangePasswordDto,
    userId: string,
    workspaceId: string,
    currentSessionId?: string,
  ): Promise<void> {
    const user = await this.userRepo.findById(userId, workspaceId, {
      includePassword: true,
    });

    if (!user || isUserDisabled(user)) {
      throw new NotFoundException('User not found');
    }

    // SSO/LDAP-only accounts have no local password hash (user.password is
    // null). Passing null to native bcrypt makes it REJECT with
    // "data and hash arguments required" (an unhandled 500), so never call
    // comparePasswordHash on null. There is no current local password to verify,
    // so reject the same way a wrong current password is rejected.
    if (!user.password) {
      throw new BadRequestException('Current password is incorrect');
    }

    const comparePasswords = await comparePasswordHash(
      dto.oldPassword,
      user.password,
    );

    if (!comparePasswords) {
      throw new BadRequestException('Current password is incorrect');
    }

    const newPasswordHash = await hashPassword(dto.newPassword);
    await this.userRepo.updateUser(
      {
        password: newPasswordHash,
        hasGeneratedPassword: false,
      },
      userId,
      workspaceId,
    );

    if (currentSessionId) {
      await this.userSessionRepo.deleteAllExceptCurrent(
        currentSessionId,
        userId,
        workspaceId,
      );
    } else {
      await this.userSessionRepo.deleteByUserId(userId, workspaceId);
    }

    this.auditService.log({
      event: AuditEvent.USER_PASSWORD_CHANGED,
      resourceType: AuditResource.USER,
      resourceId: userId,
    });

    const emailTemplate = ChangePasswordEmail({ username: user.name });
    await this.mailService.sendToQueue({
      to: user.email,
      subject: 'Your password has been changed',
      template: emailTemplate,
    });
  }

  async forgotPassword(
    forgotPasswordDto: ForgotPasswordDto,
    workspace: Workspace,
  ): Promise<void> {
    const user = await this.userRepo.findByEmail(
      forgotPasswordDto.email,
      workspace.id,
    );

    if (!user || isUserDisabled(user)) {
      return;
    }

    const token = nanoIdGen(16);

    await executeTx(this.db, async (trx) => {
      await trx
        .deleteFrom('userTokens')
        .where('userId', '=', user.id)
        .where('type', '=', UserTokenType.FORGOT_PASSWORD)
        .execute();

      await this.userTokenRepo.insertUserToken(
        {
          token,
          userId: user.id,
          workspaceId: user.workspaceId,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
          type: UserTokenType.FORGOT_PASSWORD,
        },
        { trx },
      );
    });

    const resetLink = `${this.domainService.getUrl(workspace.hostname)}/password-reset?token=${token}`;

    const emailTemplate = ForgotPasswordEmail({
      username: user.name,
      resetLink: resetLink,
    });

    await this.mailService.sendToQueue({
      to: user.email,
      subject: 'Reset your password',
      template: emailTemplate,
    });
  }

  async passwordReset(
    passwordResetDto: PasswordResetDto,
    workspace: Workspace,
  ) {
    const userToken = await this.userTokenRepo.findById(
      passwordResetDto.token,
      workspace.id,
    );

    if (
      !userToken ||
      userToken.type !== UserTokenType.FORGOT_PASSWORD ||
      userToken.expiresAt < new Date()
    ) {
      throw new BadRequestException('Invalid or expired token');
    }

    const user = await this.userRepo.findById(userToken.userId, workspace.id, {
      includeUserMfa: true,
    });
    if (!user || isUserDisabled(user)) {
      throw new NotFoundException('User not found');
    }

    const newPasswordHash = await hashPassword(passwordResetDto.newPassword);

    await executeTx(this.db, async (trx) => {
      await this.userRepo.updateUser(
        {
          password: newPasswordHash,
          hasGeneratedPassword: false,
        },
        user.id,
        workspace.id,
        trx,
      );

      await trx
        .deleteFrom('userTokens')
        .where('userId', '=', user.id)
        .where('type', '=', UserTokenType.FORGOT_PASSWORD)
        .execute();
    });

    await this.userSessionRepo.deleteByUserId(user.id, workspace.id);

    this.auditService.setActorId(user.id);
    this.auditService.log({
      event: AuditEvent.USER_PASSWORD_RESET,
      resourceType: AuditResource.USER,
      resourceId: user.id,
    });

    const emailTemplate = ChangePasswordEmail({ username: user.name });
    await this.mailService.sendToQueue({
      to: user.email,
      subject: 'Your password has been changed',
      template: emailTemplate,
    });

    if (this.environmentService.isCloud() && !user.emailVerifiedAt) {
      await this.userRepo.updateUser(
        { emailVerifiedAt: new Date() },
        user.id,
        workspace.id,
      );
    }

    // Check if user has MFA enabled or workspace enforces MFA
    const userHasMfa = user?.['mfa']?.isEnabled || false;
    const workspaceEnforcesMfa = workspace.enforceMfa || false;

    if (userHasMfa || workspaceEnforcesMfa) {
      return {
        requiresLogin: true,
      };
    }

    const authToken = await this.sessionService.createSessionAndToken(user);
    return { authToken };
  }

  async verifyUserToken(
    userTokenDto: VerifyUserTokenDto,
    workspaceId: string,
  ): Promise<void> {
    const userToken: UserToken = await this.userTokenRepo.findById(
      userTokenDto.token,
      workspaceId,
    );

    if (
      !userToken ||
      userToken.type !== userTokenDto.type ||
      userToken.expiresAt < new Date()
    ) {
      throw new BadRequestException('Invalid or expired token');
    }
  }

  async getCollabToken(user: User, workspaceId: string) {
    const token = await this.tokenService.generateCollabToken(
      user,
      workspaceId,
    );
    return { token };
  }
}
