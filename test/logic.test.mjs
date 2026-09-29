// 실행: node test/logic.test.mjs   (의존성 없음 — vendor 의 SheetJS 만 씀)
// 실제 주간표(작업자 실명·실제 품번 포함)는 리포에 넣지 않았습니다. 여기서는 같은 모양의 가상 표와 샘플 8주로 검사하고,
// 실제 파일로 요약 시트와 맞는지는 로컬에서만 확인했습니다(docs/개발일지.md).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../js/logic.js');
const Sample = require('../js/sample-data.js');
const XLSX = require('../vendor/xlsx.full.min.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

// 실제 주간표와 같은 모양의 작은 가상 표 (1행 제목 · 2행 묶음 머리 · 3행 머리 · 자료 · 범례)
const HEAD = Sample.HEAD, GROUP = Sample.HEAD_GROUP;
function row(o) {
  const r = [o.date, o.line, o.pn, o.name, o.plan, o.planHr, 'X', o.workHr ?? null, o.cast ?? null, o.castLine ?? null, o.worker ?? null, o.run ?? null,
    o.total ?? null, o.good ?? null, o.scrap ?? null];
  'ABCDEFGHIJ'.split('').forEach(c => r.push((o.down || {})[c] ?? null));
  r.push(o.note ?? null, 1.5, null, o.short ?? null);
  return r;
}
const TINY = [
  ['■ 주조 생산현황'], GROUP, HEAD,
  row({ date: '2026-09-21', line: 1, pn: 'T-100', name: '매니폴드', plan: 100, planHr: 10, workHr: 10, cast: '2026-09-21', castLine: 1, worker: '작업자A', run: 540, total: 110, good: 108, scrap: 2, down: { A: 60 }, short: 8 }),
  row({ date: '2026-09-21', line: 2, pn: 'T-200', name: '파이프', plan: 50, planHr: 5, workHr: 4, cast: '2026-09-21', castLine: 2, worker: '작업자B', run: 200, total: 40, good: 37, scrap: 3, down: { A: 40, C: 30 }, note: 'C:설비 점검(30)', short: -13 }),
  // 계획일은 21일인데 실제로는 22일에 이어서 주조한 행 (계획수량 0)
  row({ date: '2026-09-21', line: 1, pn: 'T-100', name: '매니폴드', plan: 0, planHr: 0, workHr: 5, cast: '2026-09-22', castLine: 1, total: 50, good: 50, scrap: 0, down: { A: 30 }, short: 50 }),
  // 계획만 있고 실적이 없는 행(이번 주)
  row({ date: '2026-09-23', line: 2, pn: 'T-300', name: '파이프', plan: 80, planHr: 8 }),
  // 다음 주 계획 행
  row({ date: '2026-09-28', line: 1, pn: 'T-100', name: '매니폴드', plan: 120, planHr: 10 }),
  [],
  [null, null, null, null, null, null, null, null, null, null, null, null, null, 'Code', '항목', null, '비가동의 정의'],
  [null, null, null, null, null, null, null, null, null, null, null, null, null, 'A', '셋팅 시간', null, '생산 준비'],
  [null, null, null, null, null, null, null, null, null, null, null, null, null, 'G', '회의', '계획정지', '정기 회의'],
  [null, null, null, null, null, null, null, null, null, null, null, null, null, 'K', '초도개발', null, '초도품 생산 시간']
];

console.log('열 찾기 · 범례');
test('2줄 머리행 — 3행을 머리, 2행을 묶음 머리로 찾고 19개 열 + 비가동 A~J 를 연결', () => {
  const d = L.detectColumns(TINY);
  assert.equal(d.headerRow, 2);
  assert.equal(d.groupRow, 1);
  assert.equal(Object.keys(d.map).length, 19);
  assert.equal(d.map.good, 13);
  assert.equal(d.map.short, 28);
  assert.deepEqual(d.downCols.map(x => x.code).join(''), 'ABCDEFGHIJ');
  assert.deepEqual(d.missing, []);
});
test('열 순서가 달라도·공백이 달라도 이름으로 찾음 (총수량 · 작업시간 · 품목코드)', () => {
  const aoa = [['품목코드', '일자', '호기', '계획', '양품', '폐기', '총수량', '작업시간', '주조일자'], ['X-1', '2026-09-21', 3, 10, 9, 1, 10, 1, '2026-09-21']];
  const d = L.detectColumns(aoa);
  assert.equal(d.headerRow, 0);
  assert.equal(d.map.partNo, 0); assert.equal(d.map.total, 6); assert.equal(d.map.workHr, 7);
  assert.ok(d.warnings.some(w => w.includes('비가동')), '비가동 코드 열이 없다는 경고');
});
test('필수 열이 없으면 missing 에 담고 행을 읽지 않음 · 사용자가 열을 고르면 다시 읽음', () => {
  const aoa = [['날짜', '호기', '품번', '계획수량', '좋은수량'], ['2026-09-21', 1, 'X-1', 10, 9]];
  const d = L.detectColumns(aoa);
  assert.deepEqual(d.missing, ['good']);
  assert.equal(L.parseRows(aoa, d).records.length, 0);
  const p = L.parseSheet(aoa, { overrides: { good: 4 } });
  assert.equal(p.records.length, 1);
  assert.equal(p.records[0].good, 9);
});
test('머리행이 없는 시트(요약·피벗)는 고르지 않음', () => {
  const pivot = [[], [], ['행 레이블', '계획시간(HR)', '실투입시간(HR)', '합계 : 계획수량', '양품수량 ', '폐기수량 ', '미달수량 '], ['매니폴드', 1, 1, 1, 1, 0, 1]];
  const pick = L.pickSheet([{ name: '요약', aoa: pivot }, { name: '원자료', aoa: TINY }]);
  assert.equal(pick.name, '원자료');
  assert.equal(L.detectColumns(pivot).headerRow, -1);
});
test('범례 — Code 표에서 이름·계획정지 표시를 읽음 (열이 없는 K 도 보관)', () => {
  const lg = L.parseLegend(TINY);
  assert.deepEqual(Object.keys(lg), ['A', 'G', 'K']);
  assert.equal(lg.A.name, '셋팅 시간');
  assert.equal(lg.G.planned, true);
  assert.equal(lg.A.planned, false);
});

console.log('숫자 · 날짜 · 행');
test('날짜 — 엑셀 일련번호 · Date · 글자 · 월/일(연도 추정)', () => {
  assert.equal(L.toISO(46286), '2026-09-21');
  assert.equal(L.toISO(new Date(2026, 8, 21)), '2026-09-21');
  assert.equal(L.toISO(new Date(2026, 8, 20, 23, 59, 8)), '2026-09-21'); // 시간대 때문에 전날 23:59 로 들어온 값
  assert.equal(L.toISO('2026.9.21'), '2026-09-21');
  assert.equal(L.toISO('9/21', 2026), '2026-09-21');
  assert.equal(L.toISO('2026-02-30'), '');
  assert.equal(L.weekStart('2026-09-27'), '2026-09-21'); // 일요일 → 그 주 월요일
  assert.equal(L.weekLabel('2026-09-21'), '9월 4주차 (09/21~09/27)'); // 실제 파일 이름 「9-4」와 같음
  assert.equal(L.weekLabel('2026-08-31'), '9월 1주차 (08/31~09/06)'); // 목요일(9/3)이 9월
  assert.equal(L.weekLabel('2026-09-28'), '10월 1주차 (09/28~10/04)');
});
test('숫자 — 빈칸·공백은 null, 쉼표 허용, 저장 안 된 수식은 null, 글자는 NaN', () => {
  assert.equal(L.toNum(' '), null);
  assert.equal(L.toNum('1,234'), 1234);
  assert.equal(L.toNum('=N4-E4'), null);
  assert.ok(Number.isNaN(L.toNum('abc')));
});
test('행 읽기 — 실적 4행 + 계획만 2행, 범례 줄은 건너뜀, 미달 칸 = 양품 − 계획 이면 경고 없음', () => {
  const p = L.parseSheet(TINY, { fileName: 'tiny.xlsx' });
  assert.equal(p.records.length, 5);
  assert.equal(p.planOnly, 2);
  assert.deepEqual(p.warnings, []);
  const r = p.records[1];
  assert.equal(r.line, '2'); assert.equal(r.castLine, '2');
  assert.deepEqual(r.down, { A: 40, C: 30 });
  assert.equal(r.downNote, 'C:설비 점검(30)');
});
test('행 점검 — 총수량 ≠ 양품+폐기, 미달 칸이 수식과 다름, 숫자 아닌 값', () => {
  const bad = TINY.slice(0, 3).concat([row({ date: '2026-09-21', line: 1, pn: 'T-9', name: 'x', plan: 10, planHr: 1, workHr: 1, cast: '2026-09-21', total: 12, good: 9, scrap: 1, short: 5, down: { B: '가나' } })]);
  const p = L.parseSheet(bad);
  const msgs = p.warnings.map(w => w.msg).join('\n');
  assert.match(msgs, /총 수량\(12\) ≠ 양품\(9\) \+ 폐기\(1\)/);
  assert.match(msgs, /미달수량 칸\(5\)이 양품 − 계획수량\(-1\)/);
  assert.match(msgs, /비가동 B 칸/);
});

console.log('누적 · 중복 제거');
test('같은 파일을 두 번 넣어도 두 번 세지 않음(일자+호기+품번+주조일자)', () => {
  const p = L.parseSheet(TINY);
  const a = L.mergeRecords([], p.records);
  const b = L.mergeRecords(a.records, p.records);
  assert.equal(b.records.length, 5);
  assert.deepEqual(b.stat, { added: 0, updated: 5, superseded: 0, planSkipped: 0 });
});
test('다음 주 계획 행은 다음 주 실적 행이 오면 바뀜 · 뒤늦게 온 계획 행은 건너뜀', () => {
  const first = L.mergeRecords([], L.parseSheet(TINY).records).records;
  const next = [['x'], GROUP, HEAD,
    row({ date: '2026-09-28', line: 1, pn: 'T-100', name: '매니폴드', plan: 120, planHr: 10, workHr: 9, cast: '2026-09-28', castLine: 1, total: 100, good: 99, scrap: 1 })];
  const m = L.mergeRecords(first, L.parseSheet(next).records);
  assert.equal(m.stat.superseded, 1);
  assert.equal(m.records.filter(r => r.date === '2026-09-28').length, 1);
  const again = L.mergeRecords(m.records, L.parseSheet(TINY).records);
  assert.equal(again.stat.planSkipped, 1);
  assert.equal(again.records.filter(r => r.date === '2026-09-28').length, 1);
});

console.log('② 주간 결산');
test('품명 → 품번 합계 — 계획시간(근무)·실투입(작업)·계획·양품·폐기·미달(양품−계획)·행 수', () => {
  const recs = L.parseSheet(TINY).records;
  const s = L.summarize(recs, { from: '2026-09-21', to: '2026-09-27' });
  assert.equal(s.rows, 4); // 다음 주 계획 행은 빠짐
  assert.deepEqual(s.groups.map(g => g.name), ['매니폴드', '파이프']);
  const m = s.groups[0].items[0];
  assert.equal(m.partNo, 'T-100');
  assert.deepEqual([m.planHr, m.workHr, m.planQty, m.good, m.scrap, m.short, m.rows], [10, 15, 100, 158, 2, 58, 2]);
  const pipe = s.groups[1].sub;
  assert.deepEqual([pipe.planHr, pipe.workHr, pipe.planQty, pipe.good, pipe.scrap, pipe.short], [13, 4, 130, 37, 3, -93]);
  assert.deepEqual([s.total.planQty, s.total.good, s.total.scrap, s.total.short], [230, 195, 5, -35]);
  assert.equal(L.round(s.total.achieve, 4), L.round(195 / 230, 4));
  assert.equal(s.total.scrapRate, 5 / 200);
  assert.equal(s.total.down.A, 130);
  assert.deepEqual(s.codes, ['A', 'C']);
});
test('기준일은 주조일자 — 계획일이 다음 주여도 이번 주에 주조했으면 이번 주에 셈', () => {
  const aoa = [['x'], GROUP, HEAD, row({ date: '2026-09-28', line: 3, pn: 'T-5', name: 'p', plan: 50, planHr: 8, workHr: 3, cast: '2026-09-23', castLine: 3, total: 50, good: 50, scrap: 0 })];
  const recs = L.parseSheet(aoa).records;
  assert.equal(L.summarize(recs, { from: '2026-09-21', to: '2026-09-27' }).rows, 1);
  assert.equal(L.summarize(recs, { from: '2026-09-28', to: '2026-10-04' }).rows, 0);
});
test('엑셀 내보내기 표 — 머리에 비가동 코드 이름, 품명 합계·품번·총합계 행', () => {
  const s = L.summarize(L.parseSheet(TINY).records, { from: '2026-09-21', to: '2026-09-27' });
  const aoa = L.summaryToAoa(s, L.parseLegend(TINY));
  assert.ok(aoa[1].includes('비가동 A 셋팅 시간(분)'));
  assert.equal(aoa[aoa.length - 1][0], '총합계');
  assert.equal(aoa.length, 2 + 2 + 3 + 1);
});

console.log('샘플 8주 · ③ 이상 탐지');
let SREC = [], SLEG = {};
for (const f of Sample.build()) { const p = L.parseSheet(f.aoa, { fileName: f.fileName }); SREC = L.mergeRecords(SREC, p.records).records; SLEG = p.legend; }
const RULES = L.cleanRules({ planned: ['G', 'I'] });
test('샘플은 늘 같은 결과(씨앗 고정) · 8주 실적 + 다음 주 계획', () => {
  assert.deepEqual(L.producedWeeks(SREC).length, 8);
  assert.equal(L.weeksOf(SREC).length, 9);
  assert.equal(JSON.stringify(Sample.build()), JSON.stringify(Sample.build()));
  assert.ok(SREC.every(r => /^SMP-/.test(r.partNo) && (!r.worker || /^작업자[A-F]$/.test(r.worker))));
});
test('샘플 1~6주차에는 규칙에 걸리는 이상이 없음 (거짓 경보 0)', () => {
  for (const w of ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07']) {
    const an = L.detectAnomalies(SREC, w, RULES, SLEG).filter(a => a.kind !== 'nobase');
    assert.equal(an.length, 0, w + ': ' + an.map(a => a.id + ' ' + a.title).join(', '));
  }
});
test('심어 둔 이상 ① — 8주차 SMP-P202 폐기율 증가(경고), 근거 숫자 포함', () => {
  const an = L.detectAnomalies(SREC, '2026-09-21', RULES, SLEG);
  const a = an.find(x => x.scope === 'item' && x.id === 'SMP-P202' && x.kind === 'scrap');
  assert.ok(a, 'SMP-P202 폐기율 이상');
  assert.equal(a.level, '경고');
  assert.ok(a.current > 0.12 && a.baseline < 0.04);
  assert.equal(a.baseWeeks.length, 4);
  assert.match(L.evidence(a), /이번 주 1\d\.\d% · 기준선\(직전 4주 중앙값\) \d(\.\d)?% → \+1\d\.\d%p/);
});
test('심어 둔 이상 ② — 7·8주차 4호기 비가동 증가, 상위 코드 C(설비 이상)와 비가동내용', () => {
  for (const w of ['2026-09-14', '2026-09-21']) {
    const a = L.detectAnomalies(SREC, w, RULES, SLEG).find(x => x.scope === 'line' && x.id === '4' && x.kind === 'down');
    assert.ok(a, w + ' 4호기 비가동');
    assert.equal(a.topCodes[0].code, 'C');
    assert.equal(a.topCodes[0].name, '설비 이상');
    assert.ok(a.notes.some(n => n.includes('유압 누유')));
    assert.ok(a.related.length > 0, '4호기에서 돈 품목의 이상과 이어짐');
  }
  const other = L.detectAnomalies(SREC, '2026-09-21', RULES, SLEG).filter(x => x.scope === 'line' && x.kind === 'down' && x.id !== '4');
  assert.equal(other.length, 0);
});
test('기준을 바꾸면 결과가 바뀜 — 폐기율 기준 20%p 면 SMP-P202 도 안 걸림, 1%p 면 더 많이 걸림', () => {
  const strict = L.detectAnomalies(SREC, '2026-09-21', Object.assign({}, RULES, { scrapUp: 0.2 }), SLEG).filter(a => a.kind === 'scrap');
  assert.equal(strict.length, 0);
  const loose = L.detectAnomalies(SREC, '2026-09-21', Object.assign({}, RULES, { scrapUp: 0.01, scrapMin: 1 }), SLEG).filter(a => a.kind === 'scrap');
  assert.ok(loose.length > 2);
});
test('기준선 부족 — 첫 주는 비교하지 않고 「기준선 부족」으로만 표시', () => {
  const an = L.detectAnomalies(SREC, '2026-08-03', RULES, SLEG);
  assert.ok(an.length > 0 && an.every(a => a.kind === 'nobase'));
});
test('중앙값 · 기준 정리(음수·글자는 기본값)', () => {
  assert.equal(L.median([3, 1, 2]), 2);
  assert.equal(L.median([4, 1, 2, 3]), 2.5);
  assert.equal(L.median([null, undefined]), null);
  const r = L.cleanRules({ scrapUp: -1, baseWeeks: 'x', minBase: 9 });
  assert.equal(r.scrapUp, L.DEFAULT_RULES.scrapUp);
  assert.equal(r.baseWeeks, 4);
  assert.equal(r.minBase, 4);
});
test('계획정지 코드(G·I)는 비가동 비교에서 빠짐', () => {
  const recs = L.parseSheet(TINY).records;
  const a1 = L.aggregate(recs.filter(r => r.produced), ['C']);
  assert.equal(a1.downAll, 160); assert.equal(a1.downUnplanned, 130);
});

console.log('① 품목 · 호기 · AI 프롬프트 · ④ 보고서');
test('품목 주별 추이 — 8주, 생산 없는 주는 rows 0', () => {
  const s = L.itemWeekly(SREC, 'SMP-P202', '2026-09-21', 8);
  assert.equal(s.length, 8);
  assert.equal(s[7].week, '2026-09-21');
  assert.ok(s[7].scrapRate > s[6].scrapRate * 3);
});
test('호기별 비교 — 실제 주조호기 기준, 4호기 작업 1시간당 비가동이 가장 큼(8주차)', () => {
  const lines = L.byLine(SREC, { from: '2026-09-21', to: '2026-09-27', planned: ['G', 'I'] });
  assert.deepEqual(lines.map(x => x.line), ['1', '2', '3', '4', '5', '6']);
  const top = lines.slice().sort((a, b) => b.downPerHr - a.downPerHr)[0];
  assert.equal(top.line, '4');
});
test('AI 프롬프트 — 계산된 사실·근거만, 작업자 이름은 넣지 않음, 요청형', () => {
  const an = L.detectAnomalies(SREC, '2026-09-21', RULES, SLEG);
  const sum = L.summarize(SREC, { from: '2026-09-21', to: '2026-09-27' });
  const p = L.buildAiPrompt({ summary: sum, anomalies: an, rules: RULES, legend: SLEG });
  assert.match(p, /\[사실\]/);
  assert.match(p, /SMP-P202\(파이프\) — 폐기율 증가/);
  assert.match(p, /호기 4 — 비가동 증가/);
  assert.match(p, /「추정」/);
  assert.match(p, /정리해줘/);
  assert.ok(!/작업자[A-F]/.test(p), '작업자 이름 없음');
  assert.ok(p.includes('계획수량 ' + sum.total.planQty));
});
test('주간 보고서 — 총괄·품명별·주요 문제·호기·다음 주 계획·AI 의견', () => {
  const rep = L.buildReport(SREC, '2026-09-21', RULES, SLEG, '확인할 것: 4호기 유압');
  assert.match(rep.text, /^주조 주간 생산현황 보고 — 9월 4주차/);
  ['1. 총괄', '2. 품명별 실적', '3. 주요 문제', '4. 호기별 가동', '5. 다음 주 계획', '6. AI 분석 의견', '확인할 것: 4호기 유압'].forEach(s => assert.ok(rep.text.includes(s), s));
  assert.equal(rep.notDone.length, 1);
  assert.ok(rep.next.length > 20);
});
test('저장 형식 되살리기 — 이상한 값은 버리고 규칙은 정리', () => {
  const db = L.restoreDb({ records: [{ partNo: 'A', date: '2026-09-21', good: 1 }, { foo: 1 }], rules: { scrapUp: 'x' } });
  assert.equal(db.records.length, 1);
  assert.equal(db.records[0].produced, true);
  assert.equal(db.rules.scrapUp, L.DEFAULT_RULES.scrapUp);
});
test('엑셀로 썼다가 다시 읽어도 같은 결과 (SheetJS 왕복)', () => {
  const f = Sample.build()[7];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(f.aoa), 's');
  const back = XLSX.read(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }), { type: 'buffer', cellDates: true });
  const p1 = L.parseSheet(f.aoa), p2 = L.parseSheet(XLSX.utils.sheet_to_json(back.Sheets.s, { header: 1, raw: true, defval: null }));
  assert.equal(JSON.stringify(p1.records.map(r => [L.recKey(r), r.good, r.scrap, r.down])), JSON.stringify(p2.records.map(r => [L.recKey(r), r.good, r.scrap, r.down])));
});

console.log('\n' + passed + '개 통과' + (process.exitCode ? ' — 실패 있음' : ''));
