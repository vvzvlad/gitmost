import {
  ArrayMaxSize,
  IsArray,
  IsUUID,
} from 'class-validator';

export class TemplateLookupDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  sourcePageIds!: string[];
}
