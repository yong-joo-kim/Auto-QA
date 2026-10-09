import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { TrustedOriginGuard } from '../common/trusted-origin.guard';
import type { EvalSheet } from '@auto-qa/eval-schema';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { EvalSheetsService, EvalSheetSummary, UploadEvalSheetsResult } from './eval-sheets.service';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOWNLOAD_FILE_NAME = '도메인별_상담사_평가시트_10종.xlsx';

@Controller('eval-sheets')
export class EvalSheetsController {
  constructor(private readonly evalSheets: EvalSheetsService) {}

  @Get()
  list(): EvalSheetSummary[] {
    return this.evalSheets.list();
  }

  @Get('download')
  async download(@Res() res: Response): Promise<void> {
    const buffer = await this.evalSheets.exportWorkbook();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(DOWNLOAD_FILE_NAME)}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  }

  /** 'download'보다 뒤에 선언해야 경로가 가려지지 않는다. */
  @Get(':domainId')
  detail(@Param('domainId') domainId: string): EvalSheet {
    return this.evalSheets.getSheetDetail(domainId);
  }

  @Post('upload')
  @HttpCode(200)
  @UseGuards(TrustedOriginGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async upload(@UploadedFile() file?: Express.Multer.File): Promise<UploadEvalSheetsResult> {
    if (!file) {
      throw new BadRequestException('업로드할 .xlsx 파일을 선택해 주세요.');
    }
    if (!/\.xlsx$/i.test(file.originalname)) {
      throw new BadRequestException('.xlsx 형식의 파일만 업로드할 수 있습니다.');
    }
    // 내용 기반 검사: xlsx는 zip이므로 선두 'PK' 시그니처가 있어야 한다.
    if (file.buffer.length < 4 || file.buffer.readUInt32LE(0) !== 0x04034b50) {
      throw new BadRequestException('올바른 .xlsx 파일이 아닙니다.');
    }
    return this.evalSheets.importWorkbook(file.buffer);
  }

  @Delete(':domainId/override')
  @HttpCode(204)
  @UseGuards(TrustedOriginGuard)
  async reset(@Param('domainId') domainId: string): Promise<void> {
    await this.evalSheets.resetToDefault(domainId);
  }
}
