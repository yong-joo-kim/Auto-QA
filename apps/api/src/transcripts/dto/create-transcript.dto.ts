import { Type } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsString, ValidateNested } from 'class-validator';
import {
  Channel,
  CreateTranscriptRequest,
  DOMAIN_IDS,
  DomainId,
  TranscriptMetadata,
} from '@auto-qa/shared-types';

export class TranscriptMetadataDto implements TranscriptMetadata {
  @IsOptional()
  @IsString()
  agentId?: string;

  @IsOptional()
  @IsISO8601()
  consultedAt?: string;

  @IsOptional()
  @IsIn(['voice', 'chat'])
  channel?: Channel;
}

export class CreateTranscriptDto implements CreateTranscriptRequest {
  @IsIn(DOMAIN_IDS as unknown as string[])
  domainId!: DomainId;

  @IsString()
  rawText!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TranscriptMetadataDto)
  metadata?: TranscriptMetadataDto;
}
