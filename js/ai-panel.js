/* AI 연결 설정 카드와 「자동 보내기」 버튼 (data09-10 에서 옮겨 옴).
   로직(주소 정리·요청 만들기·응답 읽기)은 js/ai-endpoint.js 에 있고, 여기는 화면만 만듭니다. */
(function () {
  'use strict';
  var E = window.AIEndpoint;

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function fld(label, control, hint) {
    return h('label', { class: 'field' }, h('span', null, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
  }

  /* 설정 카드. opts.toast(msg, isError), opts.onChange() */
  function settingsCard(opts) {
    opts = opts || {};
    var cfg = E.load();
    var preset = h('select', { 'aria-label': '서버 종류' });
    E.PRESETS.forEach(function (p) { preset.appendChild(h('option', { value: p.id }, p.label)); });
    var urlIn = h('input', { value: cfg.baseUrl, placeholder: '예: https://llm.사내도메인/v1', autocomplete: 'off', spellcheck: 'false' });
    var modelIn = h('input', { value: cfg.model, placeholder: '예: 서버에 올라간 모델 이름', autocomplete: 'off', spellcheck: 'false' });
    var keyIn = h('input', { type: 'password', value: cfg.apiKey, placeholder: '사내 서버가 키를 요구하지 않으면 비워 두세요', autocomplete: 'off' });
    var remember = h('input', { type: 'checkbox' }); remember.checked = cfg.remember;
    var status = h('div', { class: 'note', 'aria-live': 'polite' });
    preset.addEventListener('change', function () {
      var p = E.PRESETS.filter(function (x) { return x.id === preset.value; })[0];
      if (p && p.baseUrl) urlIn.value = p.baseUrl;
      if (p && p.id === 'custom') { urlIn.value = ''; urlIn.focus(); }
    });
    function read() { return E.cleanConfig({ baseUrl: urlIn.value, model: modelIn.value, apiKey: keyIn.value, remember: remember.checked, temperature: cfg.temperature, timeoutSec: cfg.timeoutSec }); }
    function show(v) {
      status.innerHTML = '';
      v.errors.forEach(function (e) { status.appendChild(h('p', { class: 'alert warn', style: 'margin:6px 0' }, e)); });
      v.warnings.forEach(function (w) { status.appendChild(h('p', { class: 'alert info', style: 'margin:6px 0' }, w)); });
    }
    function saveNow() {
      var c = read(), v = E.validateConfig(c, location.protocol);
      show(v);
      if (v.errors.length && (c.baseUrl || c.model)) { if (opts.toast) opts.toast('설정을 확인해 주세요.', true); return; }
      E.save(c); cfg = c;
      if (opts.toast) opts.toast(E.isReady(c) ? '저장했습니다. 「설정한 AI 서버로 보내기」 버튼을 쓸 수 있습니다.' : '비웠습니다. 반자동(복사·붙여 넣기)만 씁니다.');
      if (opts.onChange) opts.onChange();
    }
    function testNow() {
      var c = read(), v = E.validateConfig(c, location.protocol);
      show(v);
      if (v.errors.length) return;
      status.appendChild(h('p', { class: 'note' }, '연결 확인 중…'));
      E.callChat(c, E.promptMessages('연결 확인입니다. 「확인」이라고만 답해줘.'), { maxTokens: 20 }).then(function (t) {
        status.lastChild.textContent = '연결됨 — 서버 답: ' + t.slice(0, 80);
      }, function (e) { status.lastChild.textContent = e.message; status.lastChild.className = 'alert warn'; });
    }
    return h('section', { class: 'card', id: 'aiSettings' }, h('h2', null, 'AI 연결 설정 (선택 — 자동 보내기)'),
      h('p', { class: 'note' }, '기본은 반자동입니다(프롬프트 복사 → 회사가 허용한 AI 에 붙여 넣기 → 답 붙여 넣기). ' +
        '사내 온프레미스 LLM 이나 본인 OpenAI 키를 쓰려면 여기 적어 주세요. OpenAI 는 서버 종류에서 고르고 키를 넣으면 됩니다. 사내 LLM 이 「OpenAI 호환 API」(주소가 보통 …/v1 로 끝남)를 열어 두었다면 여기 주소·모델을 적어 버튼 한 번으로 보낼 수 있습니다. ' +
        'vLLM·Ollama 같은 오픈소스 서버는 이런 호환 API 를 제공합니다.'),
      h('div', { class: 'form-grid' },
        fld('서버 종류', preset),
        fld('AI 서버 주소(Base URL)', urlIn, '…/v1 까지. /chat/completions 는 도구가 붙입니다.'),
        fld('모델 이름', modelIn),
        fld('키(선택)', keyIn, '비우면 인증 머리글을 보내지 않습니다.')),
      h('label', { class: 'opt', style: 'margin-top:8px' }, remember, h('span', null, h('span', { class: 't' }, '키를 이 브라우저에 기억(공용 PC 에서는 끄세요)'))),
      h('ul', { class: 'note' },
        h('li', null, '보내는 곳은 위 주소 하나뿐입니다. 키는 리포·코드에 없고, 「기억」을 끄면 이 창을 닫을 때 사라집니다.'),
        h('li', null, '브라우저에서 바로 부르므로 서버가 CORS 를 허용해야 합니다. https 로 연 이 페이지에서는 http 주소를 쓸 수 없으니, 사내 서버가 http 라면 이 도구를 내 PC 에서 파일로 열어(file://) 써 주세요.')),
      h('div', { class: 'btn-row', style: 'margin-top:10px' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: saveNow }, '저장'),
        h('button', { type: 'button', class: 'btn', onclick: testNow }, '연결 확인'),
        h('span', { class: 'note' }, '현재: ' + E.describe(cfg))),
      status);
  }

  /* 「설정한 AI 서버로 보내기」 버튼. getPrompt() → 문자열, onAnswer(text), opts.toast, opts.settingsHref */
  function sendButton(label, getPrompt, onAnswer, opts) {
    opts = opts || {};
    var cfg = E.load();
    var ready = E.isReady(cfg);
    var btn = h('button', { type: 'button', class: 'btn', disabled: !ready, title: ready ? E.describe(cfg) : 'AI 연결 설정이 필요합니다' }, label || '설정한 AI 서버로 보내기');
    btn.addEventListener('click', function () {
      var c = E.load(), v = E.validateConfig(c, location.protocol);
      if (v.errors.length) { if (opts.toast) opts.toast(v.errors[0], true); return; }
      var p = getPrompt(); if (!p) return;
      var old = btn.textContent; btn.disabled = true; btn.textContent = '보내는 중…';
      E.callChat(c, E.promptMessages(p, opts.system)).then(function (text) {
        btn.disabled = false; btn.textContent = old; onAnswer(text);
      }, function (e) {
        btn.disabled = false; btn.textContent = old; if (opts.toast) opts.toast(e.message, true);
      });
    });
    var wrap = h('span', { class: 'ai-send' }, btn);
    if (!ready) add(wrap, h('small', { class: 'note', style: 'margin-left:6px' }, '자동 보내기는 ', opts.settingsHref ? h('a', { href: opts.settingsHref }, 'AI 연결 설정') : 'AI 연결 설정', ' 후에 쓸 수 있습니다.'));
    return wrap;
  }

  window.AIPanel = { settingsCard: settingsCard, sendButton: sendButton };
})();
