import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

// Step-up payload for `POST /api-keys/reveal`: the key to re-mint + the caller's
// current password. The password is re-verified server-side (AuthService.
// verifyUserCredentials) before the key is ever looked up, so a copyable,
// non-expiring token cannot be exfiltrated through a merely-hijacked session.
export class RevealApiKeyDto {
  @IsUUID()
  id: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}
