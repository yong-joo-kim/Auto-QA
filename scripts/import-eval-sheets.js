const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE_DIR = path.join(ROOT, 'docs', 'source-sheets');
const DEFAULT_OUT_DIR = path.join(ROOT, 'seed', 'eval-sheets');

function resolveDefaultInput() {
  if (!fs.existsSync(DEFAULT_SOURCE_DIR)) return null;
  const candidates = fs
    .readdirSync(DEFAULT_SOURCE_DIR)
    .filter((f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$'));
  if (candidates.length === 0) return null;
  return path.join(DEFAULT_SOURCE_DIR, candidates[0]);
}

const filePath = process.argv[2] || resolveDefaultInput();
const outDir = process.argv[3] || DEFAULT_OUT_DIR;

if (!filePath || !fs.existsSync(filePath)) {
  console.error(
    `평가시트 Excel 파일을 찾을 수 없습니다. "${DEFAULT_SOURCE_DIR}"에 .xlsx 파일을 두거나, 경로를 인자로 지정하세요.\n` +
      `사용법: node scripts/import-eval-sheets.js [입력.xlsx] [출력디렉터리]`
  );
  process.exit(1);
}

const wb = XLSX.readFile(filePath);

const DOMAIN_MAP = {
  '1_금융(은행-카드)': { domainId: 'finance-banking-card', order: 1 },
  '2_보험': { domainId: 'insurance', order: 2 },
  '3_통신(이동통신-인터넷)': { domainId: 'telecom', order: 3 },
  '4_이커머스-유통': { domainId: 'ecommerce-retail', order: 4 },
  '5_공공기관-민원': { domainId: 'public-service', order: 5 },
  '6_의료-헬스케어': { domainId: 'healthcare', order: 6 },
  '7_IT-SW기술지원': { domainId: 'it-support', order: 7 },
  '8_여행-숙박': { domainId: 'travel-lodging', order: 8 },
  '9_배달-O2O': { domainId: 'delivery-o2o', order: 9 },
  '10_유틸리티(전기-가스)': { domainId: 'utility', order: 10 },
};

const CATEGORY_SLUG = {
  '기본응대': 'basic-response',
  '상담태도': 'attitude',
  '상담전문성': 'expertise',
  '처리효율': 'efficiency',
  '컴플라이언스': 'compliance',
};

const GRADE_CRITERIA = [
  { minScore: 90, grade: '우수' },
  { minScore: 80, grade: '양호' },
  { minScore: 70, grade: '보통' },
  { minScore: 0, grade: '미흡' },
];

function slugifyItem(categorySlug, seq) {
  return `${categorySlug}-${String(seq).padStart(2, '0')}`;
}

const results = [];

for (const sheetName of wb.SheetNames) {
  const meta = DOMAIN_MAP[sheetName];
  if (!meta) continue;

  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });

  const title = String(rows[0][0] || '').trim();
  const mainTypesRaw = String(rows[1][0] || '');
  const mainConsultationTypes = mainTypesRaw.replace(/^주요 상담 유형:\s*/, '').trim();

  // find header row (구분 열) - should be row index 6
  let headerIdx = rows.findIndex((r) => r[0] === '구분' && r[1] === '평가항목');
  if (headerIdx === -1) throw new Error(`header row not found in ${sheetName}`);

  const categoriesOrder = [];
  const categoriesMap = {};
  const itemSeqByCat = {};

  let idx = headerIdx + 1;
  for (; idx < rows.length; idx++) {
    const r = rows[idx];
    const categoryName = String(r[0] || '').trim();
    if (categoryName === '합계') break;
    if (categoryName === '') continue;

    const itemName = String(r[1] || '').trim();
    const criteria = String(r[2] || '').trim();
    const maxScore = Number(r[3]);
    const gatingRaw = String(r[4] || '').trim();
    const gating = gatingRaw === 'P/F';

    if (!categoriesMap[categoryName]) {
      const categoryId = CATEGORY_SLUG[categoryName] || categoryName;
      categoriesMap[categoryName] = { categoryId, categoryName, maxScore: 0, items: [] };
      categoriesOrder.push(categoryName);
      itemSeqByCat[categoryName] = 0;
    }
    itemSeqByCat[categoryName] += 1;
    const cat = categoriesMap[categoryName];
    cat.maxScore += maxScore;
    cat.items.push({
      itemId: slugifyItem(cat.categoryId, itemSeqByCat[categoryName]),
      itemName,
      criteria,
      maxScore,
      gating,
    });
  }

  // idx now at "합계" row
  const totalRow = rows[idx];
  const totalMaxScore = Number(totalRow[3]);

  // scan remaining rows for 출처 (source citation) and disclaimer
  let sourceCitation = '';
  let disclaimer = '';
  for (let j = idx; j < rows.length; j++) {
    const cell0 = String(rows[j][0] || '');
    if (cell0.startsWith('출처(')) sourceCitation = cell0.trim();
    if (cell0.startsWith('※')) disclaimer = cell0.trim();
  }

  const categories = categoriesOrder.map((name) => categoriesMap[name]);

  const domainJson = {
    domainId: meta.domainId,
    domainName: title.replace(/\s*상담사 평가시트$/, '').trim(),
    version: '1.0.0',
    mainConsultationTypes,
    totalMaxScore,
    gradeCriteria: GRADE_CRITERIA,
    gatingPolicy: '게이팅(P/F) 항목이 1건이라도 실패(F)이면 총점과 무관하게 전체 결과를 탈락(재검토 필요)으로 판정한다.',
    categories,
    sourceCitation,
    disclaimer,
  };

  results.push({ order: meta.order, domainId: meta.domainId, json: domainJson });
}

results.sort((a, b) => a.order - b.order);

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

for (const r of results) {
  const fname = `${String(r.order).padStart(2, '0')}-${r.domainId}.json`;
  fs.writeFileSync(path.join(outDir, fname), JSON.stringify(r.json, null, 2) + '\n', 'utf-8');
  console.log('wrote', fname, '- total categories:', r.json.categories.length, '- totalMaxScore:', r.json.totalMaxScore);
}

console.log(`\nDone. ${results.length} domain files written to ${outDir}`);
