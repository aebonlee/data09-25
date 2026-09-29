/* 가상 샘플 — 8주치 주간 생산실적 파일 (실제 주간표와 같은 모양, 전부 지어낸 값)
   · 품번은 SMP-로 시작하는 가짜 번호, 작업자는 작업자A~F, 품명은 일반 명칭입니다.
   · 매주 파일 = 그 주 실적 행 + 다음 주 「계획만 있는 행」(실제 주간표처럼). 다음 주 파일이 오면 실적 행으로 바뀝니다.
   · 일부러 심어 둔 이상 두 가지 — 데모에서 ③ 이상 탐지가 바로 보이게:
       ① 품번 SMP-P202(파이프) — 8주차에 폐기율이 평소 약 2% → 약 14%로 뛴다
       ② 4호기 — 7·8주차에 설비 이상(C) 비가동이 늘어난다(유압 누유 점검)
   · 비가동 코드 범례도 실제 주간표처럼 파일 아래에 둡니다(코드 뜻은 일반적인 주조 비가동 분류로 새로 적음).
   브라우저에서는 window.CastSample, node 에서는 require('./sample-data.js'). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./logic.js'));
  else root.CastSample = factory(root.CastLogic);
})(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';

  var START = '2026-08-03';  // 1주차 월요일
  var WEEKS = 8;
  var ITEMS = [
    { pn: 'SMP-M101', name: '매니폴드', rate: 9, scrap: 0.015, kg: 3.2, lines: [4, 5] },
    { pn: 'SMP-M102', name: '매니폴드', rate: 7, scrap: 0.02, kg: 3.4, lines: [5] },
    { pn: 'SMP-M103', name: '매니폴드', rate: 11, scrap: 0.02, kg: 4.1, lines: [2] },
    { pn: 'SMP-P201', name: '파이프', rate: 13, scrap: 0.01, kg: 2.0, lines: [3] },
    { pn: 'SMP-P202', name: '파이프', rate: 12, scrap: 0.02, kg: 1.3, lines: [3, 6] },
    { pn: 'SMP-P203', name: '파이프', rate: 6, scrap: 0.03, kg: 9.0, lines: [6] },
    { pn: 'SMP-C301', name: '커버', rate: 20, scrap: 0.01, kg: 1.1, lines: [1] },
    { pn: 'SMP-C302', name: '커버', rate: 16, scrap: 0.015, kg: 0.7, lines: [1, 2] },
    { pn: 'SMP-B401', name: '브래킷', rate: 15, scrap: 0.01, kg: 1.6, lines: [4] },
    { pn: 'SMP-B402', name: '브래킷', rate: 14, scrap: 0.01, kg: 1.7, lines: [4, 5] }
  ];
  var WORKERS = { 1: '작업자A', 2: '작업자B', 3: '작업자C', 4: '작업자D', 5: '작업자E', 6: '작업자F' };
  var LEGEND = [
    ['A', '셋팅', '', '생산 전 준비(품번 교체·금형 교환·예열)'],
    ['B', '금형 이상', '', '금형·지그 문제로 생산 중단'],
    ['C', '설비 이상', '', '주조기·유압·전기 등 설비 고장'],
    ['D', '자재 대기', '', '원자재·부자재 결품'],
    ['E', '작업 대기', '', '작업자 부족 등으로 설비 대기'],
    ['F', '기타 작업', '', '보수·리워크·정리 등 표준 외 작업'],
    ['G', '회의', '계획정지', '정기 회의 등'],
    ['H', '결근', '', '연차·조퇴'],
    ['I', '교육', '계획정지', '안전·품질 교육'],
    ['J', '기타', '', '그 밖의 사유']
  ];
  var HEAD_GROUP = ['생산계획', '', '', '', '', '', '', '작업 배치', '', '', '', '', '작업수량', '', '', '비가동(분)', '', '', '', '', '', '', '', '', '', '', '중량', '', ''];
  var HEAD = ['일자', '호기', '품번', '품명', '계획수량', '근무(HR)', '초도품', '작업(HR)', '주조일자', '주조호기', '작업자', '가동시간', '총 수량', '양품', '폐기',
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', '비가동내용', 'ERP중량(kg)', '생산중량(kg)', '미달수량'];

  /* 같은 결과가 나오도록 씨앗이 있는 난수 */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0; var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function r1(x) { return Math.round(x * 10) / 10; }

  /* 주차 w(0부터)의 계획 — 월~금, 호기마다 하루 1~2품목 */
  function planWeek(w, rand) {
    var ws = L.addDays(START, 7 * w), out = [];
    for (var d = 0; d < 5; d++) {
      var day = L.addDays(ws, d);
      for (var line = 1; line <= 6; line++) {
        var cands = ITEMS.filter(function (it) { return it.lines.indexOf(line) >= 0; });
        var two = cands.length > 1 && rand() < 0.35;
        var picks = two ? [cands[0], cands[1]] : [cands[(w + d + line) % cands.length]];
        picks.forEach(function (it) {
          var hr = two ? 5 : 10;
          out.push({ day: day, line: line, it: it, planHr: hr, planQty: Math.round(it.rate * hr * (0.88 + rand() * 0.08) / 10) * 10 });
        });
      }
    }
    return out;
  }

  function actualRow(p, w, rand, isLastWeek) {
    var it = p.it, down = {}, note = '';
    down.A = 30 + Math.round(rand() * 3) * 10;                         // 셋팅 30~60분
    if (rand() < 0.06) { down.B = 20 + Math.round(rand() * 2) * 10; note = 'B:금형 냉각수 막힘 조치(' + down.B + ')'; }
    if (rand() < 0.04) { down.D = 20 + Math.round(rand() * 2) * 10; note = note || 'D:잉곳 입고 지연(' + down.D + ')'; }
    // 심어 둔 이상 ② — 4호기 7·8주차 설비 이상
    if (p.line === 4 && w >= 6) { down.C = 90 + Math.round(rand() * 6) * 10; note = 'C:유압 누유 점검(' + down.C + ')'; }
    else if (rand() < 0.03) { down.C = 30; note = note || 'C:센서 리셋(30)'; }
    var workHr = r1(p.planHr * (0.94 + rand() * 0.06));
    var downSum = Object.keys(down).reduce(function (s, k) { return s + down[k]; }, 0);
    var runMin = Math.max(0, Math.round(workHr * 60 - downSum));
    var total = Math.round(it.rate * runMin / 60 * (0.97 + rand() * 0.06));
    var sr = it.scrap * (0.5 + rand());
    // 심어 둔 이상 ① — SMP-P202 8주차 폐기율 급증
    if (it.pn === 'SMP-P202' && isLastWeek) sr = 0.13 + rand() * 0.03;
    var scrap = Math.round(total * sr);
    if (it.pn === 'SMP-P202' && isLastWeek && !note) note = 'F:기공 불량 선별(' + (down.F = 40) + ')';
    var good = total - scrap;
    var row = [p.day, p.line, it.pn, it.name, p.planQty, p.planHr, 'X', workHr, p.day, p.line, WORKERS[p.line], runMin, total, good, scrap];
    'ABCDEFGHIJ'.split('').forEach(function (c) { row.push(down[c] || null); });
    row.push(note || null, it.kg, r1(it.kg * total), good - p.planQty);
    return row;
  }
  function planRow(p) {
    var row = [p.day, p.line, p.it.pn, p.it.name, p.planQty, p.planHr, 'X', null, null, null, null, null, null, null, null];
    for (var i = 0; i < 10; i++) row.push(null);
    row.push(null, p.it.kg, null, null);
    return row;
  }

  /* 8개 파일 — [{ fileName, week, aoa }]. 날짜는 'YYYY-MM-DD' 글자로 둡니다(엑셀로 쓰면 앱이 날짜로 읽음). */
  function build() {
    var rand = rng(20260929);
    var plans = [];
    for (var w = 0; w <= WEEKS; w++) plans.push(planWeek(w, rand));
    var files = [];
    for (var k = 0; k < WEEKS; k++) {
      var aoa = [['■ 주조 생산현황 (가상 샘플)'], HEAD_GROUP.slice(), HEAD.slice()];
      var rows = plans[k].map(function (p) { return actualRow(p, k, rand, k === WEEKS - 1); });
      // 8주차: 계획했지만 설비 사정으로 못 한 행 하나(실제 주간표에도 있는 모양)
      if (k === WEEKS - 1) { var idx = rows.length - 1; rows[idx] = planRow(plans[k][idx]); }
      rows = rows.concat(plans[k + 1].map(planRow));
      aoa = aoa.concat(rows);
      aoa.push([]);
      var legendHead = []; legendHead[13] = 'Code'; legendHead[14] = '항목'; legendHead[16] = '비가동의 정의';
      aoa.push(legendHead);
      LEGEND.forEach(function (x) { var r = []; r[13] = x[0]; r[14] = x[1]; if (x[2]) r[15] = x[2]; r[16] = x[3]; aoa.push(r); });
      var ws = L.addDays(START, 7 * k);
      files.push({ fileName: '주조_생산실적_샘플_' + (k + 1 < 10 ? '0' : '') + (k + 1) + '주차_' + ws.slice(5).replace('-', '') + '.xlsx', week: ws, aoa: aoa });
    }
    return files;
  }

  return { START: START, WEEKS: WEEKS, ITEMS: ITEMS, build: build, HEAD: HEAD, HEAD_GROUP: HEAD_GROUP };
});
