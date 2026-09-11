import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CreateTranscriptResponse, EvaluationResultResponse } from '@auto-qa/shared-types';
import { CreateTranscriptDto } from './dto/create-transcript.dto';
import { TranscriptsService } from './transcripts.service';

@Controller('transcripts')
export class TranscriptsController {
  constructor(private readonly transcriptsService: TranscriptsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateTranscriptDto): Promise<CreateTranscriptResponse> {
    return this.transcriptsService.createAndEvaluate(dto);
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<EvaluationResultResponse> {
    return this.transcriptsService.getResult(id);
  }
}
