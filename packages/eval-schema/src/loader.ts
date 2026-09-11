import * as fs from 'fs';
import * as path from 'path';
import { EvalSheet, evalSheetSchema } from './schema';

/**
 * seed/eval-sheets/*.json 로더.
 *
 * 모노레포 어디서 실행되든(apps/api dist, ts-node 등) 리포지토리 루트의
 * `seed/eval-sheets` 디렉터리를 찾아야 하므로, __dirname부터 상위 디렉터리로
 * 올라가며 `seed/eval-sheets`가 존재하는 첫 지점을 사용한다.
 * env `EVAL_SHEETS_DIR`로 강제 지정도 가능하다.
 */
function findSeedDir(): string {
  if (process.env.EVAL_SHEETS_DIR) {
    return process.env.EVAL_SHEETS_DIR;
  }
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'seed', 'eval-sheets');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    '평가시트 디렉터리(seed/eval-sheets)를 찾을 수 없습니다. EVAL_SHEETS_DIR 환경변수로 경로를 지정하세요.',
  );
}

const FILE_BY_DOMAIN: Record<string, string> = {
  'finance-banking-card': '01-finance-banking-card.json',
  insurance: '02-insurance.json',
  telecom: '03-telecom.json',
  'ecommerce-retail': '04-ecommerce-retail.json',
  'public-service': '05-public-service.json',
  healthcare: '06-healthcare.json',
  'it-support': '07-it-support.json',
  'travel-lodging': '08-travel-lodging.json',
  'delivery-o2o': '09-delivery-o2o.json',
  utility: '10-utility.json',
};

const cache = new Map<string, EvalSheet>();

/** domainId에 해당하는 평가시트를 로드하고 zod로 검증한다. 결과는 프로세스 내 캐시된다. */
export function loadEvalSheet(domainId: string): EvalSheet {
  const cached = cache.get(domainId);
  if (cached) return cached;

  const fileName = FILE_BY_DOMAIN[domainId];
  if (!fileName) {
    throw new Error(`지원하지 않는 domainId입니다: ${domainId}`);
  }

  const seedDir = findSeedDir();
  const filePath = path.join(seedDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`평가시트 파일을 찾을 수 없습니다: ${filePath}`);
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const parsed = evalSheetSchema.parse(raw);
  cache.set(domainId, parsed);
  return parsed;
}

export function listSupportedDomainIds(): string[] {
  return Object.keys(FILE_BY_DOMAIN);
}
