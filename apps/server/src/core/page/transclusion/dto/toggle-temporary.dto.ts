import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class ToggleTemporaryDto {
  @IsUUID()
  pageId!: string;

  /**
   * When omitted, the temporary state is toggled relative to its current value.
   * true  -> arm the timer (now + workspace temporaryNoteHours);
   * false -> clear it (make permanent — "structure and survive").
   */
  @IsOptional()
  @IsBoolean()
  temporary?: boolean;
}
