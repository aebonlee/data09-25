/* 주조 생산실적 분석 — 화면
   계산은 js/logic.js(CastLogic), 그래프는 js/charts.js, 저장은 js/store.js, AI 연결은 js/ai-endpoint.js·ai-panel.js. */
(function () {
  'use strict';
  var L = window.CastLogic, S = window.CastStore, C = window.CastCharts, AIP = window.AIPanel;
  var db = S.loadDb();
  var ui = { week: '', span: 8, item: '', from: '', to: '', pending: [], errors: [], progress: '', weeklyView: 'pivot' };
  var main = document.getElementById('main');

  /* ── 작은 도구 ───────────────────────────── */
  function h(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(e, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(e, x); }); return; }
    e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function fld(label, control, hint) {
    return h('label', { class: 'field' }, h('span', null, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
  }
  var toastTimer = null;
  function toast(msg, err) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast' + (err ? ' error' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function save() {
    var ok = S.saveDb(db);
    document.getElementById('storeNote').textContent = ok ? '이 브라우저에 저장됨 · ' + S.sizeKb() + 'KB' : '저장 안 됨(브라우저 저장소가 막혔거나 가득 참) — JSON 백업을 받아 두세요';
    return ok;
  }
  var pct = function (v) { return L.fmtVal(v, '%'); };
  var n1 = function (v) { return v == null ? '-' : L.fmtN(L.round(v, 1)); };
  function planned() { return Object.keys(db.legend).filter(function (c) { return db.legend[c].planned; }); }
  function rules() { var r = L.cleanRules(db.rules); r.planned = planned(); return r; }
  function codeName(c) { var x = db.legend[c]; return x && x.name ? c + ' ' + x.name : c; }
  function download(name, blob) {
    var a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function weeks() { return L.producedWeeks(db.records); }
  function currentWeek() {
    var ws = weeks();
    if (!ws.length) return '';
    if (ui.week && ws.indexOf(ui.week) >= 0) return ui.week;
    return ws[ws.length - 1];
  }
  function weekSelect(onChange) {
    var sel = h('select', { 'aria-label': '주 선택' });
    weeks().slice().reverse().forEach(function (w) { var o = h('option', { value: w }, L.weekLabel(w)); if (w === currentWeek()) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', function () { ui.week = sel.value; onChange(); });
    return sel;
  }
  function pageHead(stage, title, lead, right) {
    return h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('div', { class: 'stage' }, stage), h('h1', null, title), lead ? h('p', { class: 'lead' }, lead) : null), right || null);
  }
  function emptyNotice() {
    return h('section', { class: 'card empty' },
      h('p', null, '아직 가져온 생산실적이 없습니다.'),
      h('p', null, '주간 생산실적 엑셀을 가져오거나, 가상 샘플 8주로 먼저 둘러봐 주세요.'),
      h('div', { class: 'btn-row', style: 'justify-content:center' },
        h('a', { class: 'btn btn-primary', href: '#/import' }, '데이터 가져오기로'),
        h('button', { type: 'button', class: 'btn', onclick: loadSample }, '샘플 8주로 시작')));
  }
  function tile(k, v, sub) { return h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), sub ? h('div', { class: 'note' }, sub) : null); }
  function table(head, rows, opts) {
    opts = opts || {};
    var t = h('table', { class: 'list' + (opts.cls ? ' ' + opts.cls : '') });
    var tr = h('tr');
    head.forEach(function (x, i) { tr.appendChild(h('th', { class: opts.num && opts.num[i] ? 'num' : null, scope: 'col' }, x)); });
    t.appendChild(h('thead', null, tr));
    var tb = h('tbody');
    rows.forEach(function (r) {
      var row = h('tr', { class: r.cls || null });
      (r.cells || r).forEach(function (x, i) { row.appendChild(h('td', { class: (opts.num && opts.num[i] ? 'num' : '') + (r.tdCls && r.tdCls[i] ? ' ' + r.tdCls[i] : '') || null }, x)); });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    return h('div', { class: 'table-wrap' }, t);
  }

  /* ── 가져오기 ───────────────────────────── */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array', cellDates: true });
          resolve(prepare(file.name, wb));
        } catch (e) { reject(new Error(file.name + ': 엑셀로 읽지 못했습니다(' + e.message + ')')); }
      };
      fr.onerror = function () { reject(new Error(file.name + ': 파일을 읽지 못했습니다.')); };
      fr.readAsArrayBuffer(file);
    });
  }
  function prepare(name, wb) {
    var sheets = wb.SheetNames.map(function (n) { return { name: n, aoa: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }) }; });
    var pick = L.pickSheet(sheets) || sheets[0];
    var item = { fileName: name, sheets: sheets, sheet: pick ? pick.name : '', overrides: {} };
    reparse(item);
    return item;
  }
  function reparse(item) {
    var sh = item.sheets.filter(function (s) { return s.name === item.sheet; })[0];
    item.aoa = sh ? sh.aoa : [];
    item.result = L.parseSheet(item.aoa, { fileName: item.fileName, overrides: item.overrides });
  }
  /* 3~4달 치(파일 십수 개)를 한 번에 넣어도 되도록: 하나씩 차례로 읽고(메모리·화면 멈춤 방지) 진행을 보여 주며,
     엑셀 잠금 파일(~$…)·엑셀이 아닌 파일·이미 올려 둔 같은 파일은 건너뛰고, 못 읽은 파일은 목록으로 남깁니다. */
  function fileId(f) { return f.name + '|' + f.size + '|' + (f.lastModified || 0); }
  function handleFiles(list) {
    var all = Array.prototype.slice.call(list || []);
    var skipped = [];
    var files = all.filter(function (f) {
      if (/^~\$/.test(f.name)) { skipped.push(f.name + ' (엑셀 잠금 파일)'); return false; }
      if (!/\.(xlsx|xlsm|xls|csv)$/i.test(f.name)) { if (!/^\./.test(f.name)) skipped.push(f.name + ' (엑셀 아님)'); return false; }
      if (ui.pending.some(function (p) { return p.fid === fileId(f); })) { skipped.push(f.name + ' (이미 올려 둠)'); return false; }
      return true;
    });
    if (!files.length) { toast(skipped.length ? '가져올 엑셀이 없습니다(' + skipped.length + '개 건너뜀).' : '엑셀 파일(.xlsx·.xls·.csv)을 골라 주세요.', true); return; }
    files.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    ui.errors = skipped.map(function (x) { return '건너뜀: ' + x; });
    var i = 0;
    (function next() {
      if (i >= files.length) { ui.progress = ''; render(); toast(files.length + '개 파일을 읽었습니다. 아래에서 확인한 뒤 반영해 주세요.'); return; }
      var f = files[i++];
      ui.progress = '읽는 중 ' + i + ' / ' + files.length + ' — ' + f.name;
      var pr = document.getElementById('importProgress'); if (pr) pr.textContent = ui.progress;
      readFile(f).then(function (it) {
        it.fid = fileId(f);
        it.already = db.files.some(function (x) { return x.name === f.name; });
        ui.pending.push(it);
        applySameHeader(it);
      }, function (e) { ui.errors.push(e.message); }).then(function () { setTimeout(next, 0); });
    })();
  }
  /* 머리행이 같은 파일에 이미 고친 열 연결이 있으면 그대로 씁니다(첫 파일만 고치면 나머지도 따라감) */
  function applySameHeader(it) {
    var sig = L.headerSignature(it.result.det);
    var src = ui.pending.filter(function (p) { return p !== it && Object.keys(p.overrides).length && L.headerSignature(p.result.det) === sig; })[0];
    if (src) { it.overrides = JSON.parse(JSON.stringify(src.overrides)); reparse(it); }
  }
  function commit(items) {
    var total = { added: 0, updated: 0, superseded: 0, planSkipped: 0 }, ok = 0;
    // 고른 순서와 상관없이 실적이 이른 파일부터 — 늦은 주의 실적이 앞 주 파일의 「다음 주 계획」 행을 대신합니다
    var ordered = L.importOrder(items.map(function (it) { return { fileName: it.fileName, records: it.result.records, it: it }; })).map(function (x) { return x.it; });
    ordered.forEach(function (it) {
      var r = it.result;
      if (r.det.missing.length) return;
      var m = L.mergeRecords(db.records, r.records);
      db.records = m.records;
      Object.keys(m.stat).forEach(function (k) { total[k] += m.stat[k]; });
      Object.keys(r.legend).forEach(function (c) { if (!db.legend[c] || !db.legend[c].edited) db.legend[c] = r.legend[c]; });
      db.files.push({ name: it.fileName, sheet: it.sheet, rows: r.records.length, at: new Date().toISOString().slice(0, 16).replace('T', ' ') });
      ok++;
    });
    db.sample = db.sample && items.every(function (it) { return it.sample; });
    ui.pending = ui.pending.filter(function (p) { return items.indexOf(p) < 0; });
    ui.week = '';
    save();
    ui.errors = [];
    toast(ok + '개 파일 반영 — 새 행 ' + total.added + ' · 바뀐 행 ' + total.updated + ' · 계획 행 → 실적 행 ' + total.superseded + (total.planSkipped ? ' · 이미 실적이 있어 건너뛴 계획 행 ' + total.planSkipped : ''));
    render();
  }
  function loadSample() {
    var files = window.CastSample.build();
    db = L.emptyDb(); db.sample = true;
    var items = files.map(function (f) {
      // 앱이 실제 파일을 읽을 때와 같은 길로 — 엑셀 통합문서로 만들었다가 다시 읽습니다
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(f.aoa), '주조 생산실적');
      var back = XLSX.read(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }), { type: 'array', cellDates: true });
      var it = prepare(f.fileName, back); it.sample = true; return it;
    });
    ui.pending = [];
    commit(items);
    location.hash = '#/anomaly';
  }

  function pageImport() {
    var input = h('input', { type: 'file', multiple: true, accept: '.xlsx,.xlsm,.xls,.csv' });
    input.addEventListener('change', function () { handleFiles(input.files); input.value = ''; });
    var folder = h('input', { type: 'file', multiple: true, webkitdirectory: true });
    folder.addEventListener('change', function () { handleFiles(folder.files); folder.value = ''; });
    var drop = h('div', { class: 'drop' },
      h('label', { class: 'btn btn-primary' }, input, '주간 엑셀 고르기(여러 개 가능)'),
      h('label', { class: 'btn' }, folder, '폴더째 고르기'),
      h('span', { class: 'note' }, '또는 파일을 여기로 끌어다 놓아 주세요. 3~4달 치 주간 파일을 한꺼번에(Ctrl+A 로 모두 골라) 넣어도 됩니다.'));
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); handleFiles(e.dataTransfer.files); });

    var ws = weeks(), items = L.itemList(db.records);
    var out = [pageHead('데이터', '주간 생산실적 가져오기', '매주 쓰는 「주조 생산현황」 엑셀을 그대로 넣어 주세요. 머리행 두 줄(생산계획·작업 배치·작업수량·비가동(분)·중량)을 알아서 찾습니다.'),
      h('section', { class: 'card' }, h('h2', null, '1. 파일 넣기'), drop,
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', onclick: function () { if (!db.records.length || confirm('지금 데이터를 지우고 가상 샘플 8주를 불러올까요?')) loadSample(); } }, '샘플 8주로 시작'),
          h('a', { class: 'btn', href: 'samples/' + encodeURIComponent('주조_생산실적_샘플_08주차_0921.xlsx'), download: '' }, '샘플 파일 내려받기(8주차)')),
        h('ul', { class: 'note' },
          h('li', null, '같은 행(일자 + 호기 + 품번 + 주조일자)을 다시 가져오면 새 값으로 바뀝니다. 같은 파일을 두 번 넣어도 두 번 세지 않습니다.'),
          h('li', null, '주간표 아래쪽의 「다음 주 계획」 행(주조일자·실적이 빈 행)은 계획으로만 보관하고, 다음 주 파일에서 실적 행이 오면 그 행으로 바꿉니다.'),
          h('li', null, '파일 아래의 비가동 코드 범례(Code · 항목 · 비가동의 정의)가 있으면 코드 이름을 자동으로 채웁니다.'),
          h('li', null, '여러 파일은 고른 순서와 상관없이 실적 날짜가 이른 파일부터 반영합니다. 한 파일에서 열 연결을 고치면 머리행이 같은 나머지 파일에도 똑같이 적용됩니다.'),
          h('li', null, '파일은 서버로 보내지 않고 이 브라우저 안에서만 읽습니다.')),
        h('p', { class: 'note', id: 'importProgress', 'aria-live': 'polite' }, ui.progress || ''),
        ui.errors.length ? h('details', { class: 'warn-list', open: true }, h('summary', null, '읽지 못했거나 건너뛴 파일 ' + ui.errors.length + '개'),
          h('ul', null, ui.errors.map(function (e) { return h('li', null, e); }))) : null)];

    if (ui.pending.length) {
      var box = h('section', { class: 'card' }, h('h2', null, '2. 열 연결 확인 후 반영 (' + ui.pending.length + '개 파일)'));
      var ready = ui.pending.filter(function (it) { return !it.result.det.missing.length; });
      var sorted = L.importOrder(ui.pending.map(function (it) { return { fileName: it.fileName, records: it.result.records, it: it }; })).map(function (x) { return x.it; });
      box.appendChild(table(['파일', '실적 주', '실적 행', '계획 행', '알림', '상태'], sorted.map(function (it) {
        var r = it.result, wk = L.weeksOf(r.records.filter(function (x) { return x.produced; }));
        return { cls: r.det.missing.length ? 'excluded' : null, cells: [it.fileName,
          wk.length ? L.weekLabel(wk[0]).split(' (')[0] + (wk.length > 1 ? ' ~ ' + L.weekLabel(wk[wk.length - 1]).split(' (')[0] : '') : '없음',
          r.records.length - r.planOnly, r.planOnly, r.warnings.length + r.det.warnings.length,
          r.det.missing.length ? '열 연결 필요' : it.already ? '이전에 가져온 파일(새 값으로 바뀜)' : '반영 준비됨'] };
      }), { num: [0, 0, 1, 1, 1, 0] }));
      var dupWeeks = {};
      ui.pending.forEach(function (it) { L.weeksOf(it.result.records.filter(function (x) { return x.produced; })).forEach(function (w) { (dupWeeks[w] = dupWeeks[w] || []).push(it.fileName); }); });
      var dups = Object.keys(dupWeeks).filter(function (w) { return dupWeeks[w].length > 1; }).sort();
      if (dups.length) box.appendChild(h('p', { class: 'alert info' }, '같은 주 실적이 여러 파일에 있습니다: ' + dups.map(function (w) { return L.weekLabel(w).split(' (')[0] + '(' + dupWeeks[w].length + '개 파일)'; }).join(', ') +
        '. 같은 행은 한 번만 세고, 늦은 파일의 값이 남습니다.'));
      box.appendChild(h('h3', null, '파일별 자세히'));
      sorted.forEach(function (it) { box.appendChild(pendingCard(it)); });
      box.appendChild(h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary', disabled: !ready.length, onclick: function () { commit(ready); } }, '확인한 ' + ready.length + '개 파일 반영'),
        h('button', { type: 'button', class: 'btn', onclick: function () { ui.pending = []; render(); } }, '취소')));
      out.push(box);
    }

    out.push(h('section', { class: 'card' }, h('h2', null, '쌓인 데이터'),
      db.records.length ? h('div', null,
        h('div', { class: 'tiles' },
          tile('실적 주', ws.length + '주', ws.length ? L.weekLabel(ws[0]).split(' (')[0] + ' ~ ' + L.weekLabel(ws[ws.length - 1]).split(' (')[0] : ''),
          tile('품번', items.length + '개'),
          tile('실적 행', L.fmtN(db.records.filter(function (r) { return r.produced; }).length)),
          tile('계획만 있는 행', L.fmtN(db.records.filter(function (r) { return !r.produced; }).length), '아직 실적이 없는 계획')),
        coverageNote(),
        h('details', null, h('summary', null, '가져온 파일 ' + db.files.length + '개 보기'),
          table(['가져온 파일', '시트', '행', '가져온 때'], db.files.slice().reverse().map(function (f) { return [f.name, f.sheet, f.rows, f.at]; }), { num: [0, 0, 1, 0] })),
        h('div', { class: 'btn-row', style: 'margin-top:12px' },
          h('button', { type: 'button', class: 'btn btn-danger', onclick: function () {
            if (!confirm('이 브라우저에 쌓인 생산실적·설정을 모두 지울까요? (되돌릴 수 없습니다. 먼저 설정 화면에서 JSON 백업을 받아 두면 안전합니다)')) return;
            db = L.emptyDb(); S.clearDb(); ui.week = ''; save(); render();
          } }, '모든 데이터 지우기')))
        : h('p', { class: 'note' }, '아직 없습니다.')));
    return out;
  }
  function coverageNote() {
    var cov = L.weekCoverage(db.records);
    if (!cov.weeks.length) return null;
    return cov.missing.length
      ? h('p', { class: 'alert warn' }, '실적이 빠진 주가 있습니다: ' + cov.missing.map(function (w) { return L.weekLabel(w).split(' (')[0]; }).join(', ') + '. 휴무 주가 아니라면 그 주 파일을 더 넣어 주세요(이상 탐지 기준선이 짧아집니다).')
      : h('p', { class: 'note' }, L.weekLabel(cov.first).split(' (')[0] + ' ~ ' + L.weekLabel(cov.last).split(' (')[0] + ' — ' + cov.weeks.length + '주가 빠짐없이 이어져 있습니다.');
  }
  function pendingCard(it) {
    var r = it.result, det = r.det;
    var sheetSel = h('select', { 'aria-label': '시트' });
    it.sheets.forEach(function (s) { var o = h('option', { value: s.name }, s.name); if (s.name === it.sheet) o.selected = true; sheetSel.appendChild(o); });
    sheetSel.addEventListener('change', function () { it.sheet = sheetSel.value; it.overrides = {}; reparse(it); render(); });
    var hdr = det.headers || [];
    var ex = it.aoa[det.headerRow + 1] || [];
    var mapGrid = h('div', { class: 'map-grid' });
    L.FIELDS.forEach(function (f) {
      var sel = h('select', { 'aria-label': f.label + ' 열' });
      sel.appendChild(h('option', { value: '-1' }, '(이 파일에는 없음)'));
      hdr.forEach(function (t, i) {
        var o = h('option', { value: String(i) }, L.colName(i) + ' · ' + (t || '(빈 머리)'));
        if (det.map[f.id] === i) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        var sig = L.headerSignature(it.result.det), n = 0;
        ui.pending.forEach(function (p) {
          if (p !== it && L.headerSignature(p.result.det) !== sig) return;
          p.overrides[f.id] = Number(sel.value); reparse(p); if (p !== it) n++;
        });
        if (n) toast('머리행이 같은 파일 ' + n + '개에도 같은 연결을 적용했습니다.');
        render();
      });
      var col = det.map[f.id];
      var exv = col == null ? '' : ex[col];
      if (exv instanceof Date) exv = L.toISO(exv);
      mapGrid.appendChild(h('div', { class: 'map-row' + (f.req && col == null ? ' missing' : '') },
        h('span', { class: 'col' }, f.label, f.req ? h('span', { class: 'req' }, ' 필수') : null), sel,
        h('span', { class: 'ex' }, col == null ? '연결 안 됨' : '예: ' + (exv == null || exv === '' ? '(빈칸)' : String(exv)))));
    });
    var weeksIn = L.weeksOf(r.records.filter(function (x) { return x.produced; }));
    var needs = det.missing.length > 0 || det.warnings.length > 0;
    return h('details', { class: 'block', open: needs || ui.pending.length === 1 ? true : null }, h('summary', null, it.fileName + (det.missing.length ? ' — 열 연결 필요' : '')),
      h('div', { class: 'form-grid' },
        fld('시트', sheetSel, it.sheets.length > 1 ? '실적 시트를 자동으로 골랐습니다(요약·피벗 시트는 품번 열이 없어 빠짐).' : null),
        h('div', { class: 'field' }, h('span', null, '읽은 결과'),
          h('div', null, det.headerRow < 0 ? '머리행을 못 찾음' : '머리행 ' + (det.headerRow + 1) + '행' + (det.groupRow >= 0 ? '(묶음 머리 ' + (det.groupRow + 1) + '행)' : '') +
            ' · 실적 행 ' + (r.records.length - r.planOnly) + ' · 계획만 있는 행 ' + r.planOnly),
          h('small', { class: 'hint' }, '실적 주: ' + (weeksIn.map(function (w) { return L.weekLabel(w).split(' (')[0]; }).join(', ') || '없음') +
            ' · 비가동 코드 열: ' + (det.downCols.map(function (d) { return d.code; }).join('') || '없음') +
            ' · 범례: ' + (Object.keys(r.legend).length ? Object.keys(r.legend).join('') : '없음')))),
      det.warnings.map(function (w) { return h('p', { class: 'alert warn' }, w); }),
      r.warnings.length ? h('details', { class: 'warn-list' }, h('summary', null, '행 점검 알림 ' + r.warnings.length + '건 (반영은 됩니다)'),
        h('ul', null, r.warnings.slice(0, 50).map(function (w) { return h('li', null, w.row + '행: ' + w.msg); }))) : null,
      h('details', { open: det.missing.length ? true : null }, h('summary', null, '열 연결 보기·고치기 (' + Object.keys(det.map).length + '개 연결됨)'), mapGrid));
  }

  /* ── ① 품목별 분석 ───────────────────────── */
  function pageItem() {
    if (!db.records.length) return [pageHead('①', '품목별 생산분석'), emptyNotice()];
    var items = L.itemList(db.records).filter(function (it) { return db.records.some(function (r) { return r.partNo === it.partNo && r.produced; }); });
    if (!ui.item || !items.some(function (x) { return x.partNo === ui.item; })) ui.item = items.length ? items[0].partNo : '';
    var itemSel = h('select', { 'aria-label': '품목' });
    items.forEach(function (it) { var o = h('option', { value: it.partNo }, it.partNo + ' · ' + it.partName); if (it.partNo === ui.item) o.selected = true; itemSel.appendChild(o); });
    itemSel.addEventListener('change', function () { ui.item = itemSel.value; render(); });
    var spanSel = h('select', { 'aria-label': '추이 기간' }, [4, 8, 12, 16].map(function (n) { var o = h('option', { value: n }, '최근 ' + n + '주'); if (n === ui.span) o.selected = true; return o; }));
    spanSel.addEventListener('change', function () { ui.span = Number(spanSel.value); render(); });
    var wk = currentWeek(), R = rules();
    var series = L.itemWeekly(db.records, ui.item, wk, ui.span, R.planned);
    var cur = series[series.length - 1];
    var labels = series.map(function (s) { return s.week.slice(5).replace('-', '/'); });
    var from = series[0].week, to = L.weekEnd(wk);
    var lines = L.byLine(db.records, { from: from, to: to, partNo: ui.item, planned: R.planned });
    var rows = db.records.filter(function (r) { return r.partNo === ui.item && L.baseDate(r) >= wk && L.baseDate(r) <= L.weekEnd(wk); });
    var an = L.detectAnomalies(db.records, wk, R, db.legend).filter(function (a) { return a.scope === 'item' && a.id === ui.item && a.kind !== 'nobase'; });
    var it = items.filter(function (x) { return x.partNo === ui.item; })[0] || {};
    return [
      pageHead('①', '품목별 생산분석', '품목을 고르면 계획 대비 실적, 달성률·폐기율, 시간당 생산량, 최근 추이와 호기별 생산성을 보여 줍니다.'),
      h('section', { class: 'card filters' }, fld('품목(품번)', itemSel), fld('기준 주', weekSelect(render)), fld('추이 기간', spanSel)),
      h('h2', { class: 'sec' }, it.partNo + ' · ' + it.partName + ' — ' + L.weekLabel(wk)),
      an.length ? h('div', { class: 'alert warn' }, '이번 주 규칙에 걸린 항목: ' + an.map(function (a) { return a.title + '(' + L.evidence(a) + ')'; }).join(' / ')) : null,
      h('div', { class: 'tiles' },
        tile('계획 → 양품', L.fmtN(cur.planQty) + ' → ' + L.fmtN(cur.good), '미달(양품−계획) ' + L.fmtN(cur.short)),
        tile('달성률', pct(cur.achieve), '양품 ÷ 계획수량'),
        tile('양품률 / 폐기율', pct(cur.goodRate) + ' / ' + pct(cur.scrapRate), '폐기 ' + L.fmtN(cur.scrap) + '개'),
        tile('시간당 양품', L.fmtVal(cur.perHour, '개/HR'), '계획 ' + cur.planHr + 'HR · 실투입 ' + cur.workHr + 'HR')),
      h('section', { class: 'card' }, h('h2', null, '최근 ' + ui.span + '주 추이'),
        h('div', { class: 'charts' },
          C.figure('계획수량과 양품(개)', { type: 'bar', labels: labels, unit: '개', series: [
            { name: '계획수량', values: series.map(function (s) { return s.rows ? s.planQty : null; }), color: 'var(--series-plan)' },
            { name: '양품', values: series.map(function (s) { return s.rows ? s.good : null; }), color: 'var(--series-1)' }] }),
          C.figure('시간당 양품(개/HR)', { type: 'line', labels: labels, unit: '개/HR', series: [{ name: '시간당 양품', values: series.map(function (s) { return s.perHour; }), color: 'var(--series-1)' }] }),
          C.figure('달성률', { type: 'line', labels: labels, unit: '%', minMax: 1, series: [{ name: '달성률', values: series.map(function (s) { return s.achieve; }), color: 'var(--series-3)' }] }),
          C.figure('폐기율', { type: 'line', labels: labels, unit: '%', series: [{ name: '폐기율', values: series.map(function (s) { return s.scrapRate; }), color: 'var(--series-2)' }] })),
        table(['주', '계획수량', '양품', '폐기', '달성률', '폐기율', '실투입(HR)', '시간당 양품', '비가동(분)'],
          series.map(function (s) { return [L.weekLabel(s.week).split(' (')[0], s.rows ? L.fmtN(s.planQty) : '-', s.rows ? L.fmtN(s.good) : '-', s.rows ? L.fmtN(s.scrap) : '-', pct(s.achieve), pct(s.scrapRate), s.rows ? s.workHr : '-', n1(s.perHour), s.rows ? L.fmtN(L.round(s.downAll, 0)) : '-']; }),
          { num: [0, 1, 1, 1, 1, 1, 1, 1, 1] }),
        h('p', { class: 'note' }, '생산이 없던 주는 「-」로 둡니다. 비가동은 모든 코드 합계(분)입니다.')),
      h('section', { class: 'card' }, h('h2', null, '호기별 생산성 (최근 ' + ui.span + '주, 실제 주조호기 기준)'),
        lines.length ? [
          C.figure('호기별 시간당 양품(개/HR)', { type: 'bar', labels: lines.map(function (x) { return x.line + '호기'; }), unit: '개/HR', height: 150, series: [{ name: '시간당 양품', values: lines.map(function (x) { return x.perHour; }), color: 'var(--series-1)' }] }),
          table(['호기', '양품', '폐기율', '실투입(HR)', '시간당 양품', '작업 1시간당 비가동(분)'],
            lines.map(function (x) { return [x.line + '호기', L.fmtN(x.good), pct(x.scrapRate), x.workHr, n1(x.perHour), n1(x.downPerHr)]; }), { num: [0, 1, 1, 1, 1, 1] })]
          : h('p', { class: 'note' }, '이 기간에 실적이 없습니다.')),
      h('section', { class: 'card' }, h('h2', null, '이번 주 작업 행'),
        table(['일자', '호기', '주조일자', '주조호기', '계획', '근무(HR)', '작업(HR)', '양품', '폐기', '비가동(분)', '비가동내용'],
          rows.map(function (r) {
            return { cls: r.produced ? null : 'excluded', cells: [r.date.slice(5), r.line, r.castDate ? r.castDate.slice(5) : '-', r.castLine || '-', r.planQty == null ? '-' : r.planQty, r.planHr == null ? '-' : r.planHr,
              r.workHr == null ? '-' : r.workHr, r.good == null ? '-' : r.good, r.scrap == null ? '-' : r.scrap,
              Object.keys(r.down).map(function (c) { return c + ' ' + r.down[c]; }).join(', ') || '-', r.downNote || ''] };
          }), { num: [0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0] }),
        h('p', { class: 'note' }, '흐린 행은 계획만 있고 실적이 없는 행입니다.'))
    ];
  }

  /* ── ② 주간 생산결산 ─────────────────────── */
  function periodPicker() {
    var wk = currentWeek();
    if (!ui.from || !ui.to) { ui.from = wk; ui.to = L.weekEnd(wk); }
    var f = h('input', { type: 'date', value: ui.from }), t = h('input', { type: 'date', value: ui.to });
    f.addEventListener('change', function () { ui.from = f.value; render(); });
    t.addEventListener('change', function () { ui.to = t.value; render(); });
    var ws = weekSelect(function () { ui.from = ui.week; ui.to = L.weekEnd(ui.week); render(); });
    return h('section', { class: 'card filters' }, fld('주 고르기', ws), fld('시작일', f), fld('종료일', t),
      h('p', { class: 'note span-all' }, '기준일은 실제로 주조한 날(주조일자)이고, 아직 주조하지 않은 계획 행은 일자(계획일)로 셉니다.'));
  }
  function pageWeekly() {
    if (!db.records.length) return [pageHead('②', '주간 생산결산'), emptyNotice()];
    var picker = periodPicker();
    var R = rules();
    var sum = L.summarize(db.records, { from: ui.from, to: ui.to, planned: R.planned });
    var head = ['품명 / 품번', '계획시간(HR)', '실투입시간(HR)', '계획수량', '양품', '폐기', '미달수량', '달성률', '폐기율', '시간당 양품'];
    sum.codes.forEach(function (c) { head.push(codeName(c)); });
    head.push('비가동 합계(분)', '비가동내용');
    function cells(label, a) {
      var r = [label, n1(a.planHr), n1(a.workHr), L.fmtN(a.planQty), L.fmtN(a.good), L.fmtN(a.scrap), L.fmtN(a.short), pct(a.achieve), pct(a.scrapRate), n1(a.perHour)];
      sum.codes.forEach(function (c) { r.push(a.down[c] ? L.fmtN(a.down[c]) : ''); });
      r.push(L.fmtN(L.round(a.downAll, 0)), L.topNotes(a.notes, 3).join(' / '));
      return r;
    }
    var rows = [];
    sum.groups.forEach(function (g) {
      rows.push({ cls: 'sum', cells: cells(g.name, g.sub) });
      g.items.forEach(function (it) { rows.push({ cells: cells('  ' + it.partNo, it), tdCls: { 0: 'indent' } }); });
    });
    rows.push({ cls: 'sum total', cells: cells('총합계', sum.total) });
    var num = head.map(function (x, i) { return i > 0 && i < head.length - 1; });
    var t = sum.total;
    // 요약 피벗 양식(기본) — 보내 주신 요약 시트와 같은 칸: 행 레이블 · 계획시간 · 실투입시간 · 계획수량 · 양품 · 폐기 · 미달
    var pivot = table(L.PIVOT_HEAD, L.pivotRows(sum).map(function (r) {
      var v = r.values;
      return { cls: r.kind === 'group' ? 'sum' : r.kind === 'total' ? 'sum total' : null, tdCls: { 0: r.kind === 'item' ? 'indent label' : 'label' },
        cells: [r.label, n1(v[0]), n1(v[1]), L.fmtN(v[2]), L.fmtN(v[3]), L.fmtN(v[4]), L.fmtN(v[5])] };
    }), { num: [0, 1, 1, 1, 1, 1, 1], cls: 'pivot' });
    function viewBtn(id, label) {
      return h('button', { type: 'button', 'aria-pressed': ui.weeklyView === id ? 'true' : 'false', onclick: function () { ui.weeklyView = id; render(); } }, label);
    }
    return [
      pageHead('②', '주간 생산결산', '기간을 고르면 지금 쓰시는 요약표처럼 품명 → 품번으로 묶어 계획시간·실투입시간·계획수량·양품·폐기·미달을 모읍니다.',
        h('div', { class: 'btn-row no-print' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { exportWeekly(sum); } }, '엑셀로 내려받기'),
          h('button', { type: 'button', class: 'btn', onclick: function () { window.print(); } }, '인쇄'))),
      picker,
      sum.rows ? [
        h('div', { class: 'tiles' },
          tile('계획수량 → 양품', L.fmtN(t.planQty) + ' → ' + L.fmtN(t.good), '미달 ' + L.fmtN(t.short)),
          tile('달성률', pct(t.achieve)), tile('폐기율', pct(t.scrapRate), '폐기 ' + L.fmtN(t.scrap) + '개'),
          tile('비가동', L.fmtN(L.round(t.downAll, 0)) + '분', L.topCodes(t, db.legend, 2).map(function (c) { return codeName(c.code) + ' ' + L.fmtN(c.min); }).join(' · '))),
        h('section', { class: 'card' }, h('div', { class: 'page-head' }, h('h2', null, '결산표 ' + ui.from + ' ~ ' + ui.to + ' (' + sum.rows + '행)'),
            h('div', { class: 'view-toggle no-print', role: 'group', 'aria-label': '결산표 보기' }, viewBtn('pivot', '요약 피벗 양식'), viewBtn('detail', '자세히(비율·비가동)'))),
          ui.weeklyView === 'detail' ? table(head, rows, { num: num, cls: 'weekly' }) : pivot,
          h('ul', { class: 'note' },
            h('li', null, ui.weeklyView === 'detail' ? '품명·품번 순서와 앞 6개 값은 「요약 피벗 양식」과 같고, 달성률·폐기율·시간당 양품·비가동 코드별 시간을 덧붙였습니다.'
              : '보내 주신 「주조 ○월 ○주차 요약」 피벗과 같은 칸 배치입니다(품명 소계 → 품번, 맨 아래 총합계). 비율·비가동은 「자세히」에서 봐 주세요.'),
            h('li', null, '미달수량 = 양품 − 계획수량의 합계(2026-09-30 확정). 음수면 계획보다 적게 만든 것입니다. 원래 요약 시트는 피벗 값 설정이 「개수」라 행 수가 나왔으니, 피벗을 계속 쓰신다면 값 필드를 「합계」로 바꿔 주세요.'),
            h('li', null, '달성률 = 양품 ÷ 계획수량, 폐기율 = 폐기 ÷ (양품 + 폐기), 시간당 양품 = 양품 ÷ 실투입시간.'),
            h('li', null, '계획정지 코드(' + (planned().join(', ') || '없음') + ')는 비가동 합계에는 넣고, 이상 탐지의 비가동 비교에서는 뺍니다.')))]
        : h('section', { class: 'card empty' }, '이 기간에 행이 없습니다.')
    ];
  }
  function exportWeekly(sum) {
    var wb = XLSX.utils.book_new();
    var ws0 = XLSX.utils.aoa_to_sheet(L.pivotToAoa(sum));
    ws0['!cols'] = [{ wch: 18 }, { wch: 13 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws0, '요약(피벗 양식)');
    var ws1 = XLSX.utils.aoa_to_sheet(L.summaryToAoa(sum, db.legend));
    ws1['!cols'] = [{ wch: 9 }, { wch: 14 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws1, '결산 자세히');
    var raw = [['기준일', '일자', '호기', '품번', '품명', '계획수량', '근무(HR)', '작업(HR)', '주조일자', '주조호기', '총 수량', '양품', '폐기', '미달(양품−계획)', '비가동(분)', '비가동내용', '원본 파일']];
    db.records.filter(function (r) { var d = L.baseDate(r); return d >= sum.from && d <= sum.to; }).forEach(function (r) {
      raw.push([L.baseDate(r), r.date, r.line, r.partNo, r.partName, r.planQty, r.planHr, r.workHr, r.castDate, r.castLine, r.total, r.good, r.scrap,
        (r.good || 0) - (r.planQty || 0), Object.keys(r.down).map(function (c) { return c + ' ' + r.down[c]; }).join(', '), r.downNote, r.file]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(raw), '행 목록');
    XLSX.writeFile(wb, '주조_주간결산_' + sum.from + '_' + sum.to + '.xlsx');
  }

  /* ── ③ 이상 탐지 · AI ───────────────────── */
  function pageAnomaly() {
    if (!db.records.length) return [pageHead('③', '이상 탐지 · AI 분석'), emptyNotice()];
    var wk = currentWeek(), R = rules();
    var an = L.detectAnomalies(db.records, wk, R, db.legend);
    var real = an.filter(function (a) { return a.kind !== 'nobase'; }), nobase = an.filter(function (a) { return a.kind === 'nobase'; });
    var sum = L.summarize(db.records, { from: wk, to: L.weekEnd(wk), planned: R.planned });
    // 품번 가리기(기본 켬, 2026-09-30) — 별칭 대응표는 db.aliases 에 두고 같은 품번은 늘 같은 별칭
    var mask = db.maskParts !== false;
    var partNos = L.itemList(db.records).map(function (x) { return x.partNo; });
    if (mask) db.aliases = L.assignAliases(db.aliases, partNos);
    var info = L.buildAiPromptInfo({ summary: sum, anomalies: an, rules: R, legend: db.legend, aliases: mask ? db.aliases : null });
    var prompt = info.prompt;
    function back(t) { return mask ? L.unmaskText(t, db.aliases) : t; }
    var answer = h('textarea', { rows: 10, placeholder: 'AI 답을 여기에 붙여 넣어 주세요. 별칭(품목1 등)은 품번으로 되돌려 주간 보고서의 「AI 분석 의견」에 넣습니다.' });
    answer.value = (db.aiNotes || {})[wk] || '';
    answer.addEventListener('input', function () { db.aiNotes[wk] = back(answer.value); save(); });
    answer.addEventListener('change', function () { var b = back(answer.value); if (b !== answer.value) { answer.value = b; toast('답의 별칭을 품번으로 되돌렸습니다.'); } });
    var promptBox = h('textarea', { rows: 12, readonly: true, class: 'mono' }); promptBox.value = prompt;
    var maskBox = h('input', { type: 'checkbox' }); maskBox.checked = mask;
    maskBox.addEventListener('change', function () { db.maskParts = maskBox.checked; save(); render(); });
    var mapRows = Object.keys(info.map).sort(function (a, b) { return Number(info.map[a].slice(2)) - Number(info.map[b].slice(2)); }).map(function (pn) {
      var it = L.itemList(db.records).filter(function (x) { return x.partNo === pn; })[0];
      return [info.map[pn], pn, it ? it.partName : ''];
    });
    var maskCard = h('div', { class: 'mask-box' },
      h('label', { class: 'opt' }, maskBox, h('span', null, h('span', { class: 't' }, '품번 가리기(외부 AI 에 품번을 보내지 않음)'),
        h('span', { class: 's' }, '프롬프트의 품번을 「품목1」 같은 별칭으로 바꿉니다. 대응표는 이 브라우저에만 있고, AI 답의 별칭은 붙여 넣을 때 품번으로 되돌립니다.'))),
      mask && info.leaks.length ? h('p', { class: 'alert warn' }, '가리지 못한 품번이 프롬프트에 남아 있습니다: ' + info.leaks.join(', ') + ' — 보내기 전에 지워 주세요.') : null,
      mask ? h('p', { class: 'note' }, info.leaks.length ? '' : '확인: 프롬프트에 실제 품번이 없습니다(가져온 품번 ' + partNos.length + '개 대조). 품명·수량·비가동내용은 그대로 들어갑니다.') : h('p', { class: 'alert info' }, '지금은 품번이 그대로 들어갑니다. 회사 보안 기준을 확인해 주세요.'),
      mask && mapRows.length ? h('details', null, h('summary', null, '별칭 대응표 — 이 프롬프트에 쓴 ' + mapRows.length + '개 (이 PC 에만 있음)'),
        table(['별칭', '품번', '품명'], mapRows, { cls: 'alias' }),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onclick: function () {
          copyText(mapRows.map(function (r) { return r.join('\t'); }).join('\n'));
        } }, '대응표 복사(엑셀 붙여넣기용)'))) : null);
    return [
      pageHead('③', '이상 탐지 · AI 분석', '규칙으로 먼저 찾고(근거 숫자 표시), 그 사실만으로 AI 에게 요약·확인사항을 부탁합니다.'),
      h('section', { class: 'card filters' }, fld('분석할 주', weekSelect(render)),
        h('p', { class: 'note span-all' }, '기준선 = 이 주 직전 ' + R.baseWeeks + '주 가운데 그 품목(호기)이 생산된 주의 중앙값. 기준은 아래 「탐지 기준」에서 바꿀 수 있습니다.')),
      h('div', { class: 'tiles' },
        tile('경고', real.filter(function (a) { return a.level === '경고'; }).length + '건'),
        tile('주의', real.filter(function (a) { return a.level === '주의'; }).length + '건'),
        tile('품목 / 호기', real.filter(function (a) { return a.scope === 'item'; }).length + ' / ' + real.filter(function (a) { return a.scope === 'line'; }).length),
        tile('비교 못 함', nobase.length + '개 품번', '직전 생산 기록 부족')),
      h('section', { class: 'card' }, h('h2', null, '찾은 이상 — ' + L.weekLabel(wk)),
        real.length ? h('div', { class: 'an-list' }, real.map(anCard)) : h('p', { class: 'note' }, '기준을 넘은 항목이 없습니다.'),
        nobase.length ? h('details', null, h('summary', null, '과거 기록이 부족해 비교하지 않은 품번 ' + nobase.length + '개'),
          h('p', { class: 'note' }, nobase.map(function (a) { return a.id + ' (직전 생산 ' + a.baseWeeks.length + '주)'; }).join(', '))) : null),
      rulesCard(),
      h('section', { class: 'card', id: 'ai' }, h('h2', null, 'AI 분석 (반자동 기본)'),
        h('ol', { class: 'steps' },
          h('li', null, '아래 프롬프트를 복사해 회사가 허용한 AI(ChatGPT 등)에 붙여 넣어 주세요. 계산된 숫자·비가동 기록만 들어 있고 작업자 이름은 넣지 않았습니다. 품번은 기본으로 별칭으로 바꿉니다.'),
          h('li', null, '받은 답을 「AI 답」 칸에 붙여 넣으면 별칭이 품번으로 되돌아가 주간 보고서에 들어갑니다. 답은 꼭 검토해 주세요.')),
        maskCard,
        promptBox,
        h('div', { class: 'btn-row', style: 'margin:10px 0' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { copyText(prompt); } }, '프롬프트 복사'),
          AIP.sendButton('설정한 AI 서버로 보내기(선택)', function () { return prompt; }, function (text) { text = back(text); answer.value = text; db.aiNotes[wk] = text; save(); toast('AI 답을 받았습니다(별칭은 품번으로 되돌림). 검토 후 보고서에 씁니다.'); },
            { toast: toast, settingsHref: '#/settings', system: '너는 주조 공장 생산관리 보조야. 주어진 사실 밖의 숫자를 만들지 마.' })),
        fld('AI 답 (' + L.weekLabel(wk).split(' (')[0] + ')', answer, '이 주에 붙여 넣은 답은 이 브라우저에 저장됩니다.'))
    ];
  }
  function anCard(a) {
    return h('article', { class: 'an ' + (a.level === '경고' ? 'lv-bad' : 'lv-warn') },
      h('div', { class: 'an-top' }, h('span', { class: 'tag ' + (a.level === '경고' ? 'warn' : 'caution') }, a.level),
        h('strong', null, a.scope === 'line' ? a.id + '호기' : a.id + ' · ' + a.name), h('span', null, ' — ' + a.title)),
      h('p', { class: 'an-ev' }, L.evidence(a)),
      h('p', { class: 'note' }, '이번 주 계획 ' + L.fmtN(a.facts.planQty) + ' · 양품 ' + L.fmtN(a.facts.good) + ' · 폐기 ' + L.fmtN(a.facts.scrap) + ' · 실투입 ' + a.facts.workHr + 'HR · 비가동(계획정지 제외) ' + L.fmtN(a.facts.down) + '분' +
        (a.lines && a.lines.length && a.scope === 'item' ? ' · 호기 ' + a.lines.join(', ') : '') + ' · 비교한 주 ' + a.baseWeeks.map(function (w) { return w.slice(5).replace('-', '/'); }).join(', ')),
      a.topCodes.length ? h('p', { class: 'note' }, '비가동 상위: ' + L.codeText(a.topCodes)) : null,
      a.notes.length ? h('p', { class: 'note' }, '비가동내용: ' + a.notes.join(' / ')) : null);
  }
  function rulesCard() {
    var r = L.cleanRules(db.rules);
    var defs = [
      ['baseWeeks', '기준선에 쓸 직전 주 수', 1, 1], ['minBase', '기준선에 필요한 최소 주 수', 1, 1],
      ['perHourDrop', '시간당 생산량 저하 (%)', 100, 1], ['achieveDrop', '달성률 저하 (%p)', 100, 1],
      ['scrapUp', '폐기율 증가 (%p)', 100, 0.5], ['scrapMin', '…이번 주 폐기가 이 개수 이상일 때만', 1, 1],
      ['downUp', '작업 1시간당 비가동 증가 (%)', 100, 5], ['downMin', '…늘어난 비가동이 이 분 이상일 때만', 1, 10],
      ['minWorkHr', '비율 비교에 필요한 이번 주 최소 작업(HR)', 1, 0.5]];
    var inputs = {};
    var grid = h('div', { class: 'form-grid' }, defs.map(function (d) {
      var i = h('input', { type: 'number', min: 0, step: d[3], value: L.round(r[d[0]] * d[2], 2), inputmode: 'decimal' });
      inputs[d[0]] = { el: i, mul: d[2] };
      return fld(d[1], i);
    }));
    return h('details', { class: 'card rules' }, h('summary', null, '탐지 기준 (지금: ' + L.ruleText(r) + ')'), grid,
      h('div', { class: 'btn-row', style: 'margin-top:10px' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: function () {
          var p = {}; Object.keys(inputs).forEach(function (k) { p[k] = Number(inputs[k].el.value) / inputs[k].mul; });
          db.rules = L.cleanRules(p); save(); toast('탐지 기준을 바꿨습니다.'); render();
        } }, '기준 적용'),
        h('button', { type: 'button', class: 'btn', onclick: function () { db.rules = L.cleanRules({}); save(); render(); } }, '기본값으로')));
  }
  function copyText(t) {
    function fallback() { var ta = h('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('복사했습니다.'); } catch (e) { toast('복사하지 못했습니다. 직접 선택해 복사해 주세요.', true); } ta.remove(); }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(function () { toast('복사했습니다.'); }, fallback); else fallback();
  }

  /* ── ④ 주간 보고서 ───────────────────────── */
  function pageReport() {
    if (!db.records.length) return [pageHead('④', '주간 생산현황 보고서'), emptyNotice()];
    var wk = currentWeek(), R = rules();
    var rep = L.buildReport(db.records, wk, R, db.legend, (db.aiNotes || {})[wk]);
    var paper = reportPaper(rep);
    return [
      pageHead('④', '주간 생산현황 보고서', '분석 결과로 주간 보고서 초안을 만듭니다. 고쳐 쓸 곳을 확인한 뒤 인쇄하거나 Word·엑셀로 내려받아 주세요.',
        h('div', { class: 'btn-row no-print' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { window.print(); } }, '인쇄 / PDF'),
          h('button', { type: 'button', class: 'btn', onclick: function () { exportWord(rep, paper); } }, 'Word 로'),
          h('button', { type: 'button', class: 'btn', onclick: function () { exportReportXlsx(rep); } }, '엑셀로'),
          h('button', { type: 'button', class: 'btn', onclick: function () { copyText(rep.text); } }, '글자로 복사'))),
      h('section', { class: 'card filters no-print' }, fld('보고할 주', weekSelect(render)),
        h('p', { class: 'note span-all' }, (db.aiNotes || {})[wk] ? 'AI 분석 의견은 ③ 화면에서 붙여 넣은 답입니다.' : 'AI 분석 의견을 넣으려면 ③ 화면에서 AI 답을 붙여 넣어 주세요(선택).')),
      h('section', { class: 'card paper' }, paper)
    ];
  }
  function reportPaper(rep) {
    var t = rep.summary.total, real = rep.anomalies.filter(function (a) { return a.kind !== 'nobase'; });
    var ai = (db.aiNotes || {})[rep.week];
    var numAll = function (n) { var a = []; for (var i = 0; i < n; i++) a.push(i > 0); return a; };
    return h('div', { class: 'rp' },
      h('h1', null, '주조 주간 생산현황 보고'),
      h('p', { class: 'note' }, L.weekLabel(rep.week) + ' · 작성: 생산관리 · 자동 생성 초안(검토 후 사용)'),
      h('h2', null, '1. 총괄'),
      table(['계획수량', '양품', '폐기', '미달(양품−계획)', '달성률', '폐기율', '계획시간', '실투입시간', '시간당 양품', '비가동'],
        [[L.fmtN(t.planQty), L.fmtN(t.good), L.fmtN(t.scrap), L.fmtN(t.short), pct(t.achieve), pct(t.scrapRate), t.planHr + 'HR', t.workHr + 'HR', n1(t.perHour), L.fmtN(L.round(t.downAll, 0)) + '분']],
        { num: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }),
      rep.notDone.length ? h('p', null, '계획했으나 실적이 없는 행 ' + rep.notDone.length + '건: ' + rep.notDone.map(function (r) { return r.date.slice(5) + ' ' + r.line + '호기 ' + r.partNo; }).join(', ')) : null,
      h('h2', null, '2. 품명별 실적'),
      table(['품명', '계획수량', '양품', '폐기', '미달', '달성률', '폐기율', '비가동(분)'],
        rep.summary.groups.map(function (g) { var a = g.sub; return [g.name, L.fmtN(a.planQty), L.fmtN(a.good), L.fmtN(a.scrap), L.fmtN(a.short), pct(a.achieve), pct(a.scrapRate), L.fmtN(L.round(a.downAll, 0))]; }),
        { num: numAll(8) }),
      h('h2', null, '3. 주요 문제'),
      real.length ? h('ul', null, real.map(function (a) {
        return h('li', null, h('strong', null, '[' + a.level + '] ' + (a.scope === 'line' ? a.id + '호기' : a.id + ' ' + a.name) + ' — ' + a.title), ': ' + L.evidence(a) +
          (a.topCodes.length ? ' / 비가동 ' + L.codeText(a.topCodes) : '') + (a.notes.length ? ' / 내용: ' + a.notes.join('; ') : ''));
      })) : h('p', null, '기준을 넘은 항목이 없습니다.'),
      h('p', { class: 'note' }, '기준: ' + L.ruleText(rules())),
      h('h2', null, '4. 호기별 가동'),
      table(['호기', '양품', '실투입(HR)', '시간당 양품', '폐기율', '비가동(분)'],
        rep.lines.map(function (x) { return [x.line + '호기', L.fmtN(x.good), x.workHr, n1(x.perHour), pct(x.scrapRate), L.fmtN(L.round(x.downAll, 0))]; }), { num: numAll(6) }),
      rep.idle && rep.idle.length ? h('p', { class: 'note' }, '이번 주 실적이 없는 호기: ' + rep.idle.map(function (x) { return x + '호기'; }).join(', ')) : null,
      rep.next.length ? [h('h2', null, '5. 다음 주 계획 (' + L.weekLabel(L.addDays(rep.week, 7)).split(' (')[0] + ')'),
        h('p', null, '계획 ' + rep.next.length + '건 · 계획수량 ' + L.fmtN(rep.next.reduce(function (s, r) { return s + (r.planQty || 0); }, 0)) + ' · 계획시간 ' + L.round(rep.next.reduce(function (s, r) { return s + (r.planHr || 0); }, 0), 1) + 'HR')] : null,
      ai ? [h('h2', null, (rep.next.length ? '6' : '5') + '. AI 분석 의견 (검토 후 사용)'), h('div', { class: 'pre' }, ai)] : null);
  }
  function exportWord(rep, paper) {
    var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>주간 생산현황</title>' +
      '<style>body{font-family:"맑은 고딕",sans-serif;font-size:10.5pt} table{border-collapse:collapse;margin:6px 0} th,td{border:1px solid #999;padding:3px 6px;font-size:9.5pt} th{background:#eef2f7} h1{font-size:16pt} h2{font-size:12.5pt;margin-top:14pt} .pre{white-space:pre-wrap}</style></head><body>' +
      paper.innerHTML + '</body></html>';
    download('주조_주간보고_' + rep.week + '.doc', new Blob(['﻿' + html], { type: 'application/msword' }));
  }
  function exportReportXlsx(rep) {
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rep.text.split('\n').map(function (s) { return [s]; })), '보고서');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(L.pivotToAoa(rep.summary)), '요약(피벗 양식)');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(L.summaryToAoa(rep.summary, db.legend)), '결산 자세히');
    var an = [['수준', '구분', '품번/호기', '이름', '항목', '근거', '비가동 상위', '비가동내용']];
    rep.anomalies.filter(function (a) { return a.kind !== 'nobase'; }).forEach(function (a) {
      an.push([a.level, a.scope === 'line' ? '호기' : '품목', a.id, a.name, a.title, L.evidence(a), L.codeText(a.topCodes), a.notes.join(' / ')]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(an), '이상');
    XLSX.writeFile(wb, '주조_주간보고_' + rep.week + '.xlsx');
  }

  /* ── 설정 ───────────────────────────────── */
  function pageSettings() {
    var codes = Object.keys(db.legend).sort();
    var used = {}; db.records.forEach(function (r) { Object.keys(r.down).forEach(function (c) { used[c] = 1; }); });
    Object.keys(used).forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });
    codes.sort();
    var rowsEl = codes.map(function (c) {
      var x = db.legend[c] || { code: c, name: '', def: '', planned: false };
      var nm = h('input', { value: x.name, 'aria-label': c + ' 이름' }), df = h('input', { value: x.def, 'aria-label': c + ' 정의' });
      var pl = h('input', { type: 'checkbox', 'aria-label': c + ' 계획정지' }); pl.checked = !!x.planned;
      return { code: c, nm: nm, df: df, pl: pl, cells: [h('strong', null, c), nm, df, pl] };
    });
    var backup = h('input', { type: 'file', accept: '.json' });
    backup.addEventListener('change', function () {
      var f = backup.files[0]; if (!f) return;
      f.text().then(function (t) {
        var o = JSON.parse(t); if (!o || !Array.isArray(o.records)) throw new Error('이 도구의 백업 파일이 아닙니다.');
        db = L.restoreDb(o); save(); toast('백업을 불러왔습니다(' + db.records.length + '행).'); render();
      }).catch(function (e) { toast('불러오지 못했습니다: ' + e.message, true); });
    });
    return [
      pageHead('설정', '비가동 코드 · AI 연결 · 백업'),
      h('section', { class: 'card' }, h('h2', null, '비가동 코드'),
        h('p', { class: 'note' }, '파일 아래의 범례에서 읽은 이름입니다. 「계획정지」로 표시한 코드(회의·교육 등)는 이상 탐지의 비가동 비교에서 뺍니다.'),
        codes.length ? table(['코드', '항목', '정의', '계획정지'], rowsEl.map(function (r) { return r.cells; }), { cls: 'items' }) : h('p', { class: 'note' }, '아직 코드가 없습니다.'),
        codes.length ? h('div', { class: 'btn-row', style: 'margin-top:10px' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: function () {
          rowsEl.forEach(function (r) { db.legend[r.code] = { code: r.code, name: r.nm.value.trim(), def: r.df.value.trim(), planned: r.pl.checked, edited: true }; });
          save(); toast('비가동 코드를 저장했습니다.');
        } }, '코드 저장')) : null),
      AIP.settingsCard({ toast: toast, onChange: render }),
      h('section', { class: 'card' }, h('h2', null, '백업'),
        h('p', { class: 'note' }, '쌓인 실적은 이 브라우저에만 있습니다. 다른 PC 로 옮기거나 브라우저 정리 전에 JSON 으로 받아 두세요. (파일에는 작업자 칸도 들어 있으니 보관에 주의해 주세요)'),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', onclick: function () { download('주조실적_백업_' + new Date().toISOString().slice(0, 10) + '.json', new Blob([JSON.stringify(db)], { type: 'application/json' })); } }, 'JSON 백업 내려받기'),
          h('label', { class: 'btn' }, backup, 'JSON 백업 불러오기')))
    ];
  }

  /* ── 라우터 ─────────────────────────────── */
  var PAGES = [
    { id: 'import', no: '0', t: '데이터 가져오기', s: '주간 엑셀 여러 개', fn: pageImport },
    { id: 'item', no: '①', t: '품목별 분석', s: '계획 대비·추이·호기', fn: pageItem },
    { id: 'weekly', no: '②', t: '주간 생산결산', s: '품명 → 품번 집계', fn: pageWeekly },
    { id: 'anomaly', no: '③', t: '이상 탐지 · AI', s: '규칙 + AI 요약', fn: pageAnomaly },
    { id: 'report', no: '④', t: '주간 보고서', s: '초안·인쇄·Word', fn: pageReport },
    { id: 'settings', no: '설', t: '설정', s: '코드·AI·백업', fn: pageSettings }
  ];
  function route() { var id = (location.hash || '').replace(/^#\//, '').split('?')[0]; return PAGES.filter(function (p) { return p.id === id; })[0] || (db.records.length ? PAGES[3] : PAGES[0]); }
  function render() {
    var p = route();
    var nav = document.getElementById('nav'); nav.innerHTML = '';
    PAGES.forEach(function (x) {
      nav.appendChild(h('a', { href: '#/' + x.id, 'aria-current': x === p ? 'page' : null }, h('span', { class: 'no' }, x.no), h('span', { class: 't' }, x.t), h('span', { class: 's' }, x.s)));
    });
    var ws = weeks();
    document.getElementById('dataChip').textContent = db.records.length ? '실적 ' + ws.length + '주 · 품번 ' + L.itemList(db.records).length + '개' + (ws.length ? ' · 최근 ' + L.weekLabel(ws[ws.length - 1]).split(' (')[0] : '') : '데이터 없음';
    var b = document.getElementById('sampleBanner');
    b.hidden = !db.sample;
    b.textContent = '지금 보시는 것은 가상 샘플 8주입니다(가짜 품번 SMP-…, 작업자A~F). 7·8주차 4호기 비가동, 8주차 SMP-P202 폐기율 급증을 일부러 심어 두었습니다. 실제 파일을 가져오면 샘플은 그대로 두고 더해지니, 먼저 「모든 데이터 지우기」를 해 주세요.';
    main.innerHTML = '';
    add(main, p.fn());
    document.title = p.t + ' — 주조 생산실적 분석';
    save();
  }
  window.addEventListener('hashchange', function () { render(); main.focus(); window.scrollTo(0, 0); });
  render();
})();
