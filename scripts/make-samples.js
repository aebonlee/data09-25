// 가상 샘플 파일 만들기: node scripts/make-samples.js
// js/sample-data.js 의 8주치를 실제 주간표와 같은 모양의 .xlsx 8개로 씁니다(전부 지어낸 값).
// 날짜 칸은 엑셀 날짜로 넣고, 방금 쓴 파일을 앱과 같은 방식으로 다시 읽어 확인합니다.
const fs = require('fs');
const path = require('path');
const XLSX = require('../vendor/xlsx.full.min.js');
const L = require('../js/logic.js');
const Sample = require('../js/sample-data.js');

const out = path.join(__dirname, '..', 'samples');
fs.mkdirSync(out, { recursive: true });
let recs = [];
for (const f of Sample.build()) {
  const aoa = f.aoa.map((row, i) => i < 3 ? row : row.map((v, c) => ((c === 0 || c === 8) && typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v)) ? new Date(v + 'T00:00:00') : v));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: 'yyyy-mm-dd' });
  ws['!merges'] = [{ s: { r: 1, c: 0 }, e: { r: 1, c: 6 } }, { s: { r: 1, c: 7 }, e: { r: 1, c: 11 } }, { s: { r: 1, c: 12 }, e: { r: 1, c: 14 } }, { s: { r: 1, c: 15 }, e: { r: 1, c: 25 } }, { s: { r: 1, c: 26 }, e: { r: 1, c: 28 } }];
  XLSX.utils.book_append_sheet(wb, ws, '주조 생산실적');
  fs.writeFileSync(path.join(out, f.fileName), XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', cellDates: true }));
  const back = XLSX.read(fs.readFileSync(path.join(out, f.fileName)), { type: 'buffer', cellDates: true });
  const p = L.parseSheet(XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { header: 1, raw: true, defval: null }), { fileName: f.fileName });
  if (p.det.missing.length || p.warnings.length) throw new Error(f.fileName + ' 다시 읽기 실패: ' + JSON.stringify(p.det.warnings.concat(p.warnings).slice(0, 3)));
  recs = L.mergeRecords(recs, p.records).records;
  console.log(f.fileName, '행', p.records.length);
}
console.log('누적 행', recs.length, '실적 주', L.producedWeeks(recs).join(', '));
