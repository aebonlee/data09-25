/* 작은 SVG 그래프 — 외부 라이브러리 없이 막대(묶음)·꺾은선 두 가지만.
   한 그래프에 y축은 하나(두 척도를 한 그래프에 섞지 않음). 막대·점에 마우스를 올리면 값이 보입니다(title).
   색은 CSS 변수(--series-1 …)를 씁니다. */
(function (root) {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  function fmt(v, unit) {
    if (v == null) return '-';
    if (unit === '%') return (Math.round(v * 1000) / 10) + '%';
    return (Math.round(v * 10) / 10).toLocaleString('ko-KR') + (unit ? unit : '');
  }

  /* opts: { labels:[], series:[{name, values:[], color}], unit, type:'bar'|'line', height, title } */
  function chart(opts) {
    var W = 640, H = opts.height || 220, padL = 48, padR = 12, padT = 12, padB = 30;
    var n = opts.labels.length, unit = opts.unit || '';
    var all = [];
    opts.series.forEach(function (s) { s.values.forEach(function (v) { if (v != null && isFinite(v)) all.push(v); }); });
    var max = niceMax(Math.max.apply(null, all.concat([opts.minMax || 0])));
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': opts.title || '' });
    var plotW = W - padL - padR, plotH = H - padT - padB;
    function y(v) { return padT + plotH - (v / max) * plotH; }
    for (var g = 0; g <= 4; g++) {
      var gv = max * g / 4, gy = y(gv);
      svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: gy, y2: gy, class: g === 0 ? 'axis' : 'grid' }));
      svg.appendChild(el('text', { x: padL - 6, y: gy + 4, 'text-anchor': 'end', class: 'tick' }, fmt(gv, unit === '%' ? '%' : '')));
    }
    var step = plotW / Math.max(n, 1);
    opts.labels.forEach(function (lb, i) {
      svg.appendChild(el('text', { x: padL + step * (i + 0.5), y: H - 10, 'text-anchor': 'middle', class: 'tick' }, lb));
    });
    if (!all.length) {
      svg.appendChild(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'tick' }, '표시할 값이 없습니다'));
      return svg;
    }
    if (opts.type === 'line') {
      opts.series.forEach(function (s) {
        var d = '', pen = false;
        s.values.forEach(function (v, i) {
          if (v == null || !isFinite(v)) { pen = false; return; }
          d += (pen ? 'L' : 'M') + (padL + step * (i + 0.5)).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
          pen = true;
        });
        svg.appendChild(el('path', { d: d, class: 'ln', style: 'stroke:' + s.color }));
        s.values.forEach(function (v, i) {
          if (v == null || !isFinite(v)) return;
          var c = el('circle', { cx: padL + step * (i + 0.5), cy: y(v), r: 4.5, class: 'dot', style: 'fill:' + s.color });
          c.appendChild(el('title', null, opts.labels[i] + ' · ' + s.name + ' ' + fmt(v, unit)));
          svg.appendChild(c);
        });
      });
    } else {
      var k = opts.series.length, gap = 2, bw = Math.min(28, (step * 0.7 - gap * (k - 1)) / k);
      opts.labels.forEach(function (lb, i) {
        var x0 = padL + step * (i + 0.5) - (bw * k + gap * (k - 1)) / 2;
        opts.series.forEach(function (s, j) {
          var v = s.values[i];
          if (v == null || !isFinite(v)) return;
          var top = y(v), h = Math.max(0, padT + plotH - top), r = Math.min(4, bw / 2, h);
          var x = x0 + j * (bw + gap);
          // 위쪽 모서리만 둥글게(기준선 쪽은 각지게)
          var p = 'M' + x + ' ' + (top + h) + 'V' + (top + r) + 'Q' + x + ' ' + top + ' ' + (x + r) + ' ' + top +
            'H' + (x + bw - r) + 'Q' + (x + bw) + ' ' + top + ' ' + (x + bw) + ' ' + (top + r) + 'V' + (top + h) + 'Z';
          var b = el('path', { d: p, class: 'bar', style: 'fill:' + s.color });
          b.appendChild(el('title', null, lb + ' · ' + s.name + ' ' + fmt(v, unit)));
          svg.appendChild(b);
        });
      });
    }
    return svg;
  }
  /* 범례 — 계열이 둘 이상일 때만 */
  function legend(series) {
    var box = document.createElement('div'); box.className = 'legend';
    if (series.length < 2) return box;
    series.forEach(function (s) {
      var i = document.createElement('span'); i.className = 'lg';
      var sw = document.createElement('i'); sw.style.background = s.color; i.appendChild(sw);
      i.appendChild(document.createTextNode(s.name)); box.appendChild(i);
    });
    return box;
  }
  function figure(title, opts) {
    var f = document.createElement('figure'); f.className = 'fig';
    var cap = document.createElement('figcaption'); cap.textContent = title; f.appendChild(cap);
    opts.title = title;
    f.appendChild(legend(opts.series));
    f.appendChild(chart(opts));
    return f;
  }
  root.CastCharts = { chart: chart, figure: figure };
})(window);
