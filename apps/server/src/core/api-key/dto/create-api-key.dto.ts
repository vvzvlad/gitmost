import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';

/**
 * `expiresAt` must be strictly in the future. Skips validation for `null`
 * (explicit "unlimited") and `undefined` (server applies the 1-year default),
 * so only an actually-supplied date is range-checked. Rejecting a PAST date at
 * the DTO layer means a caller cannot mint an already-dead key.
 */
function IsFutureDateString(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isFutureDateString',
      target: object.constructor,
      propertyName,
      options: {
        message: 'expiresAt must be a date in the future',
        ...options,
      },
      validator: {
        validate(value: unknown) {
          if (value === null || value === undefined) return true;
          if (typeof value !== 'string') return false;
          const t = Date.parse(value);
          return !Number.isNaN(t) && t > Date.now();
        },
      },
    });
  };
}

export class CreateApiKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  // undefined -> default 1 year (applied server-side); null -> unlimited
  // (explicit); an ISO date string -> that instant, which must be in the future.
  @IsOptional()
  @IsDateString()
  @IsFutureDateString()
  expiresAt?: string | null;
}
