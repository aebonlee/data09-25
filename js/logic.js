/* 주조 생산실적 분석 — 순수 로직 (화면·저장소와 무관)
   브라우저에서는 window.CastLogic, node 에서는 require('./logic.js') 로 씁니다.
   기준 문서: docs/01_프로젝트_기획서.md (3장 데이터, 5장 기능, 8장 1단계)

   흐름: 주간 엑셀(2줄 머리행) → detectColumns(열 찾기) → parseRows(행 → 실적 기록)
        → mergeRecords(여러 주 누적·중복 제거) → summarize(주간 결산) · itemWeekly(품목 추이)
        · byLine(호기 비교) · detectAnomalies(이상 탐지) · buildAiPrompt · buildReport */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CastLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 1;

  /* ── 1. 열 이름 ────────────────────────────────────────────────
     머리행 글자를 공백·괄호·가운데점을 빼고 소문자로 맞춘 뒤 아래 별칭과 비교합니다.
     실제 주간표의 머리행: 일자 · 호기 · 품번 · 품명 · 계획수량 · 근무(HR) · 초도품 · 작업(HR) · 주조일자 ·
     주조호기 · 작업자 · 가동시간 · 총 수량 · 양품 · 폐기 · A~J · 비가동내용 · ERP중량(kg) · 생산중량(kg) · 미달수량 */
  var FIELDS = [
    { id: 'date', label: '일자(계획일)', req: true, aliases: ['일자', '계획일자', '생산일자', '날짜', '계획일'] },
    { id: 'line', label: '호기(계획)', req: true, aliases: ['호기', '계획호기', '설비', '설비호기'] },
    { id: 'partNo', label: '품번', req: true, aliases: ['품번', '품목코드', '품목번호', 'partno', 'p/n', 'pn'] },
    { id: 'partName', label: '품명', req: false, aliases: ['품명', '품목명', '품목'] },
    { id: 'planQty', label: '계획수량', req: true, aliases: ['계획수량', '계획량', '계획'] },
    { id: 'planHr', label: '근무(HR) = 계획시간', req: false, aliases: ['근무hr', '근무', '근무시간', '계획시간', '계획시간hr'] },
    { id: 'first', label: '초도품', req: false, aliases: ['초도품', '초도'] },
    { id: 'workHr', label: '작업(HR) = 실투입시간', req: false, aliases: ['작업hr', '작업시간', '작업시간hr', '실투입시간', '실투입시간hr', '투입시간'] },
    { id: 'castDate', label: '주조일자(실적일)', req: false, aliases: ['주조일자', '작업일자', '실적일자', '생산실적일자'] },
    { id: 'castLine', label: '주조호기(실제 호기)', req: false, aliases: ['주조호기', '작업호기', '실적호기'] },
    { id: 'worker', label: '작업자', req: false, aliases: ['작업자', '작업자명'] },
    { id: 'runMin', label: '가동시간(분)', req: false, aliases: ['가동시간', '가동시간분', '가동분'] },
    { id: 'total', label: '총 수량', req: false, aliases: ['총수량', '생산수량', '총생산수량', '총생산'] },
    { id: 'good', label: '양품', req: true, aliases: ['양품', '양품수량'] },
    { id: 'scrap', label: '폐기', req: false, aliases: ['폐기', '폐기수량', '불량', '불량수량'] },
    { id: 'downNote', label: '비가동내용', req: false, aliases: ['비가동내용', '비가동사유', '비가동내역'] },
    { id: 'erpKg', label: 'ERP중량(kg)', req: false, aliases: ['erp중량kg', 'erp중량'] },
    { id: 'prodKg', label: '생산중량(kg)', req: false, aliases: ['생산중량kg', '생산중량'] },
    { id: 'short', label: '미달수량', req: false, aliases: ['미달수량', '미달'] }
  ];
  var FIELD_BY_ID = {};
  FIELDS.forEach(function (f) { FIELD_BY_ID[f.id] = f; });

  /* 비가동 코드 — 코드 이름은 파일 안의 범례(Code · 항목 · 비가동의 정의)를 읽어 채웁니다.
     범례가 없으면 「A 코드」처럼 코드만 보여 줍니다(뜻을 지어내지 않음). */
  /* 호기 — 1~6호기(2026-09-30 수강생 확인). 이 밖의 값은 오타일 수 있어 가져오기에서 알립니다(반영은 함) */
  var KNOWN_LINES = ['1', '2', '3', '4', '5', '6'];
  var DEFAULT_PLANNED = []; // 계획정지 코드 — 범례에 「계획정지」 표시가 있으면 거기서 채웁니다

  function norm(s) {
    return String(s == null ? '' : s).replace(/[\s()（）\[\]·.:_]/g, '').toLowerCase();
  }
  function str(v) { return v == null ? '' : String(v).trim(); }

  /* ── 2. 숫자·날짜 ─────────────────────────────────────────── */
  /* 빈칸·공백은 null, 숫자로 못 읽으면 NaN(경고용) */
  function toNum(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (typeof v === 'boolean') return NaN;
    var s = String(v).trim();
    if (!s || s === '-') return null;
    if (s.charAt(0) === '=') return null; // 계산값이 저장되지 않은 수식
    s = s.replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }
  function round(n, d) { var p = Math.pow(10, d == null ? 2 : d); return Math.round(n * p) / p; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoFromUTC(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function isoOk(y, m, d) {
    if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    var t = Date.UTC(y, m - 1, d); var x = new Date(t);
    return x.getUTCMonth() === m - 1 ? isoFromUTC(t) : '';
  }
  /* 엑셀 날짜(일련번호 · Date · 글자) → 'YYYY-MM-DD'. 못 읽으면 ''.
     Date 는 시간대 때문에 전날 23:59 로 들어오는 일이 있어 12시간을 더해 날짜만 씁니다. */
  function toISO(v, defaultYear) {
    if (v == null || v === '') return '';
    if (v instanceof Date || Object.prototype.toString.call(v) === '[object Date]') {
      if (isNaN(v.getTime())) return '';
      var d = new Date(v.getTime() + 12 * 3600 * 1000);
      return isoOk(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
    if (typeof v === 'number') {
      if (v < 20000 || v > 80000) return '';
      return isoFromUTC(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    }
    var s = String(v).trim();
    var m = /^(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})/.exec(s);
    if (m) return isoOk(+m[1], +m[2], +m[3]);
    m = /^(\d{2})[-./](\d{1,2})[-./](\d{1,2})$/.exec(s);
    if (m) return isoOk(2000 + +m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[-./월\s]+(\d{1,2})일?$/.exec(s);
    if (m && defaultYear) return isoOk(defaultYear, +m[1], +m[2]);
    if (/^\d{5}(\.\d+)?$/.test(s)) return toISO(Number(s));
    return '';
  }
  function isoToUTC(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function addDays(iso, n) { return isoFromUTC(isoToUTC(iso) + n * 86400000); }
  /* 주의 시작(월요일) */
  function weekStart(iso) {
    if (!iso) return '';
    var dow = new Date(isoToUTC(iso)).getUTCDay(); // 0=일
    return addDays(iso, -((dow + 6) % 7));
  }
  function weekEnd(ws) { return addDays(ws, 6); }
  /* 「9월 4주차」 — 그 주 목요일이 속한 달의 몇 번째 주인가(월 경계 주는 목요일 기준).
     실제 파일 「9-4 주조 생산실적」(09/21~ 주)이 9월 4주차이므로 이 규칙과 맞습니다(09/01 이 화요일). */
  function weekLabel(ws) {
    if (!ws) return '';
    var p = addDays(ws, 3).split('-'); var nth = Math.floor((+p[2] - 1) / 7) + 1;
    return (+p[1]) + '월 ' + nth + '주차 (' + ws.slice(5).replace('-', '/') + '~' + weekEnd(ws).slice(5).replace('-', '/') + ')';
  }
  function lineKey(v) {
    if (v == null || v === '') return '';
    var n = toNum(v);
    return (n != null && !isNaN(n)) ? String(n) : str(v);
  }

  /* ── 3. 머리행 찾기 ────────────────────────────────────────── */
  function matchField(text) {
    var n = norm(text);
    if (!n) return null;
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].aliases.indexOf(n) >= 0) return FIELDS[i].id;
    return null;
  }
  function isCodeHeader(text) { return /^[A-Z]$/.test(str(text).toUpperCase()) && str(text).length === 1; }

  /* aoa: 시트를 행 배열로 읽은 것(SheetJS sheet_to_json header:1).
     반환: { headerRow, groupRow, map:{field:col}, downCols:[{code,col}], headers:[글자], missing:[field], warnings:[] } */
  function detectColumns(aoa, overrides) {
    var best = -1, bestScore = 0, limit = Math.min(aoa.length, 20);
    for (var r = 0; r < limit; r++) {
      var row = aoa[r] || [], seen = {}, score = 0;
      for (var c = 0; c < row.length; c++) {
        var f = matchField(row[c]);
        if (f && !seen[f]) { seen[f] = 1; score++; }
      }
      if (score > bestScore && (seen.partNo || seen.partName) && (seen.good || seen.planQty)) { best = r; bestScore = score; }
    }
    var out = { headerRow: best, groupRow: -1, map: {}, downCols: [], headers: [], groups: [], missing: [], warnings: [] };
    if (best < 0 || bestScore < 4) {
      out.headerRow = -1;
      out.warnings.push('머리행(일자·품번·계획수량·양품 …)을 찾지 못했습니다. 주조 생산실적 시트인지 확인해 주세요.');
      FIELDS.forEach(function (f) { if (f.req) out.missing.push(f.id); });
      return out;
    }
    var hdr = aoa[best] || [];
    var width = 0;
    for (var k = best; k < Math.min(aoa.length, best + 3); k++) width = Math.max(width, (aoa[k] || []).length);
    width = Math.max(width, hdr.length);
    // 윗줄 = 묶음 머리(생산계획·작업 배치·작업수량·비가동(분)·중량). 병합 칸은 왼쪽 첫 칸에만 글자가 있어 오른쪽으로 채웁니다.
    var groups = [];
    if (best > 0) {
      var g = aoa[best - 1] || [], cur = '', any = false;
      for (var c2 = 0; c2 < width; c2++) {
        if (str(g[c2])) { cur = str(g[c2]); any = true; }
        groups.push(cur);
      }
      if (any) out.groupRow = best - 1; else groups = [];
    }
    out.groups = groups;
    for (var c3 = 0; c3 < width; c3++) {
      var text = str(hdr[c3]);
      out.headers.push(text);
      var fid = matchField(text);
      if (fid && out.map[fid] == null) out.map[fid] = c3;
      else if (fid) out.warnings.push('「' + text + '」 열이 두 번 나옵니다. 앞의 것(' + colName(out.map[fid]) + ')을 씁니다.');
      else if (isCodeHeader(text)) {
        var grp = groups[c3] || '';
        if (!groups.length || /비가동|정지|loss/i.test(grp)) out.downCols.push({ code: text.toUpperCase(), col: c3 });
      }
    }
    // 사용자가 고른 연결이 있으면 덮어씁니다 (값 -1 = 이 파일에는 없음)
    if (overrides) Object.keys(overrides).forEach(function (fid) {
      if (!FIELD_BY_ID[fid]) return;
      var v = overrides[fid];
      if (v === -1 || v === '' || v == null) delete out.map[fid]; else out.map[fid] = Number(v);
    });
    FIELDS.forEach(function (f) { if (f.req && out.map[f.id] == null) out.missing.push(f.id); });
    if (out.missing.length) out.warnings.push('꼭 필요한 열이 없습니다: ' + out.missing.map(function (id) { return FIELD_BY_ID[id].label; }).join(', ') + ' — 열 연결에서 골라 주세요.');
    if (out.map.castDate == null) out.warnings.push('주조일자 열이 없어 일자(계획일)로 주를 나눕니다.');
    if (!out.downCols.length) out.warnings.push('비가동(분) 코드 열(A·B·C …)을 찾지 못했습니다. 비가동 분석이 비어 보입니다.');
    return out;
  }
  function colName(i) {
    var s = ''; i = Number(i);
    do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
    return s;
  }

  /* 파일 아래쪽의 비가동 코드 범례(Code · 항목 · [계획정지] · 비가동의 정의)를 읽습니다 */
  function parseLegend(aoa) {
    var legend = {};
    for (var r = 0; r < aoa.length; r++) {
      var row = aoa[r] || [];
      for (var c = 0; c < row.length; c++) {
        if (norm(row[c]) !== 'code') continue;
        for (var r2 = r + 1; r2 < aoa.length; r2++) {
          var rr = aoa[r2] || [], code = str(rr[c]).toUpperCase();
          if (!/^[A-Z]$/.test(code)) break;
          var rest = [];
          for (var c2 = c + 1; c2 < rr.length; c2++) if (str(rr[c2])) rest.push(str(rr[c2]));
          var planned = rest.indexOf('계획정지') >= 0;
          rest = rest.filter(function (x) { return x !== '계획정지'; });
          legend[code] = { code: code, name: rest[0] || '', def: rest.slice(1).join(' / '), planned: planned };
        }
        return legend;
      }
    }
    return legend;
  }

  /* ── 4. 행 → 실적 기록 ─────────────────────────────────────── */
  function isProduced(rec) {
    return !!rec.castDate || [rec.workHr, rec.total, rec.good, rec.scrap].some(function (v) { return v != null && v !== 0; });
  }
  function recKey(rec) { return [rec.date, rec.line, rec.partNo, rec.castDate].join('|'); }
  function planKey(rec) { return [rec.date, rec.line, rec.partNo].join('|'); }

  /* opts: { fileName, defaultYear } → { records, warnings:[{row, msg}], skipped } */
  function parseRows(aoa, det, opts) {
    opts = opts || {};
    var out = { records: [], warnings: [], skipped: 0, planOnly: 0 };
    if (!det || det.headerRow < 0 || det.missing.length) return out;
    var m = det.map;
    var year = opts.defaultYear || guessYear(aoa, det) || new Date().getFullYear();
    function cell(row, fid) { return m[fid] == null ? null : row[m[fid]]; }
    function num(row, fid, r, label) {
      var v = toNum(cell(row, fid));
      if (v != null && isNaN(v)) { out.warnings.push({ row: r + 1, msg: (label || FIELD_BY_ID[fid].label) + ' 칸 「' + str(cell(row, fid)) + '」 을 숫자로 읽지 못해 비워 둡니다.' }); return null; }
      return v;
    }
    var seen = {};
    for (var r = det.headerRow + 1; r < aoa.length; r++) {
      var row = aoa[r] || [];
      var partNo = str(cell(row, 'partNo'));
      var rawDate = cell(row, 'date');
      if (!partNo && (rawDate == null || rawDate === '')) continue; // 빈 줄·범례 줄
      if (!partNo) { out.skipped++; out.warnings.push({ row: r + 1, msg: '품번이 비어 있어 건너뜁니다.' }); continue; }
      var date = toISO(rawDate, year);
      var castDate = toISO(cell(row, 'castDate'), year);
      if (!date && castDate) date = castDate;
      if (!date) { out.skipped++; out.warnings.push({ row: r + 1, msg: '일자 「' + str(rawDate) + '」 를 날짜로 읽지 못해 건너뜁니다.' }); continue; }
      var rec = {
        date: date,
        line: lineKey(cell(row, 'line')),
        partNo: partNo,
        partName: str(cell(row, 'partName')) || '(품명 없음)',
        planQty: num(row, 'planQty', r),
        planHr: num(row, 'planHr', r),
        first: str(cell(row, 'first')),
        workHr: num(row, 'workHr', r),
        castDate: castDate,
        castLine: lineKey(cell(row, 'castLine')),
        worker: str(cell(row, 'worker')),
        runMin: num(row, 'runMin', r),
        total: num(row, 'total', r),
        good: num(row, 'good', r),
        scrap: num(row, 'scrap', r),
        down: {},
        downNote: str(cell(row, 'downNote')),
        erpKg: num(row, 'erpKg', r),
        prodKg: num(row, 'prodKg', r),
        file: opts.fileName || ''
      };
      det.downCols.forEach(function (dc) {
        var v = toNum(row[dc.col]);
        if (v != null && isNaN(v)) { out.warnings.push({ row: r + 1, msg: '비가동 ' + dc.code + ' 칸 「' + str(row[dc.col]) + '」 을 숫자로 읽지 못했습니다.' }); return; }
        if (v) rec.down[dc.code] = v;
      });
      rec.produced = isProduced(rec);
      if (!rec.produced) out.planOnly++;
      // 점검: 총 수량 = 양품 + 폐기 · 미달수량 = 양품 − 계획수량
      if (rec.total != null && (rec.good != null || rec.scrap != null) && rec.total !== (rec.good || 0) + (rec.scrap || 0))
        out.warnings.push({ row: r + 1, msg: '총 수량(' + rec.total + ') ≠ 양품(' + (rec.good || 0) + ') + 폐기(' + (rec.scrap || 0) + ')' });
      var shortCell = num(row, 'short', r);
      if (shortCell != null && rec.produced && shortCell !== (rec.good || 0) - (rec.planQty || 0))
        out.warnings.push({ row: r + 1, msg: '미달수량 칸(' + shortCell + ')이 양품 − 계획수량(' + ((rec.good || 0) - (rec.planQty || 0)) + ')과 다릅니다. 이 도구는 양품 − 계획수량으로 계산합니다.' });
      [['호기', rec.line], ['주조호기', rec.castLine]].forEach(function (x) {
        if (x[1] && KNOWN_LINES.indexOf(x[1]) < 0) out.warnings.push({ row: r + 1, msg: x[0] + ' 「' + x[1] + '」 은 1~6호기 밖입니다. 오타가 아닌지 확인해 주세요(반영은 됩니다).' });
      });
      if (rec.produced && rec.good != null && rec.workHr == null) out.warnings.push({ row: r + 1, msg: '양품은 있는데 작업(HR)이 비어 있어 시간당 생산량에서 빠집니다.' });
      var k = recKey(rec);
      if (seen[k]) out.warnings.push({ row: r + 1, msg: '같은 파일 안에 일자·호기·품번·주조일자가 같은 행이 또 있습니다(' + seen[k] + '행). 뒤의 행으로 덮어씁니다.' });
      seen[k] = r + 1;
      out.records.push(rec);
    }
    return out;
  }
  function guessYear(aoa, det) {
    var m = det.map;
    for (var r = det.headerRow + 1; r < Math.min(aoa.length, det.headerRow + 60); r++) {
      var row = aoa[r] || [];
      var d = toISO(m.date != null ? row[m.date] : null) || toISO(m.castDate != null ? row[m.castDate] : null);
      if (d) return +d.slice(0, 4);
    }
    return 0;
  }

  /* 시트 하나를 한 번에 — 앱과 테스트가 같은 길을 씁니다 */
  function parseSheet(aoa, opts) {
    opts = opts || {};
    var det = detectColumns(aoa, opts.overrides);
    var res = parseRows(aoa, det, opts);
    return { det: det, records: res.records, warnings: res.warnings, skipped: res.skipped, planOnly: res.planOnly, legend: parseLegend(aoa) };
  }
  /* 여러 시트 중 실적 시트 고르기 — 머리행 점수가 가장 높은 시트(요약·피벗 시트는 품번 열이 없어 빠짐) */
  function pickSheet(sheets) {
    var best = null, bestN = -1;
    sheets.forEach(function (s) {
      var det = detectColumns(s.aoa);
      var n = det.headerRow < 0 ? -1 : Object.keys(det.map).length + det.downCols.length;
      if (n > bestN) { bestN = n; best = s; }
    });
    return bestN < 0 ? null : best;
  }

  /* ── 5. 누적 · 중복 제거 ───────────────────────────────────────
     같은 행 = 일자 + 호기 + 품번 + 주조일자. 다시 가져오면 새 값으로 바꿉니다.
     주간표에는 다음 주 「계획만 있는 행」(주조일자·실적 없음)이 함께 들어 있어서,
     다음 주 파일에서 같은 일자·호기·품번의 실적 행이 오면 계획 행을 실적 행으로 대신합니다. */
  function mergeRecords(existing, incoming) {
    var byKey = {}, order = [];
    (existing || []).forEach(function (r) { var k = recKey(r); if (!byKey[k]) order.push(k); byKey[k] = r; });
    var stat = { added: 0, updated: 0, superseded: 0, planSkipped: 0 };
    var producedPlan = {};
    Object.keys(byKey).forEach(function (k) { var r = byKey[k]; if (r.produced) producedPlan[planKey(r)] = 1; });
    (incoming || []).forEach(function (r) {
      var k = recKey(r), pk = planKey(r);
      if (r.produced) {
        var planOnlyKey = pk + '|';
        if (k !== planOnlyKey && byKey[planOnlyKey] && !byKey[planOnlyKey].produced) { delete byKey[planOnlyKey]; stat.superseded++; }
        producedPlan[pk] = 1;
      } else if (producedPlan[pk]) { stat.planSkipped++; return; }
      if (byKey[k]) stat.updated++; else { stat.added++; order.push(k); }
      byKey[k] = r;
    });
    var records = [];
    order.forEach(function (k) { if (byKey[k]) { records.push(byKey[k]); delete byKey[k]; } });
    return { records: sortRecords(records), stat: stat };
  }
  function sortRecords(list) {
    return list.slice().sort(function (a, b) {
      return cmp(baseDate(a), baseDate(b)) || cmp(a.line, b.line) || cmp(a.partNo, b.partNo) || cmp(a.date, b.date);
    });
  }
  function cmp(a, b) { a = a == null ? '' : String(a); b = b == null ? '' : String(b); return a < b ? -1 : a > b ? 1 : 0; }
  /* 기준일 = 실제로 주조한 날(주조일자). 아직 주조하지 않은 계획 행은 일자(계획일). */
  function baseDate(r) { return r.castDate || r.date; }
  function machine(r) { return r.castLine || r.line || '(호기 없음)'; }
  function inRange(r, from, to) { var d = baseDate(r); return (!from || d >= from) && (!to || d <= to); }
  function weeksOf(records) {
    var s = {};
    records.forEach(function (r) { s[weekStart(baseDate(r))] = 1; });
    return Object.keys(s).sort();
  }
  function producedWeeks(records) {
    var s = {};
    records.forEach(function (r) { if (r.produced) s[weekStart(baseDate(r))] = 1; });
    return Object.keys(s).sort();
  }

  /* ── 6. 합계와 비율 ────────────────────────────────────────── */
  function emptyAgg() {
    return { planHr: 0, workHr: 0, planQty: 0, good: 0, scrap: 0, total: 0, short: 0, rows: 0, produced: 0, runMin: 0, down: {}, downAll: 0, downUnplanned: 0, notes: [] };
  }
  function addAgg(a, r, planned) {
    a.planHr += r.planHr || 0; a.workHr += r.workHr || 0; a.planQty += r.planQty || 0;
    a.good += r.good || 0; a.scrap += r.scrap || 0;
    a.total += r.total != null ? r.total : (r.good || 0) + (r.scrap || 0);
    a.short += (r.good || 0) - (r.planQty || 0); // 미달수량 = 양품 − 계획수량 (실제 주간표의 수식 =N−E)
    a.rows++; if (r.produced) a.produced++;
    a.runMin += r.runMin || 0;
    Object.keys(r.down || {}).forEach(function (c) {
      a.down[c] = (a.down[c] || 0) + r.down[c];
      a.downAll += r.down[c];
      if (!planned || planned.indexOf(c) < 0) a.downUnplanned += r.down[c];
    });
    if (r.downNote) a.notes.push(r.downNote);
    return a;
  }
  function fix(a) {
    ['planHr', 'workHr', 'runMin'].forEach(function (k) { a[k] = round(a[k], 2); });
    a.achieve = a.planQty > 0 ? a.good / a.planQty : null;             // 달성률 = 양품 ÷ 계획수량
    a.scrapRate = (a.good + a.scrap) > 0 ? a.scrap / (a.good + a.scrap) : null; // 폐기율 = 폐기 ÷ (양품 + 폐기)
    a.goodRate = (a.good + a.scrap) > 0 ? a.good / (a.good + a.scrap) : null;
    a.perHour = a.workHr > 0 ? a.good / a.workHr : null;               // 시간당 양품 = 양품 ÷ 작업(HR)
    a.downPerHr = a.workHr > 0 ? a.downUnplanned / a.workHr : null;     // 작업 1시간당 비가동(분, 계획정지 제외)
    a.timeUse = a.planHr > 0 ? a.workHr / a.planHr : null;
    return a;
  }
  function aggregate(list, planned) { var a = emptyAgg(); list.forEach(function (r) { addAgg(a, r, planned); }); return fix(a); }

  /* ② 주간 생산결산 — 품명 → 품번 두 단계(실제 요약 시트와 같은 모양) */
  function summarize(records, opts) {
    opts = opts || {};
    var list = records.filter(function (r) { return inRange(r, opts.from, opts.to); });
    var planned = opts.planned || DEFAULT_PLANNED;
    var groups = {}, codes = {};
    list.forEach(function (r) {
      var g = groups[r.partName] || (groups[r.partName] = { name: r.partName, items: {}, list: [] });
      g.list.push(r);
      (g.items[r.partNo] || (g.items[r.partNo] = [])).push(r);
      Object.keys(r.down || {}).forEach(function (c) { codes[c] = 1; });
    });
    var out = Object.keys(groups).sort(cmp).map(function (name) {
      var g = groups[name];
      return {
        name: name,
        sub: aggregate(g.list, planned),
        items: Object.keys(g.items).sort(cmp).map(function (pn) {
          var a = aggregate(g.items[pn], planned); a.partNo = pn; a.partName = name;
          a.lines = uniq(g.items[pn].map(machine)); return a;
        })
      };
    });
    return { from: opts.from || '', to: opts.to || '', groups: out, total: aggregate(list, planned), codes: Object.keys(codes).sort(), rows: list.length };
  }
  function uniq(a) { var s = {}, o = []; a.forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o.sort(cmp); }

  /* 품목 목록(품번 → 최근 품명·행 수) */
  function itemList(records) {
    var m = {};
    records.forEach(function (r) {
      var it = m[r.partNo] || (m[r.partNo] = { partNo: r.partNo, partName: r.partName, rows: 0, last: '' });
      it.rows++; if (baseDate(r) >= it.last) { it.last = baseDate(r); if (r.partName && r.partName !== '(품명 없음)') it.partName = r.partName; }
    });
    return Object.keys(m).sort(cmp).map(function (k) { return m[k]; });
  }

  /* ① 품목 주별 추이 — endWeek 까지 n주 (생산이 없던 주도 빈칸으로 둡니다) */
  function itemWeekly(records, partNo, endWeek, n, planned) {
    var out = [];
    for (var i = n - 1; i >= 0; i--) {
      var ws = addDays(endWeek, -7 * i), we = weekEnd(ws);
      var list = records.filter(function (r) { return (!partNo || r.partNo === partNo) && inRange(r, ws, we); });
      var a = aggregate(list, planned); a.week = ws; a.label = weekLabel(ws);
      out.push(a);
    }
    return out;
  }

  /* 호기별 비교 — 실제로 주조한 호기(주조호기, 없으면 호기) 기준 */
  function byLine(records, opts) {
    opts = opts || {};
    var m = {};
    records.forEach(function (r) {
      if (!inRange(r, opts.from, opts.to)) return;
      if (opts.partNo && r.partNo !== opts.partNo) return;
      if (!r.produced) return;
      (m[machine(r)] || (m[machine(r)] = [])).push(r);
    });
    return Object.keys(m).sort(function (a, b) { return (Number(a) - Number(b)) || cmp(a, b); }).map(function (k) {
      var a = aggregate(m[k], opts.planned); a.line = k; a.items = uniq(m[k].map(function (r) { return r.partNo; })).length; return a;
    });
  }

  function topCodes(agg, legend, n) {
    return Object.keys(agg.down).map(function (c) {
      var L = legend && legend[c];
      return { code: c, name: L && L.name ? L.name : '', planned: !!(L && L.planned), min: round(agg.down[c], 1) };
    }).sort(function (a, b) { return b.min - a.min; }).slice(0, n || 3);
  }
  function topNotes(notes, n) {
    var m = {};
    notes.forEach(function (s) { m[s] = (m[s] || 0) + 1; });
    return Object.keys(m).sort(function (a, b) { return m[b] - m[a]; }).slice(0, n || 3).map(function (s) { return m[s] > 1 ? s + ' (' + m[s] + '회)' : s; });
  }

  /* ── 7. ③ 이상 탐지 (규칙) ───────────────────────────────────
     기준선 = 대상 주 직전 N주 가운데 그 품목(호기)이 생산된 주의 값의 중앙값.
     직전 주가 minBase 주보다 적으면 비교하지 않습니다(근거 부족). */
  var DEFAULT_RULES = {
    baseWeeks: 4,         // 기준선에 쓸 직전 주 수
    minBase: 2,           // 기준선에 필요한 최소 주 수
    perHourDrop: 0.20,    // 시간당 양품이 기준선보다 20% 이상 낮으면
    achieveDrop: 0.15,    // 달성률이 기준선보다 15%p 이상 낮으면
    scrapUp: 0.03,        // 폐기율이 기준선보다 3%p 이상 높으면
    scrapMin: 3,          // …그리고 이번 주 폐기가 3개 이상일 때만
    downUp: 0.7,          // 작업 1시간당 비가동(분)이 기준선보다 70% 이상 늘면
    downMin: 120,         // …그리고 기준선 대비 늘어난 비가동이 120분 이상일 때만
    minWorkHr: 2          // 이번 주 작업이 2시간 미만이면 비율 비교를 하지 않음(표본이 너무 작음)
  };
  function cleanRules(p) {
    var r = {}; p = p || {};
    Object.keys(DEFAULT_RULES).forEach(function (k) {
      var v = Number(p[k]);
      r[k] = isFinite(v) && v >= 0 ? v : DEFAULT_RULES[k];
    });
    r.baseWeeks = Math.max(1, Math.min(12, Math.round(r.baseWeeks)));
    r.minBase = Math.max(1, Math.min(r.baseWeeks, Math.round(r.minBase)));
    r.planned = Array.isArray(p.planned) ? p.planned.slice() : [];
    return r;
  }
  function median(a) {
    var s = a.filter(function (x) { return x != null && isFinite(x); }).sort(function (x, y) { return x - y; });
    if (!s.length) return null;
    var h = Math.floor(s.length / 2);
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  function detectAnomalies(records, week, rulesIn, legend) {
    var R = cleanRules(rulesIn);
    var planned = R.planned;
    var out = [];
    if (!week) return out;
    var we = weekEnd(week);
    var prevWeeks = [];
    for (var i = 1; i <= R.baseWeeks; i++) prevWeeks.push(addDays(week, -7 * i));
    function weekAgg(filter, ws) {
      return aggregate(records.filter(function (r) { return r.produced && filter(r) && inRange(r, ws, weekEnd(ws)); }), planned);
    }
    function check(scope, id, name, filter) {
      var curList = records.filter(function (r) { return filter(r) && inRange(r, week, we); });
      var cur = aggregate(curList, planned);
      if (!cur.produced) return;
      var curLines = uniq(curList.filter(function (r) { return r.produced; }).map(machine));
      var base = prevWeeks.map(function (ws) { var a = weekAgg(filter, ws); a.week = ws; return a; }).filter(function (a) { return a.produced > 0; });
      var basis = { weeks: base.map(function (a) { return a.week; }), n: base.length };
      function push(kind, title, curV, baseV, unit, ratioOver, extra) {
        var o = {
          kind: kind, scope: scope, id: id, name: name, title: title, week: week, lines: curLines, related: [],
          current: curV, baseline: baseV, unit: unit, baseWeeks: basis.weeks,
          level: ratioOver >= 2 ? '경고' : '주의',
          facts: { planQty: cur.planQty, good: cur.good, scrap: cur.scrap, workHr: cur.workHr, down: round(cur.downUnplanned, 1) },
          topCodes: topCodes(cur, legend, 3), notes: topNotes(cur.notes, 3)
        };
        if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
        out.push(o);
      }
      if (basis.n < R.minBase) {
        if (scope === 'item') out.push({ kind: 'nobase', scope: scope, id: id, name: name, title: '기준선 부족', week: week, baseWeeks: basis.weeks, level: '참고',
          current: null, baseline: null, unit: '', facts: { planQty: cur.planQty, good: cur.good, scrap: cur.scrap, workHr: cur.workHr, down: round(cur.downUnplanned, 1) }, topCodes: topCodes(cur, legend, 3), notes: topNotes(cur.notes, 3) });
        return;
      }
      var enough = cur.workHr >= R.minWorkHr;
      // 시간당 생산량
      var bPH = median(base.map(function (a) { return a.perHour; }));
      if (enough && cur.perHour != null && bPH != null && bPH > 0 && R.perHourDrop > 0) {
        var drop = 1 - cur.perHour / bPH;
        if (drop >= R.perHourDrop) push('perHour', '시간당 생산량 저하', cur.perHour, bPH, '개/HR', drop / R.perHourDrop, { change: -drop });
      }
      // 달성률 (품목만 — 호기는 계획을 품목 단위로 세우므로)
      if (scope === 'item') {
        var bAch = median(base.map(function (a) { return a.achieve; }));
        if (cur.achieve != null && bAch != null && R.achieveDrop > 0) {
          var d = bAch - cur.achieve;
          if (d >= R.achieveDrop) push('achieve', '달성률 저하', cur.achieve, bAch, '%', d / R.achieveDrop, { change: -d });
        }
      }
      // 폐기율
      var bSR = median(base.map(function (a) { return a.scrapRate; }));
      if (cur.scrapRate != null && bSR != null && cur.scrap >= R.scrapMin && R.scrapUp > 0) {
        var u = cur.scrapRate - bSR;
        if (u >= R.scrapUp) push('scrap', '폐기율 증가', cur.scrapRate, bSR, '%', u / R.scrapUp, { change: u });
      }
      // 비가동 (작업 1시간당 분, 계획정지 제외)
      var bDN = median(base.map(function (a) { return a.downPerHr; }));
      if (enough && cur.downPerHr != null && bDN != null) {
        var extraMin = cur.downUnplanned - bDN * cur.workHr;
        var ratio = bDN > 0 ? cur.downPerHr / bDN - 1 : (cur.downPerHr > 0 ? Infinity : 0);
        if (ratio >= R.downUp && extraMin >= R.downMin)
          push('down', '비가동 증가', cur.downPerHr, bDN, '분/작업HR', R.downUp > 0 ? Math.min(ratio / R.downUp, 99) : 2, { change: ratio, extraMin: round(extraMin, 0), downMin: round(cur.downUnplanned, 1) });
      }
    }
    itemList(records).forEach(function (it) {
      check('item', it.partNo, it.partName, function (r) { return r.partNo === it.partNo; });
    });
    uniq(records.filter(function (r) { return r.produced; }).map(machine)).forEach(function (ln) {
      check('line', ln, ln + '호기', function (r) { return machine(r) === ln; });
    });
    // 같은 주에 겹치는 이상 잇기 — 품목이 돈 호기에 비가동·같은 종류 이상이 있으면 서로 「관련」으로 표시
    var lineAn = out.filter(function (a) { return a.scope === 'line' && a.kind !== 'nobase'; });
    out.forEach(function (a) {
      if (a.scope !== 'item' || a.kind === 'nobase') return;
      lineAn.forEach(function (b) {
        if (a.lines.indexOf(b.id) < 0 || !(b.kind === 'down' || b.kind === a.kind)) return;
        var t1 = b.id + '호기 ' + b.title; if (a.related.indexOf(t1) < 0) a.related.push(t1);
        if (b.kind === a.kind) { var t2 = a.id + ' ' + a.title; if (b.related.indexOf(t2) < 0) b.related.push(t2); }
      });
    });
    var rank = { '경고': 0, '주의': 1, '참고': 2 };
    return out.sort(function (a, b) { return (rank[a.level] - rank[b.level]) || cmp(a.scope, b.scope) || cmp(a.id, b.id); });
  }

  /* 근거 한 줄 — 화면·보고서·AI 프롬프트가 같은 문장을 씁니다 */
  function fmtVal(v, unit) {
    if (v == null) return '-';
    if (unit === '%') return round(v * 100, 1) + '%';
    return String(round(v, 1)) + (unit ? ' ' + unit : '');
  }
  function evidence(a) {
    if (a.kind === 'nobase') return '직전 주 생산 기록이 ' + a.baseWeeks.length + '주뿐이라 비교하지 않았습니다.';
    var s = '이번 주 ' + fmtVal(a.current, a.unit) + ' · 기준선(직전 ' + a.baseWeeks.length + '주 중앙값) ' + fmtVal(a.baseline, a.unit);
    if (a.unit === '%') s += ' → ' + (a.change > 0 ? '+' : '') + round(a.change * 100, 1) + '%p';
    else if (a.kind === 'perHour') s += ' → ' + round(a.change * 100, 0) + '%';
    else if (a.kind === 'down') s += ' → +' + (isFinite(a.change) ? round(a.change * 100, 0) + '%' : '새로 발생') + ', 이번 주 비가동 ' + a.downMin + '분(기준선보다 약 ' + a.extraMin + '분 많음)';
    if (a.related && a.related.length) s += ' (같은 주 관련: ' + a.related.join(', ') + ')';
    return s;
  }
  function codeText(tc) {
    return tc.map(function (c) { return c.code + (c.name ? '(' + c.name + ')' : '') + ' ' + c.min + '분' + (c.planned ? '[계획정지]' : ''); }).join(', ');
  }

  /* ③ AI 프롬프트 — 계산된 사실만 넣고, 사실 밖의 원인은 「추정」으로 표시하게 합니다 */
  function buildAiPrompt(ctx) { return buildAiPromptInfo(ctx).prompt; }
  /* ctx.aliases({품번: 별칭})가 있으면 품번을 별칭으로 바꿉니다 → { prompt, map(이 프롬프트에 쓴 {품번: 별칭}), leaks(남은 품번) } */
  function buildAiPromptInfo(ctx) {
    var sum = ctx.summary, t = sum.total, L = [];
    var al = ctx.aliases || null, used = {};
    function P(pn) { if (!al || !al[pn]) return pn; used[pn] = al[pn]; return al[pn]; }
    function T(s) {
      if (!al) return s;
      var m = maskText(s, al);
      if (m !== s) Object.keys(al).forEach(function (pn) { if (textMaskable(pn) && pnRegex([pn]).test(s)) used[pn] = al[pn]; });
      return m;
    }
    L.push('너는 주조 공장의 생산관리 보조야. 아래 [사실]은 주간 생산실적 엑셀에서 도구가 계산한 값이야.');
    L.push('[사실]에 있는 숫자와 내용만 근거로 삼아 주간 생산 문제를 정리해줘. 숫자를 새로 만들거나 바꾸지 말아줘.');
    L.push('원인은 [사실]에 비가동 코드·비가동내용으로 적힌 것만 「기록된 원인」으로 쓰고, 그 밖의 원인은 반드시 「추정」이라고 표시해줘.');
    if (al) L.push('품번은 보안상 「' + ALIAS_PREFIX + '1」 같은 별칭으로 바꿔 두었어. 답에서도 별칭을 띄어 쓰지 말고 그대로 써줘(실제 품번을 짐작하지 말아줘).');
    L.push('');
    L.push('[사실]');
    L.push('- 기간: ' + sum.from + ' ~ ' + sum.to + ' (기준일 = 주조일자, 주조 전 계획 행은 일자)');
    L.push('- 전체: 계획수량 ' + t.planQty + ', 양품 ' + t.good + ', 폐기 ' + t.scrap + ', 미달(양품−계획) ' + t.short +
      ', 달성률 ' + fmtVal(t.achieve, '%') + ', 폐기율 ' + fmtVal(t.scrapRate, '%') + ', 계획시간 ' + t.planHr + 'HR, 실투입시간 ' + t.workHr + 'HR, 비가동 ' + round(t.downAll, 0) + '분');
    var tc = topCodes(t, ctx.legend, 5);
    if (tc.length) L.push('- 비가동 코드별(분): ' + codeText(tc));
    L.push('- 품명별: ' + sum.groups.map(function (g) {
      return g.name + ' 계획 ' + g.sub.planQty + '/양품 ' + g.sub.good + '/폐기 ' + g.sub.scrap + '/달성률 ' + fmtVal(g.sub.achieve, '%') + '/폐기율 ' + fmtVal(g.sub.scrapRate, '%');
    }).join('; '));
    var an = (ctx.anomalies || []).filter(function (a) { return a.kind !== 'nobase'; });
    L.push('- 규칙으로 찾은 이상 ' + an.length + '건 (기준: ' + ruleText(ctx.rules) + ')');
    an.forEach(function (a, i) {
      var ev = evidence(al ? copyWith(a, { related: (a.related || []).map(T) }) : a);
      L.push('  ' + (i + 1) + '. [' + a.level + '] ' + (a.scope === 'line' ? '호기 ' + a.id : '품번 ' + P(a.id) + '(' + a.name + ')') + ' — ' + a.title + ': ' + ev);
      L.push('     이번 주 계획 ' + a.facts.planQty + ', 양품 ' + a.facts.good + ', 폐기 ' + a.facts.scrap + ', 작업 ' + a.facts.workHr + 'HR, 비가동 ' + a.facts.down + '분' +
        (a.topCodes.length ? ', 비가동 코드 ' + codeText(a.topCodes) : '') + (a.notes.length ? ', 비가동내용 「' + a.notes.map(T).join('」 「') + '」' : ''));
    });
    if (!an.length) L.push('  (규칙에 걸린 항목 없음)');
    var nb = (ctx.anomalies || []).filter(function (a) { return a.kind === 'nobase'; });
    if (nb.length) L.push('- 과거 기록이 부족해 비교하지 못한 품번: ' + nb.map(function (a) { return P(a.id); }).join(', '));
    if (ctx.legend && Object.keys(ctx.legend).length) {
      L.push('- 비가동 코드 뜻: ' + Object.keys(ctx.legend).sort().map(function (c) { var x = ctx.legend[c]; return c + '=' + x.name + (x.planned ? '(계획정지)' : ''); }).join(', '));
    }
    L.push('');
    L.push('[요청] 다음 순서로 한국어로 짧게 정리해줘.');
    L.push('1. 이번 주 한 줄 요약');
    L.push('2. 품목·호기별 주요 문제 (이상 항목마다 근거 숫자를 그대로 인용)');
    L.push('3. 생산관리자가 현장에서 확인할 것 (항목마다 2~3개, 금형·설비·자재·작업 조건 가운데 기록과 관련 있는 것부터)');
    L.push('4. 다음 주에 해 볼 개선 방안 (과거 데이터와 비교해 말할 수 있는 것만)');
    L.push('확실하지 않은 것은 「확인 필요」라고 적어줘.');
    var text = L.join('\n');
    return { prompt: text, map: used, leaks: al ? findLeaks(text, Object.keys(al)) : [] };
  }
  function copyWith(o, extra) { var c = {}; Object.keys(o).forEach(function (k) { c[k] = o[k]; }); Object.keys(extra).forEach(function (k) { c[k] = extra[k]; }); return c; }
  function ruleText(r) {
    r = cleanRules(r);
    return '직전 ' + r.baseWeeks + '주 중앙값 대비 시간당 생산량 −' + round(r.perHourDrop * 100, 0) + '% · 달성률 −' + round(r.achieveDrop * 100, 0) + '%p · 폐기율 +' +
      round(r.scrapUp * 100, 1) + '%p(폐기 ' + r.scrapMin + '개 이상) · 비가동 +' + round(r.downUp * 100, 0) + '%(' + r.downMin + '분 이상)';
  }

  /* ④ 주간 보고서 초안 (글자) — 화면·Word·인쇄가 같은 내용을 씁니다 */
  function buildReport(records, week, rules, legend, aiText) {
    var R = cleanRules(rules);
    var from = week, to = weekEnd(week);
    var sum = summarize(records, { from: from, to: to, planned: R.planned });
    var an = detectAnomalies(records, week, R, legend);
    var t = sum.total;
    var nextFrom = addDays(week, 7), nextTo = weekEnd(nextFrom);
    var next = records.filter(function (r) { return !r.produced && inRange(r, nextFrom, nextTo); });
    var notDone = records.filter(function (r) { return !r.produced && inRange(r, from, to); });
    var lines = byLine(records, { from: from, to: to, planned: R.planned });
    var real = an.filter(function (a) { return a.kind !== 'nobase'; });
    var L = [];
    L.push('주조 주간 생산현황 보고 — ' + weekLabel(week));
    L.push('');
    L.push('1. 총괄');
    L.push('  - 계획수량 ' + fmtN(t.planQty) + ' / 양품 ' + fmtN(t.good) + ' / 폐기 ' + fmtN(t.scrap) + ' / 미달(양품−계획) ' + fmtN(t.short));
    L.push('  - 달성률 ' + fmtVal(t.achieve, '%') + ' · 폐기율 ' + fmtVal(t.scrapRate, '%') + ' · 시간당 양품 ' + fmtVal(t.perHour, '개/HR'));
    L.push('  - 계획시간 ' + t.planHr + 'HR / 실투입시간 ' + t.workHr + 'HR · 비가동 ' + fmtN(round(t.downAll, 0)) + '분' + (topCodes(t, legend, 3).length ? ' (상위: ' + codeText(topCodes(t, legend, 3)) + ')' : ''));
    if (notDone.length) L.push('  - 계획했으나 실적이 없는 행 ' + notDone.length + '건: ' + notDone.map(function (r) { return r.date.slice(5) + ' ' + r.line + '호기 ' + r.partNo; }).join(', '));
    L.push('');
    L.push('2. 품명별 실적');
    sum.groups.forEach(function (g) {
      L.push('  - ' + g.name + ': 계획 ' + fmtN(g.sub.planQty) + ', 양품 ' + fmtN(g.sub.good) + ', 폐기 ' + fmtN(g.sub.scrap) + ', 달성률 ' + fmtVal(g.sub.achieve, '%') + ', 폐기율 ' + fmtVal(g.sub.scrapRate, '%'));
    });
    L.push('');
    L.push('3. 주요 문제 (규칙 기준: ' + ruleText(R) + ')');
    if (!real.length) L.push('  - 기준을 넘은 항목이 없습니다.');
    real.forEach(function (a) {
      L.push('  - [' + a.level + '] ' + (a.scope === 'line' ? a.id + '호기' : a.id + ' ' + a.name) + ' — ' + a.title + ': ' + evidence(a) +
        (a.topCodes.length ? ' / 비가동 ' + codeText(a.topCodes) : '') + (a.notes.length ? ' / 내용: ' + a.notes.join('; ') : ''));
    });
    L.push('');
    L.push('4. 호기별 가동');
    lines.forEach(function (x) {
      L.push('  - ' + x.line + '호기: 양품 ' + fmtN(x.good) + ', 작업 ' + x.workHr + 'HR, 시간당 양품 ' + fmtVal(x.perHour, '개/HR') + ', 폐기율 ' + fmtVal(x.scrapRate, '%') + ', 비가동 ' + fmtN(round(x.downAll, 0)) + '분');
    });
    var idle = idleLines(lines);
    if (idle.length) L.push('  - 이번 주 실적이 없는 호기: ' + idle.map(function (x) { return x + '호기'; }).join(', '));
    if (next.length) {
      L.push('');
      L.push('5. 다음 주 계획 (' + weekLabel(nextFrom) + ')');
      L.push('  - 계획 ' + next.length + '건, 계획수량 ' + fmtN(next.reduce(function (s, r) { return s + (r.planQty || 0); }, 0)) + ', 계획시간 ' + round(next.reduce(function (s, r) { return s + (r.planHr || 0); }, 0), 1) + 'HR');
    }
    if (aiText && str(aiText)) {
      L.push('');
      L.push((next.length ? '6' : '5') + '. AI 분석 의견 (검토 후 사용)');
      str(aiText).split('\n').forEach(function (s) { L.push('  ' + s); });
    }
    return { week: week, from: from, to: to, summary: sum, anomalies: an, lines: lines, idle: idle, next: next, notDone: notDone, text: L.join('\n') };
  }
  function idleLines(lines) {
    var on = {}; (lines || []).forEach(function (x) { if (x.produced) on[x.line] = 1; });
    return KNOWN_LINES.filter(function (k) { return !on[k]; });
  }
  function fmtN(n) { return n == null ? '-' : Number(n).toLocaleString('ko-KR'); }

  /* 엑셀 내보내기용 표 — 실제 요약 시트의 열(계획시간·실투입시간·계획수량·양품·폐기·미달) + 비율 + 비가동 */
  function summaryToAoa(sum, legend) {
    var head = ['구분', '품명', '품번', '계획시간(HR)', '실투입시간(HR)', '계획수량', '양품', '폐기', '미달수량(양품−계획)', '달성률(%)', '폐기율(%)', '시간당 양품'];
    sum.codes.forEach(function (c) { head.push('비가동 ' + c + (legend && legend[c] && legend[c].name ? ' ' + legend[c].name : '') + '(분)'); });
    head.push('비가동 합계(분)', '비가동내용');
    var aoa = [['주조 주간 생산결산 ' + sum.from + ' ~ ' + sum.to], head];
    function row(kind, name, pn, a) {
      var r = [kind, name, pn, a.planHr, a.workHr, a.planQty, a.good, a.scrap, a.short,
        a.achieve == null ? '' : round(a.achieve * 100, 1), a.scrapRate == null ? '' : round(a.scrapRate * 100, 1), a.perHour == null ? '' : round(a.perHour, 1)];
      sum.codes.forEach(function (c) { r.push(a.down[c] || 0); });
      r.push(round(a.downAll, 1), topNotes(a.notes, 10).join(' / '));
      return r;
    }
    sum.groups.forEach(function (g) {
      aoa.push(row('품명 합계', g.name, '', g.sub));
      g.items.forEach(function (it) { aoa.push(row('품번', g.name, it.partNo, it)); });
    });
    aoa.push(row('총합계', '', '', sum.total));
    return aoa;
  }

  /* ② 요약 피벗 양식 — 보내 주신 「주조 ○월 ○주차 요약」 시트와 같은 칸 배치(2026-09-30 확정).
     행 레이블 한 열에 품명(소계) → 그 아래 품번, 맨 아래 총합계. 값 = 계획시간·실투입시간·계획수량·양품·폐기·미달(양품 − 계획, 합계). */
  var PIVOT_HEAD = ['행 레이블', '계획시간(HR)', '실투입시간(HR)', '계획수량', '양품수량', '폐기수량', '미달수량'];
  function pivotRows(sum) {
    function vals(a) { return [round(a.planHr, 2), round(a.workHr, 2), a.planQty, a.good, a.scrap, a.short]; }
    var out = [];
    sum.groups.forEach(function (g) {
      out.push({ kind: 'group', label: g.name, values: vals(g.sub) });
      g.items.forEach(function (it) { out.push({ kind: 'item', label: it.partNo, values: vals(it) }); });
    });
    out.push({ kind: 'total', label: '총합계', values: vals(sum.total) });
    return out;
  }
  function pivotToAoa(sum) {
    var aoa = [['주조 주간 생산결산(요약 피벗 양식) ' + sum.from + ' ~ ' + sum.to], PIVOT_HEAD.slice()];
    pivotRows(sum).forEach(function (r) { aoa.push([r.label].concat(r.values)); });
    return aoa;
  }

  /* ── 7. 여러 주 한꺼번에 가져오기 (2026-09-30 — 3~4달 치를 한 번에) ──────
     파일을 고른 순서와 상관없이 결과가 같도록 「실적이 가장 늦은 날」이 이른 파일부터 반영합니다.
     list: [{ fileName, records }] → 같은 항목을 정렬한 새 배열 */
  function fileLastDate(records) {
    var last = '';
    (records || []).forEach(function (r) { if (r.produced) { var d = baseDate(r); if (d > last) last = d; } });
    return last;
  }
  function importOrder(list) {
    return (list || []).map(function (x, i) { return { x: x, i: i, d: fileLastDate(x.records) || '9999' }; })
      .sort(function (a, b) { return cmp(a.d, b.d) || cmp(a.x.fileName, b.x.fileName) || (a.i - b.i); })
      .map(function (o) { return o.x; });
  }
  /* 쌓인 실적 주가 비지 않았는지 — 첫 주 ~ 마지막 주 사이에 실적이 없는 주를 찾습니다 */
  function weekCoverage(records) {
    var ws = producedWeeks(records || []);
    var out = { first: ws[0] || '', last: ws[ws.length - 1] || '', weeks: ws, missing: [] };
    if (!ws.length) return out;
    var have = {}; ws.forEach(function (w) { have[w] = 1; });
    for (var w = out.first; w <= out.last; w = addDays(w, 7)) if (!have[w]) out.missing.push(w);
    return out;
  }
  /* 머리행이 같은 파일끼리 열 연결을 함께 고치기 위한 표지 */
  function headerSignature(det) { return det && det.headers ? det.headers.map(norm).join('|') : ''; }

  /* ── 9. 품번 가리기 (2026-09-30 — 「외부 AI 에 품번을 안 보낼 수 있으면 안 보내면 좋겠다」) ──
     AI 프롬프트의 품번을 「품목1」 같은 별칭으로 바꾸고, 대응표는 이 브라우저에만 둡니다.
     AI 답의 별칭은 대응표로 다시 품번으로 되돌려 보고서에 넣습니다. */
  var ALIAS_PREFIX = '품목';
  /* 이미 있는 대응표를 유지하고(같은 품번 = 늘 같은 별칭) 새 품번에만 다음 번호를 붙입니다 */
  function assignAliases(map, partNos) {
    var out = {}, used = 0;
    Object.keys(map || {}).forEach(function (pn) {
      var m = new RegExp('^' + ALIAS_PREFIX + '(\\d+)$').exec(map[pn]);
      if (m) { out[pn] = map[pn]; used = Math.max(used, +m[1]); }
    });
    uniq((partNos || []).map(str).filter(Boolean)).forEach(function (pn) { if (!out[pn]) out[pn] = ALIAS_PREFIX + (++used); });
    return out;
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); }
  /* 자유 글(비가동내용 등) 안에서 바꿔도 되는 품번 — 너무 짧거나 숫자만 5자리 이하인 품번은 코드(A~J)·분·수량과
     헷갈려 글 속에서는 바꾸지 않습니다. 품번 칸 자리(이상 목록 등)는 글자 모양과 상관없이 늘 별칭으로 바뀝니다. */
  function textMaskable(pn) { return pn.length >= 4 && (/[^0-9]/.test(pn) || pn.length >= 6); }
  function pnRegex(pns) {
    if (!pns.length) return null;
    var list = pns.slice().sort(function (a, b) { return b.length - a.length; }).map(escRe);
    return new RegExp('(^|[^0-9A-Za-z])(' + list.join('|') + ')(?![0-9A-Za-z])', 'g');
  }
  function maskText(text, map) {
    var re = pnRegex(Object.keys(map || {}).filter(textMaskable));
    if (!re || text == null) return text == null ? '' : String(text);
    return String(text).replace(re, function (all, pre, pn) { return pre + map[pn]; });
  }
  /* AI 답 → 품번. 「품목3」만 바꾸고 「품목 3개」「품목3개」처럼 수를 세는 말은 그대로 둡니다 */
  function unmaskText(text, map) {
    var back = {};
    Object.keys(map || {}).forEach(function (pn) { back[map[pn]] = pn; });
    return String(text == null ? '' : text).replace(new RegExp(ALIAS_PREFIX + '(\\d+)(?![0-9개건종가])', 'g'), function (all) { return back[all] || all; });
  }
  /* 안전망 — 가린 뒤에도 프롬프트에 남은 품번(글 속 표기가 달라 못 바꾼 것 등) */
  function findLeaks(text, partNos) {
    var s = String(text || '');
    return uniq((partNos || []).filter(function (pn) {
      if (!textMaskable(pn)) return false;
      var re = pnRegex([pn]); return re.test(s);
    }));
  }
  /* ── 8. 저장 형식 ─────────────────────────────────────────── */
  function emptyDb() { return { schemaVersion: SCHEMA_VERSION, records: [], legend: {}, files: [], rules: cleanRules({}), aiNotes: {}, aliases: {}, maskParts: true }; }
  function restoreDb(o) {
    var db = emptyDb();
    if (!o || typeof o !== 'object') return db;
    if (Array.isArray(o.records)) db.records = o.records.filter(function (r) { return r && r.partNo && r.date; }).map(function (r) {
      r.down = r.down && typeof r.down === 'object' ? r.down : {}; r.produced = isProduced(r); return r;
    });
    if (o.legend && typeof o.legend === 'object') db.legend = o.legend;
    if (Array.isArray(o.files)) db.files = o.files;
    db.rules = cleanRules(o.rules || {});
    if (o.aiNotes && typeof o.aiNotes === 'object') db.aiNotes = o.aiNotes;
    if (o.aliases && typeof o.aliases === 'object') db.aliases = assignAliases(o.aliases, []);
    if (o.maskParts === false) db.maskParts = false;
    return db;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION, FIELDS: FIELDS, DEFAULT_RULES: DEFAULT_RULES,
    norm: norm, toNum: toNum, toISO: toISO, addDays: addDays, weekStart: weekStart, weekEnd: weekEnd, weekLabel: weekLabel, colName: colName, round: round,
    matchField: matchField, detectColumns: detectColumns, parseLegend: parseLegend, parseRows: parseRows, parseSheet: parseSheet, pickSheet: pickSheet,
    isProduced: isProduced, recKey: recKey, mergeRecords: mergeRecords, baseDate: baseDate, machine: machine, weeksOf: weeksOf, producedWeeks: producedWeeks,
    aggregate: aggregate, summarize: summarize, itemList: itemList, itemWeekly: itemWeekly, byLine: byLine, topCodes: topCodes, topNotes: topNotes,
    median: median, cleanRules: cleanRules, detectAnomalies: detectAnomalies, evidence: evidence, fmtVal: fmtVal, fmtN: fmtN, codeText: codeText, ruleText: ruleText,
    buildAiPrompt: buildAiPrompt, buildAiPromptInfo: buildAiPromptInfo, buildReport: buildReport, summaryToAoa: summaryToAoa, emptyDb: emptyDb, restoreDb: restoreDb,
    PIVOT_HEAD: PIVOT_HEAD, pivotRows: pivotRows, pivotToAoa: pivotToAoa, fileLastDate: fileLastDate, importOrder: importOrder, weekCoverage: weekCoverage, headerSignature: headerSignature,
    KNOWN_LINES: KNOWN_LINES, ALIAS_PREFIX: ALIAS_PREFIX, assignAliases: assignAliases, maskText: maskText, unmaskText: unmaskText, findLeaks: findLeaks
  };
});
