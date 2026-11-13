/* Explorer engine: draws the topology, plays the step animations,
   runs the simulator and renders the result charts. No dependencies. */
(() => {
  'use strict';
  const $ = sel => document.querySelector(sel);
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs, parent) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  };
  const htmlEl = (tag, cls, html, parent) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    if (parent) parent.appendChild(el);
    return el;
  };
  const key = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
  const LINK = {};
  LINKS.forEach(([a, b, bw, delay]) => { LINK[key(a, b)] = { a, b, bw, delay }; });

  const state = { ch: 0, st: 0, t: 0, playing: true, speed: 1, loops: 0, visited: new Set() };
  try { JSON.parse(localStorage.getItem('sdn-visited') || '[]').forEach(v => state.visited.add(v)); } catch (e) { /* storage unavailable */ }

  /* ------------------------------------------------------------------
     Static drawing: links, control channel, nodes
     ------------------------------------------------------------------ */
  const svg = $('#net');
  const layer = {};
  ['links', 'ctl', 'paths', 'nodes', 'badges', 'packets'].forEach(n => { layer[n] = svgEl('g', { class: 'layer-' + n }, svg); });
  const linkEls = {}, ctlEls = {}, nodeEls = {};

  [['CITY A', 190], ['CITY B', 500], ['CITY C', 810]].forEach(([name, x]) => {
    svgEl('text', { x, y: 22, class: 'city' }, layer.links).textContent = name;
  });

  LINKS.forEach(([a, b]) => {
    const A = NODES[a], B = NODES[b], k = key(a, b);
    const line = svgEl('line', { x1: A.x, y1: A.y, x2: B.x, y2: B.y, class: 'link' }, layer.links);
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
    // Label sits next to the middle of the link, pushed off the line
    const label = svgEl('text', { x: (A.x + B.x) / 2 - dy / len * 13, y: (A.y + B.y) / 2 + dx / len * 13 + 4, class: 'link-label' }, layer.links);
    linkEls[k] = { line, label };
  });

  SWITCHES.forEach(s => {
    const A = NODES.ctl, B = NODES[s];
    ctlEls[s] = svgEl('line', { x1: A.x, y1: A.y, x2: B.x, y2: B.y, class: 'ctl-line' }, layer.ctl);
  });

  Object.entries(NODES).forEach(([id, n]) => {
    const g = svgEl('g', { class: 'node ' + n.type, transform: `translate(${n.x},${n.y})`, 'data-id': id }, layer.nodes);
    let labelY = 4;
    if (n.type === 'client') {            // a desktop monitor
      svgEl('rect', { x: -19, y: -18, width: 38, height: 26, rx: 2.5, class: 'body' }, g);
      svgEl('path', { d: 'M-4 8 L-6 15 H6 L4 8 M-11 15.5 H11', class: 'detail' }, g);
      labelY = -1;
    } else if (n.type === 'switch') {     // a rack switch with a row of ports
      svgEl('rect', { x: -30, y: -16, width: 60, height: 32, rx: 3, class: 'body' }, g);
      for (let p = 0; p < 6; p++) svgEl('rect', { x: -23 + p * 8, y: 5, width: 5.5, height: 5, class: 'port' }, g);
      svgEl('circle', { cx: -23, cy: -9, r: 1.6, class: 'led' }, g);
      svgEl('circle', { cx: -18, cy: -9, r: 1.6, class: 'led' }, g);
      svgEl('path', { d: 'M14 -11 h8 m-3 -3 l3 3 l-3 3 M22 -5 h-8 m3 -3 l-3 3 l3 3', class: 'detail' }, g);
      labelY = 1;
    } else if (n.type === 'server') {     // a server rack: three units with drive bays
      svgEl('rect', { x: -24, y: -27, width: 48, height: 50, rx: 3, class: 'body' }, g);
      for (let u = 0; u < 3; u++) {
        const y = -22 + u * 15;
        svgEl('rect', { x: -19, y, width: 38, height: 11, rx: 1.5, class: 'unit' }, g);
        svgEl('circle', { cx: -14, cy: y + 5.5, r: 1.8, class: 'led' }, g);
        svgEl('path', { d: `M-4 ${y + 5.5} H14`, class: 'detail' }, g);
      }
      svgEl('text', { y: 50, class: 'note' }, g).textContent = n.note;
      labelY = 38;
    } else {
      svgEl('rect', { x: -62, y: -19, width: 124, height: 38, rx: 3, class: 'body' }, g);
    }
    const label = svgEl('text', { y: labelY, class: 'name' }, g);
    label.textContent = n.type === 'controller' ? 'CONTROLLER' : id;
    nodeEls[id] = g;
  });

  /* ------------------------------------------------------------------
     Geometry
     ------------------------------------------------------------------ */
  function pointOn(path, f) {
    const pts = path.map(id => NODES[id]);
    const seg = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      seg.push(l); total += l;
    }
    let d = Math.max(0, Math.min(1, f)) * total;
    for (let i = 0; i < seg.length; i++) {
      if (d <= seg[i] || i === seg.length - 1) {
        const r = seg[i] ? d / seg[i] : 0;
        return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * r, y: pts[i].y + (pts[i + 1].y - pts[i].y) * r };
      }
      d -= seg[i];
    }
    return pts[0];
  }
  const ease = f => (f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2);
  const pointsAttr = path => path.map(id => NODES[id].x + ',' + NODES[id].y).join(' ');

  function badgePos(id) {
    const n = NODES[id];
    if (n.type === 'client') return { x: n.x, y: n.y - 27 };
    if (n.type === 'server') return { x: n.x, y: n.y - 36 };
    if (n.type === 'controller') return { x: n.x, y: n.y - 28 };
    return { x: n.x + 34, y: n.y - 24, anchor: 'start' };
  }

  function drawBadge(id, text, cls) {
    const p = badgePos(id);
    const g = svgEl('g', { class: 'badge ' + (cls || ''), transform: `translate(${p.x},${p.y})` }, layer.badges);
    const w = text.length * 7.2 + 12;
    const x = p.anchor === 'start' ? 0 : -w / 2;
    svgEl('rect', { x, y: -11, width: w, height: 17, rx: 2 }, g);
    svgEl('text', { x: x + w / 2, y: 2 }, g).textContent = text;
  }

  /* ------------------------------------------------------------------
     Lesson rendering
     ------------------------------------------------------------------ */
  const chapter = () => CHAPTERS[state.ch];
  const step = () => chapter().steps[state.st];
  const stepDur = s => Math.max(2.4, ...(s.ev || []).map(e => e.t + e.d)) + 1.0;
  const visible = (item, t) => (item.after == null || t >= item.after) && (item.until == null || t < item.until);

  function clearDynamic() {
    layer.paths.replaceChildren();
    layer.badges.replaceChildren();
    layer.packets.replaceChildren();
  }

  function applyView(view, t, activeCtl) {
    const focus = view.focus;
    const has = (list, k) => (list || []).some(([a, b]) => key(a, b) === k);
    Object.entries(linkEls).forEach(([k, el]) => {
      const l = LINK[k];
      const dim = focus && !(focus.includes(l.a) && focus.includes(l.b));
      el.line.setAttribute('class', 'link' + (has(view.blocked, k) ? ' blocked' : '') + (has(view.hot, k) ? ' hot' : '') + (dim ? ' dim' : ''));
      let text = '';
      if (view.linkLabels === 'bw') text = l.bw + ' Mbps';
      if (view.linkLabels === 'delay') text = l.delay + ' ms';
      if (view.linkText && view.linkText[k]) text = view.linkText[k];
      el.label.textContent = dim ? '' : text;
    });
    Object.entries(nodeEls).forEach(([id, g]) => {
      const dim = focus && !focus.includes(id) && id !== 'ctl';
      g.classList.toggle('dim', !!dim);
    });
    nodeEls.ctl.classList.toggle('idle', !view.ctl && !activeCtl.size);
    SWITCHES.forEach(s => {
      ctlEls[s].setAttribute('class', 'ctl-line' + (activeCtl.has(s) ? ' active' : view.ctl ? ' on' : ''));
    });
    (view.paths || []).forEach(p => {
      if (visible(p, t)) svgEl('polyline', { points: pointsAttr(p.n), class: 'path ' + p.c }, layer.paths);
    });
    [view.badges, view.badges2].forEach(set => {
      Object.entries(set || {}).forEach(([id, b]) => { if (visible(b, t)) drawBadge(id, b.text, b.cls); });
    });
  }

  function drawPacket(p, kind, label, r) {
    const g = svgEl('g', { class: 'packet ' + kind, transform: `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})` }, layer.packets);
    svgEl('circle', { r: (r || 6) + 5, class: 'halo' }, g);
    svgEl('circle', { r: r || 6 }, g);
    if (label) {
      const w = label.length * 7 + 10;
      svgEl('rect', { x: -w / 2, y: -(r || 6) - 23, width: w, height: 16, rx: 2 }, g);
      svgEl('text', { y: -(r || 6) - 11 }, g).textContent = label;
    }
  }

  function renderLesson() {
    const s = step(), t = state.t, view = s.view || {};
    clearDynamic();
    const live = (s.ev || []).filter(e => !e.hidden && t >= e.t && t < e.t + e.d);
    const activeCtl = new Set();
    live.forEach(e => e.p.forEach((id, i) => {
      if (id === 'ctl') [e.p[i - 1], e.p[i + 1]].forEach(n => n && SWITCHES.includes(n) && activeCtl.add(n));
    }));
    applyView(view, state.loops ? Infinity : t, activeCtl);
    live.forEach(e => {
      const f = (t - e.t) / e.d;
      const pos = pointOn(e.p, e.swap != null ? f : ease(f));
      drawPacket(pos, e.k, typeof e.l === 'function' ? e.l(f) : e.l, e.r);
    });
    renderFlow();
  }

  /* ---- packet flow table ---- */
  let flowSig = '';
  function renderFlow() {
    const ch = chapter();
    const rows = [];
    let offset = 0;
    ch.steps.forEach((s, i) => {
      if (i > state.st) return;
      (s.ev || []).forEach(e => {
        if (!e.log) return;
        const shown = i < state.st || state.loops > 0 || state.t >= e.t;
        if (shown) rows.push({ time: offset + e.t, kind: e.k, log: e.log, current: i === state.st });
      });
      offset += stepDur(s);
    });
    rows.sort((a, b) => a.time - b.time);
    const sig = state.ch + ':' + state.st + ':' + rows.length;
    if (sig === flowSig) return;
    flowSig = sig;
    const body = $('#flow-body');
    body.replaceChildren();
    if (!rows.length) {
      htmlEl('div', 'flow-empty', 'No packets in this step. Read the panel on the right, then press NEXT.', body);
      return;
    }
    rows.forEach((r, i) => {
      const row = htmlEl('div', 'flow-row' + (r.current ? ' current' : ''), null, body);
      htmlEl('span', 'no ' + r.kind, String(i + 1), row);
      htmlEl('span', 'time', r.time.toFixed(3) + 's', row);
      htmlEl('span', null, r.log[0], row);
      htmlEl('span', null, r.log[1], row);
      htmlEl('span', 'proto ' + r.kind, r.log[2], row);
      htmlEl('span', 'info', r.log[3], row);
    });
    body.scrollTop = body.scrollHeight;
  }

  /* ---- right-hand panel ---- */
  function renderInfo() {
    const ch = chapter(), s = step();
    $('#info-kicker').textContent = ch.name.toUpperCase() + ' · STEP ' + (state.st + 1) + ' / ' + ch.steps.length;
    $('#info-title').textContent = s.title;
    $('#info-sub').textContent = s.sub || '';
    $('#info-text').innerHTML = s.text || '';
    const facts = $('#info-facts');
    facts.replaceChildren();
    (s.facts || []).forEach(([k, v]) => {
      const row = htmlEl('div', 'fact', null, facts);
      htmlEl('span', 'k', k, row);
      htmlEl('span', 'v', v, row);
    });
    const table = $('#info-table');
    table.replaceChildren();
    const tb = (s.view || {}).table;
    if (tb) {
      const head = htmlEl('div', 'trow head', null, table);
      tb.head.forEach(h => htmlEl('span', null, h, head));
      tb.rows.forEach((r, i) => {
        const row = htmlEl('div', 'trow' + (tb.win === i ? ' win' : ''), null, table);
        r.forEach(c => htmlEl('span', null, c, row));
      });
      table.style.setProperty('--cols', tb.head.length);
    }
    $('#info-code').innerHTML = s.code ? '<span>IN THE CODE</span> ' + s.code : '';
    document.body.dataset.plane = s.plane || 'both';
  }

  /* ---- chapter list ---- */
  function renderChapters() {
    const list = $('#chapters');
    list.replaceChildren();
    let total = 0;
    CHAPTERS.forEach((ch, ci) => {
      total += ch.steps.length;
      const done = ch.steps.every((_, si) => state.visited.has(ch.id + ':' + si));
      const item = htmlEl('div', 'chapter' + (ci === state.ch ? ' active' : '') + (done ? ' done' : ''), null, list);
      const btn = htmlEl('button', 'chapter-btn', null, item);
      htmlEl('span', 'dot', null, btn);
      htmlEl('span', 'label', `<b>${ch.name}</b><i>${ch.sub}</i>`, btn);
      htmlEl('span', 'chev', ci === state.ch ? '⌄' : '›', btn);
      btn.onclick = () => go(ci, 0);
      if (ci === state.ch && ch.steps.length > 1) {
        const steps = htmlEl('div', 'steps', null, item);
        ch.steps.forEach((s, si) => {
          const sb = htmlEl('button', 'step' + (si === state.st ? ' active' : '') + (state.visited.has(ch.id + ':' + si) ? ' seen' : ''), null, steps);
          htmlEl('span', 'num', String(si + 1), sb);
          htmlEl('span', 'label', `<b>${s.title}</b><i>${s.sub || ''}</i>`, sb);
          sb.onclick = () => go(ci, si);
        });
      }
    });
    const pct = Math.round(state.visited.size / total * 100);
    $('#progress-pct').textContent = pct + '%';
    $('#progress-bar').style.width = pct + '%';
    $('#progress-count').textContent = state.visited.size + ' / ' + total + ' STEPS';
  }

  function go(ci, si, opts) {
    state.ch = Math.max(0, Math.min(CHAPTERS.length - 1, ci));
    state.st = Math.max(0, Math.min(chapter().steps.length - 1, si));
    state.t = (opts && opts.t) || 0;
    state.loops = 0;
    state.playing = !(opts && opts.paused);
    flowSig = '';
    state.visited.add(chapter().id + ':' + state.st);
    try { localStorage.setItem('sdn-visited', JSON.stringify([...state.visited])); } catch (e) { /* storage unavailable */ }
    const kind = chapter().kind || 'lesson';
    document.body.dataset.kind = kind;
    const heads = { lesson: ['PACKET FLOW', 'NO,TIME,FROM,TO,TYPE,INFO'], sim: ['DECISIONS', 'NO,EVENT,CLIENT,SERVER,POLICY,WHAT THE CONTROLLER SAW'],
                    results: ['THE NUMBERS', ',SCENARIO,POLICY,QUALITY,STARTUP,DETAILS'] }[kind];
    $('#flow-title').textContent = heads[0];
    document.querySelectorAll('#flow-head span').forEach((el, i) => { el.textContent = heads[1].split(',')[i]; });
    renderChapters();
    if (kind === 'sim') { enterSim(); } else {
      renderInfo();
      if (kind === 'results') renderResults();
    }
    updateControls();
    const active = document.querySelector('.chapter.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function next() {
    if (state.st < chapter().steps.length - 1) go(state.ch, state.st + 1);
    else if (state.ch < CHAPTERS.length - 1) go(state.ch + 1, 0);
  }
  function prev() {
    if (state.st > 0) go(state.ch, state.st - 1);
    else if (state.ch > 0) go(state.ch - 1, CHAPTERS[state.ch - 1].steps.length - 1);
  }

  function updateControls() {
    $('#btn-play').innerHTML = state.playing ? '❚❚ &nbsp;PAUSE' : '▶ &nbsp;PLAY';
    $('#btn-prev').disabled = state.ch === 0 && state.st === 0;
    const last = state.ch === CHAPTERS.length - 1 && state.st === chapter().steps.length - 1;
    $('#btn-next').disabled = last;
    const endOfChapter = state.st === chapter().steps.length - 1;
    $('#btn-next').innerHTML = (endOfChapter && !last ? 'NEXT CHAPTER' : 'NEXT') + ' &nbsp;▶';
  }

  /* ------------------------------------------------------------------
     Simulator: the same decision rules as sdn_controller.py, run on an
     idealised network (each stream wants 5 Mbps, measurements are exact).
     ------------------------------------------------------------------ */
  const sim = { mode: 'hop', sessions: [], rows: [], last: null, timers: [] };
  const NEIGHBOUR_ORDER = ['c1', 'c2', 'd1', 'e1', 'e2', 'e3'];
  const ADJ = {};
  LINKS.forEach(([a, b]) => { (ADJ[a] = ADJ[a] || []).push(b); (ADJ[b] = ADJ[b] || []).push(a); });
  Object.values(ADJ).forEach(list => list.sort((x, y) => {
    const ix = NEIGHBOUR_ORDER.indexOf(x), iy = NEIGHBOUR_ORDER.indexOf(y);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
  }));
  const pathCache = {};
  function shortestPath(src, dst) {
    const k = src + '>' + dst;
    if (pathCache[k]) return pathCache[k];
    const parent = { [src]: null }, queue = [src];
    while (queue.length) {
      const u = queue.shift();
      if (u === dst) break;
      for (const v of ADJ[u]) {
        if (v in parent || (v !== dst && !SWITCHES.includes(v))) continue;
        parent[v] = u; queue.push(v);
      }
    }
    const path = [];
    for (let n = dst; n; n = parent[n]) path.unshift(n);
    return (pathCache[k] = path);
  }

  const STREAM = 5;   // Mbps a 720p stream wants
  function linkLoad(sessions) {
    // directed "from>to" (server towards client) -> number of streams
    const load = {};
    sessions.forEach(s => {
      for (let i = s.path.length - 1; i > 0; i--) {
        const k = s.path[i] + '>' + s.path[i - 1];
        load[k] = (load[k] || 0) + 1;
      }
    });
    return load;
  }
  function measure(sessions) {
    const load = linkLoad(sessions);
    return {
      free: (u, v) => Math.max(LINK[key(u, v)].bw - STREAM * (load[u + '>' + v] || 0), 0),
      // A saturated link queues packets: the measured delay goes up
      delay: (u, v) => {
        const l = LINK[key(u, v)];
        const n = Math.max(load[u + '>' + v] || 0, load[v + '>' + u] || 0);
        return l.delay + (STREAM * n >= l.bw ? 25 : 0);
      },
    };
  }
  function sessionCount(sessions) {
    const n = {};
    SERVERS.forEach(s => { n[s] = sessions.filter(x => x.server === s).length; });
    return n;
  }

  function choose(client, m, sessions) {
    const count = sessionCount(sessions);
    const info = {};
    SERVERS.forEach(srv => {
      const path = shortestPath(client, srv);
      let free = Infinity, delay = 0;
      for (let i = 0; i < path.length - 1; i++) free = Math.min(free, m.free(path[i + 1], path[i]));
      for (let i = 1; i < path.length - 1; i++) delay += m.delay(path[i], path[i + 1]);
      info[srv] = { path, hops: path.length - 1, free, delay, sessions: count[srv] };
    });
    const best = (score, bigger) => SERVERS.reduce((a, b) => {
      const sa = score(a), sb = score(b);
      const better = Array.isArray(sa) ? (sb[0] < sa[0] || (sb[0] === sa[0] && sb[1] < sa[1])) : (bigger ? sb > sa : sb < sa);
      return better ? b : a;
    });
    let server;
    if (sim.mode === 'hop') server = best(s => info[s].hops);
    if (sim.mode === 'load') server = best(s => [info[s].sessions, info[s].hops]);
    if (sim.mode === 'bw') server = best(s => info[s].free, true);
    if (sim.mode === 'delay') server = best(s => info[s].delay);
    if (sim.mode === 'combo') {
      const max = f => Math.max(...SERVERS.map(s => f(info[s]))) || 1;
      const mh = max(i => i.hops), md = max(i => i.delay), mf = max(i => i.free), ms = max(i => i.sessions);
      SERVERS.forEach(s => {
        const i = info[s];
        i.score = 0.25 * i.hops / mh + 0.25 * i.delay / md + 0.25 * (1 - i.free / mf) + 0.25 * i.sessions / ms;
      });
      server = best(s => info[s].score);
    }
    return { client, server, info };
  }

  function addClient(client, m) {
    if (sim.sessions.some(s => s.client === client)) return;
    const d = choose(client, m || measure(sim.sessions), sim.sessions);
    sim.sessions.push({ client, server: d.server, path: d.info[d.server].path });
    sim.last = d;
    const fmt = { hop: i => i.hops, load: i => i.sessions, bw: i => i.free, delay: i => i.delay + ' ms', combo: i => i.score.toFixed(2) };
    sim.rows.push([client, d.server, sim.mode.toUpperCase(),
      SERVERS.map(s => s + ' ' + fmt[sim.mode](d.info[s])).join(' · ') + '  →  path ' + d.info[d.server].path.join('-')]);
    renderSimPanel();
  }
  function clearSim() {
    sim.timers.forEach(clearTimeout);
    sim.timers = []; sim.sessions = []; sim.rows = []; sim.last = null;
    renderSimPanel();
  }
  function flashCrowd() {
    clearSim();
    const stale = measure([]);            // everyone decides on the same old measurement
    CLIENTS.forEach(c => addClient(c, stale));
  }
  function gradual() {
    clearSim();
    ['h1', 'h4', 'h7', 'h2', 'h5', 'h8', 'h3', 'h6', 'h9'].forEach((c, i) => {
      sim.timers.push(setTimeout(() => addClient(c), 350 * i));
    });
  }

  function quality(session, load) {
    let share = Infinity;
    for (let i = session.path.length - 1; i > 0; i--) {
      const u = session.path[i], v = session.path[i - 1];
      share = Math.min(share, LINK[key(u, v)].bw / load[u + '>' + v]);
    }
    const budget = 0.8 * share;
    return budget >= 5 ? [5000, '720p'] : budget >= 2.5 ? [2500, '540p'] : [1000, '360p'];
  }

  const MODE_HELP = {
    hop: 'Nearest server by link count. Never looks at the network state.',
    load: 'Fewest active sessions, ties broken by hops. Updates instantly.',
    bw: 'Largest free bandwidth on the path (its thinnest link). Measured every 2 s.',
    delay: 'Smallest measured delay on the path. Measured every 5 s.',
    combo: 'Hops, delay, bandwidth and load, normalised and averaged. Lowest score wins.',
  };

  function enterSim() {
    $('#info-kicker').textContent = 'SIMULATOR';
    $('#info-title').textContent = 'Try it yourself';
    $('#info-sub').textContent = 'Same decision rules as the controller';
    document.body.dataset.plane = 'both';
    renderSimPanel();
  }

  function renderSimPanel() {
    if ((chapter().kind || '') !== 'sim') return;
    const box = $('#info-text');
    box.innerHTML = '';
    htmlEl('div', 'sim-label', 'POLICY', box);
    const pills = htmlEl('div', 'pills', null, box);
    MODES.forEach(m => {
      const b = htmlEl('button', 'pill' + (m === sim.mode ? ' active' : ''), m.toUpperCase(), pills);
      b.onclick = () => { sim.mode = m; clearSim(); };
    });
    htmlEl('p', 'sim-help', MODE_HELP[sim.mode], box);
    htmlEl('div', 'sim-label', 'ARRIVALS', box);
    const actions = htmlEl('div', 'sim-actions', null, box);
    htmlEl('button', 'btn primary', 'FLASH CROWD', actions).onclick = flashCrowd;
    htmlEl('button', 'btn', 'GRADUAL', actions).onclick = gradual;
    htmlEl('button', 'btn', 'CLEAR', actions).onclick = clearSim;
    htmlEl('p', 'sim-help', '<b>Flash crowd</b>: all nine decide on the same, already outdated measurement. <b>Gradual</b>: one by one, each sees the traffic of those before. Or <b>click any client</b> in the picture to start or stop its stream.', box);

    const load = linkLoad(sim.sessions);
    const count = sessionCount(sim.sessions);
    const facts = $('#info-facts');
    facts.replaceChildren();
    const q = sim.sessions.map(s => quality(s, load)[0]);
    const row = (k, v) => { const r = htmlEl('div', 'fact', null, facts); htmlEl('span', 'k', k, r); htmlEl('span', 'v', v, r); };
    row('Streaming', sim.sessions.length + ' of 9 clients');
    row('srv1 / srv2 / srv3 / srv4', SERVERS.map(s => count[s]).join(' / '));
    row('Estimated quality', q.length ? Math.round(q.reduce((a, b) => a + b, 0) / q.length) + ' kbps average' : '-');

    const table = $('#info-table');
    table.replaceChildren();
    if (sim.last) {
      const d = sim.last;
      const cols = ['Server', 'Hops', 'Delay', 'Free', 'Sess.'].concat(sim.mode === 'combo' ? ['Score'] : []);
      htmlEl('div', 'sim-label', 'LAST DECISION · ' + d.client.toUpperCase() + ' → ' + d.server.toUpperCase(), table);
      const head = htmlEl('div', 'trow head', null, table);
      cols.forEach(c => htmlEl('span', null, c, head));
      SERVERS.forEach(s => {
        const i = d.info[s];
        const r = htmlEl('div', 'trow' + (s === d.server ? ' win' : ''), null, table);
        [s, i.hops, i.delay + ' ms', i.free, i.sessions].concat(sim.mode === 'combo' ? [i.score.toFixed(2)] : [])
          .forEach(c => htmlEl('span', null, String(c), r));
      });
      table.style.setProperty('--cols', cols.length);
    }
    $('#info-code').innerHTML = '<span>IDEALISED MODEL</span> every stream wants 5 Mbps, measurements are exact. The real runs are noisier: see Results.';

    const body = $('#flow-body');
    body.replaceChildren();
    if (!sim.rows.length) htmlEl('div', 'flow-empty', 'No sessions yet. Press FLASH CROWD or GRADUAL, or click a client.', body);
    sim.rows.forEach((r, i) => {
      const el = htmlEl('div', 'flow-row current', null, body);
      htmlEl('span', 'no ctrl', String(i + 1), el);
      htmlEl('span', 'time', 'arrival', el);
      htmlEl('span', null, r[0], el);
      htmlEl('span', null, r[1], el);
      htmlEl('span', 'proto ctrl', r[2], el);
      htmlEl('span', 'info', r[3], el);
    });
    body.scrollTop = body.scrollHeight;
  }

  function renderSim(now) {
    clearDynamic();
    const load = linkLoad(sim.sessions);
    const count = sessionCount(sim.sessions);
    const hot = [], linkText = {};
    Object.keys(LINK).forEach(k => {
      const l = LINK[k];
      const n = Math.max(load[l.a + '>' + l.b] || 0, load[l.b + '>' + l.a] || 0);
      if (!n) return;
      linkText[k] = Math.min(n * STREAM, l.bw) + '/' + l.bw;
      if (n * STREAM >= l.bw) hot.push([l.a, l.b]);
    });
    const badges = {};
    SERVERS.forEach(s => { if (count[s]) badges[s] = { text: count[s] + (count[s] === 1 ? ' session' : ' sessions') }; });
    sim.sessions.forEach(s => {
      const q = quality(s, load)[1];
      badges[s.client] = { text: q, cls: 'q' + q };
    });
    const paths = sim.sessions.map(s => ({ n: s.path, c: 'srv' + (SERVERS.indexOf(s.server) + 1) }));
    applyView({ hot, linkText, badges, paths }, 0, new Set());
    sim.sessions.forEach((s, i) => {
      const route = s.path.slice().reverse();
      for (let k = 0; k < 2; k++) {
        const f = ((now / 1000) * 0.45 + i * 0.13 + k * 0.5) % 1;
        drawPacket(pointOn(route, f), 'video srv' + (SERVERS.indexOf(s.server) + 1), '', 4);
      }
    });
    Object.entries(nodeEls).forEach(([id, g]) => g.classList.toggle('streaming', sim.sessions.some(s => s.client === id)));
  }

  svg.addEventListener('click', ev => {
    const g = ev.target.closest('.node.client');
    if (!g || (chapter().kind || '') !== 'sim') return;
    const id = g.dataset.id;
    if (sim.sessions.some(s => s.client === id)) {
      sim.sessions = sim.sessions.filter(s => s.client !== id);
      sim.rows.push([id, '-', 'LEFT', 'session ended, its rules idle out and the counter goes down']);
      renderSimPanel();
    } else {
      addClient(id);
    }
  });

  /* ------------------------------------------------------------------
     Results charts
     ------------------------------------------------------------------ */
  const METRICS = {
    q: { name: 'QUALITY', unit: 'kbps', better: 'high', get: r => r.q, fmt: v => String(v), max: 5000, note: 'Average bitrate watched. 5000 = everyone at 720p.' },
    start: { name: 'STARTUP', unit: 's', better: 'low', get: r => r.start, fmt: v => v.toFixed(2), max: 1, note: 'Seconds until playback starts.' },
    stalls: { name: 'STALLS', unit: 'per run', better: 'low', get: r => r.stalls, fmt: v => v.toFixed(1), max: 1.5, note: 'Times the picture froze, per run of 9 clients.' },
    std: { name: 'SPREAD', unit: 'kbps', better: 'low', get: r => r.std, fmt: v => '±' + v, max: 520, note: 'Standard deviation of quality between runs. Lower = more predictable.' },
  };
  let metric = 'q';

  function renderResults() {
    const s = step();
    const root = $('#charts');
    root.replaceChildren();
    const m = METRICS[metric];
    const tabs = htmlEl('div', 'pills', null, root);
    Object.entries(METRICS).forEach(([id, mm]) => {
      htmlEl('button', 'pill' + (id === metric ? ' active' : ''), mm.name, tabs).onclick = () => { metric = id; renderResults(); };
    });
    htmlEl('span', 'chart-note', m.note + (m.better === 'low' ? ' Lower is better.' : ' Higher is better.'), tabs);

    const cols = htmlEl('div', 'chart-cols', null, root);
    const SCEN = { flash: 'FLASH CROWD · all 9 at once', gradual: 'GRADUAL · one every 3 s' };
    Object.entries(SCEN).forEach(([sc, title]) => {
      const col = htmlEl('div', 'chart' + (s.show !== 'both' && s.show !== sc ? ' dim' : ''), null, cols);
      htmlEl('h4', null, title, col);
      const values = MODES.map(md => m.get(RESULTS[sc][md]));
      const bestVal = m.better === 'high' ? Math.max(...values) : Math.min(...values);
      MODES.forEach((md, i) => {
        const r = RESULTS[sc][md];
        const row = htmlEl('div', 'bar-row' + (values[i] === bestVal ? ' best' : ''), null, col);
        row.title = `${md}: quality ${r.q} kbps (runs ${r.min}-${r.max}), startup ${r.start} s, ${r.stalls} stalls per run, ${r.sw} quality switches per client`;
        htmlEl('span', 'bar-label', md, row);
        const track = htmlEl('span', 'bar-track', null, row);
        const bar = htmlEl('span', 'bar', null, track);
        bar.style.width = Math.max(values[i] / m.max * 100, 0.6) + '%';
        if (metric === 'q') {
          const w = htmlEl('span', 'whisker', null, track);
          w.style.left = r.min / m.max * 100 + '%';
          w.style.width = (r.max - r.min) / m.max * 100 + '%';
        }
        htmlEl('span', 'bar-value', m.fmt(values[i]) + (values[i] === bestVal ? ' <em>best</em>' : ''), row);
      });
    });

    const head = htmlEl('div', 'dist-head', null, root);
    htmlEl('h4', null, 'WHERE THE 9 CLIENTS WENT · average per run', head);
    const legend = htmlEl('div', 'legend', null, head);
    SERVERS.forEach((srv, i) => htmlEl('span', 'legend-item', `<i class="sw srv${i + 1}"></i>${srv}`, legend));
    const cols2 = htmlEl('div', 'chart-cols', null, root);
    Object.keys(SCEN).forEach(sc => {
      const col = htmlEl('div', 'chart' + (s.show !== 'both' && s.show !== sc ? ' dim' : ''), null, cols2);
      MODES.forEach(md => {
        const r = RESULTS[sc][md];
        const row = htmlEl('div', 'bar-row', null, col);
        htmlEl('span', 'bar-label', md, row);
        const track = htmlEl('span', 'bar-track stack', null, row);
        r.srv.forEach((n, i) => {
          if (!n) return;
          const seg = htmlEl('span', 'seg srv' + (i + 1), n >= 1 ? n.toFixed(1) : '', track);
          seg.style.flex = n;
          seg.title = `${md}: ${n.toFixed(1)} clients on ${SERVERS[i]}`;
        });
      });
    });

    // The same numbers as a table, in the bottom panel
    const body = $('#flow-body');
    body.replaceChildren();
    const shown = s.show === 'both' ? ['flash', 'gradual'] : [s.show];
    shown.forEach(sc => MODES.forEach(md => {
      const r = RESULTS[sc][md];
      const el = htmlEl('div', 'flow-row current', null, body);
      htmlEl('span', 'no data', sc === 'flash' ? 'F' : 'G', el);
      htmlEl('span', 'time', sc, el);
      htmlEl('span', null, md, el);
      htmlEl('span', null, r.q + ' kbps', el);
      htmlEl('span', 'proto data', r.start.toFixed(2) + ' s', el);
      htmlEl('span', 'info', `runs ${r.min}-${r.max} kbps · spread ±${r.std} · ${r.stalls.toFixed(1)} stalls/run · ${r.sw.toFixed(1)} switches/client · servers ${r.srv.map(n => n.toFixed(1)).join(' / ')}`, el);
    }));
  }

  /* ------------------------------------------------------------------
     Main loop and controls
     ------------------------------------------------------------------ */
  let lastFrame = 0;
  function frame(now) {
    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;
    const kind = chapter().kind || 'lesson';
    if (kind === 'sim') {
      renderSim(now);
    } else if (kind === 'lesson') {
      if (state.playing) {
        state.t += dt * state.speed;
        if (state.t >= stepDur(step())) { state.t = 0; state.loops++; }
      }
      renderLesson();
    }
    requestAnimationFrame(frame);
  }

  $('#btn-play').onclick = () => { state.playing = !state.playing; updateControls(); };
  $('#btn-next').onclick = next;
  $('#btn-prev').onclick = prev;
  $('#btn-restart').onclick = () => go(state.ch, 0);
  $('#speed').onchange = e => { state.speed = parseFloat(e.target.value); };
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
    if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === ' ') { e.preventDefault(); state.playing = !state.playing; updateControls(); }
  });

  const root = document.documentElement;
  function setTheme(theme) {
    root.dataset.theme = theme;
    try { localStorage.setItem('sdn-theme', theme); } catch (e) { /* storage unavailable */ }
  }
  $('#btn-theme').onclick = () => setTheme(root.dataset.theme === 'light' ? 'dark' : 'light');

  // Deep link, e.g. index.html#c=3&s=4&t=1.2&paused=1&theme=light
  const params = new URLSearchParams(location.hash.slice(1));
  let saved = null;
  try { saved = localStorage.getItem('sdn-theme'); } catch (e) { /* storage unavailable */ }
  root.dataset.theme = params.get('theme') || saved || 'dark';
  go(parseInt(params.get('c') || '0', 10), parseInt(params.get('s') || '0', 10),
     { t: parseFloat(params.get('t') || '0'), paused: params.has('paused') });
  if (params.get('sim')) { sim.mode = params.get('sim'); params.get('arrive') === 'gradual' ? gradual() : flashCrowd(); }
  if (params.get('metric')) { metric = params.get('metric'); if (chapter().kind === 'results') renderResults(); }
  requestAnimationFrame(t => { lastFrame = t; frame(t); });
})();
