import { IsUUID } from 'class-validator';

export class RevokeApiKeyDto {
  @IsUUID()
  id: string;
}
