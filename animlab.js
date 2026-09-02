/**
 * animlab - paste into the DevTools console on any page.
 *
 * Keyframe animation lab built on motion.dev.
 *
 * Model: a sequence is a list of segments. A segment is one element plus one
 * property plus its keyframes, drawn as a labelled band. Segments share a lane
 * whenever they do not overlap in time, so a long sequence stays shallow.
 *
 * Targets: anything you pick, plus @cursor (a fake pointer) and @page (zoom and
 * pan the document). Event segments fire real pointer, wheel and keyboard
 * events, which is how you drive a canvas or WebGL scene.
 *
 * Selecting works the same at all three scales: a keyframe, a segment band, or
 * a coloured group bar. Click takes one, shift-click adds it or removes it, and
 * dragging anything in the selection moves all of it with spacing preserved.
 * Drag empty lane space to marquee. Hold alt for free timing with no snapping.
 *
 * Keys:  h hide UI · space play · g group · shift-g ungroup · r range from
 *        selection · delete removes selection · esc clears
 *
 * window.__animLab.destroy() to remove.
 */
(async () => {
  if (window.__animLab) {
    window.__animLab.toggle();
    return;
  }

  /* ---------- motion.dev ---------- */

  let M;
  try {
    M = await import('https://cdn.jsdelivr.net/npm/motion@12/+esm');
  } catch (e1) {
    try {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/motion@12/dist/motion.js';
        s.onload = res;
        s.onerror = rej;
        document.head.appendChild(s);
      });
      M = window.Motion;
    } catch (e2) {
      console.error(
        '[animlab] could not load motion.dev. The page CSP is blocking jsDelivr.\n' +
        'Load it via a userscript manager (@require) or a DevTools local override.'
      );
      return;
    }
  }
  const { animate } = M;

  // cbor-x arrives the same way. A failure here only costs the binary save
  // format, so it warns and carries on rather than taking the tool down.
  let cborLib = null;
  try {
    cborLib = await import('https://cdn.jsdelivr.net/npm/cbor-x@1/+esm');
  } catch (err) {
    console.warn('[animlab] cbor-x unavailable, saves will use json:', err.message);
  }

  /* ---------- constants ---------- */

  const SNAP = 0.05;
  const MIN_ADVANCE = 0.25;   // how far a zero-length item nudges the playhead
  const AUDIO_H = 46;
  const PEAKS_PER_SEC = 200;
  const GUTTER = 54;
  const RULER_H = 22;
  const RANGE_H = 14;
  const LANE_H = 32;
  const EVT = '@events';
  const LS_PREFIX = 'animlab:seq:';
  const LS_INDEX = 'animlab:index';

  const TRANSFORMS = { x: 0, y: 0, rotate: 0, scale: 1, scaleX: 1, scaleY: 1, skewX: 0 };

  const SPEC = {
    x:               { group: 'Transform',  kind: 'number', to: 200,  hint: 'px' },
    y:               { group: 'Transform',  kind: 'number', to: 200,  hint: 'px' },
    scale:           { group: 'Transform',  kind: 'number', to: 1.4,  hint: '×' },
    scaleX:          { group: 'Transform',  kind: 'number', to: 1.4,  hint: '×' },
    scaleY:          { group: 'Transform',  kind: 'number', to: 1.4,  hint: '×' },
    rotate:          { group: 'Transform',  kind: 'number', to: 45,   hint: 'deg' },
    skewX:           { group: 'Transform',  kind: 'number', to: 12,   hint: 'deg' },
    opacity:         { group: 'Appearance', kind: 'number', to: 0,    hint: '0-1' },
    backgroundColor: { group: 'Appearance', kind: 'color',  to: '#7ee0c0' },
    color:           { group: 'Appearance', kind: 'color',  to: '#ffffff' },
    borderColor:     { group: 'Appearance', kind: 'color',  to: '#7ee0c0' },
    width:           { group: 'Layout',     kind: 'number', to: 400,  hint: 'px' },
    height:          { group: 'Layout',     kind: 'number', to: 400,  hint: 'px' },
    borderRadius:    { group: 'Layout',     kind: 'number', to: 24,   hint: 'px' },
    filter:          { group: 'Effects',    kind: 'text',   to: 'blur(6px)' },
    boxShadow:       { group: 'Effects',    kind: 'text',   to: '0 20px 60px rgba(0,0,0,.5)' },
    clipPath:        { group: 'Effects',    kind: 'text',   to: 'inset(0 0 0 0)' },
  };

  const EASES = [
    'easeOut', 'easeIn', 'easeInOut', 'linear', 'circOut', 'circInOut',
    'backOut', 'backInOut', 'anticipate', '[.17,.67,.3,1.33]',
  ];

  const EVENTS = {
    click:      { label: 'left click',  seq: [['pointerdown', 0], ['mousedown', 0], ['pointerup', 0], ['mouseup', 0], ['click', 0]] },
    rightclick: { label: 'right click', seq: [['pointerdown', 2], ['mousedown', 2], ['pointerup', 2], ['mouseup', 2], ['contextmenu', 2]] },
    dblclick:   { label: 'double click', seq: [['pointerdown', 0], ['mousedown', 0], ['pointerup', 0], ['mouseup', 0], ['click', 0], ['pointerdown', 0], ['mousedown', 0], ['pointerup', 0], ['mouseup', 0], ['click', 0], ['dblclick', 0]] },
    down:       { label: 'press down',  seq: [['pointerdown', 0], ['mousedown', 0]] },
    up:         { label: 'release',     seq: [['pointerup', 0], ['mouseup', 0], ['click', 0]] },
    rightdown:  { label: 'right down',  seq: [['pointerdown', 2], ['mousedown', 2]] },
    rightup:    { label: 'right up',    seq: [['pointerup', 2], ['mouseup', 2]] },
    move:       { label: 'pointer move', seq: [['pointermove', -1], ['mousemove', -1]] },
    hover:      { label: 'hover in',    seq: [['pointerover', -1], ['mouseover', -1], ['pointerenter', -1], ['mouseenter', -1]] },
    leave:      { label: 'hover out',   seq: [['pointerout', -1], ['mouseout', -1], ['pointerleave', -1], ['mouseleave', -1]] },
    wheelUp:    { label: 'wheel up',    wheel: -120 },
    wheelDown:  { label: 'wheel down',  wheel: 120 },
    focus:      { label: 'focus field', focus: true },
    text:       { label: 'type char',   text: true,  detailHint: 'the character' },
    backspace:  { label: 'backspace',   back: true },
    clearText:  { label: 'clear field', wipe: true },
    key:        { label: 'key press',   key: true,   detailHint: 'key name, e.g. Enter' },
  };

  const snapT = (v, free) => (free ? Math.max(0, v) : Math.max(0, Math.round(v / SNAP) * SNAP));
  const round = (v) => Math.round(v * 1000) / 1000;
  const coerce = (v) => (/^-?\d*\.?\d+$/.test(String(v).trim()) ? parseFloat(v) : v);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const groupHue = (g) => (g * 67) % 360;
  const shortSel = (s) => (s.length > 22 ? s.slice(0, 10) + '…' + s.slice(-10) : s);

  function parseEase(e) {
    const s = String(e || 'easeOut').trim();
    if (s.startsWith('[')) {
      try {
        const a = JSON.parse(s);
        if (Array.isArray(a) && a.length === 4) return a;
      } catch (_) { /* fall through */ }
    }
    return s;
  }

  /* ---------- presets ---------- */

  function oscillate(amp, count) {
    const out = [[0, 0, 'linear']];
    for (let i = 1; i <= count; i++) {
      const decay = 1 - i / (count + 1);
      out.push([i / (count + 1), (i % 2 ? 1 : -1) * amp * decay, 'linear']);
    }
    out.push([1, 0, 'linear']);
    return out;
  }

  const PRESETS = {
    shake:      (a) => [{ prop: 'x', keys: oscillate(a, 6) }],
    wiggle:     (a) => [{ prop: 'rotate', keys: oscillate(a / 6, 5) }],
    pulse:      (a) => [{ prop: 'scale', keys: [[0, 1, 'linear'], [0.5, 1 + a / 100, 'easeOut'], [1, 1, 'easeIn']] }],
    heartbeat:  (a) => [{ prop: 'scale', keys: [[0, 1, 'linear'], [0.18, 1 + a / 80, 'easeOut'], [0.36, 1, 'easeIn'], [0.54, 1 + a / 110, 'easeOut'], [1, 1, 'easeIn']] }],
    bounce:     (a) => [{ prop: 'y', keys: [[0, 0, 'linear'], [0.35, -a, 'easeOut'], [0.62, 0, 'easeIn'], [0.8, -a * 0.28, 'easeOut'], [1, 0, 'easeIn']] }],
    pop: (a) => [
      { prop: 'scale', keys: [[0, 0.7, 'linear'], [0.65, 1 + a / 250, 'backOut'], [1, 1, 'easeOut']] },
      { prop: 'opacity', keys: [[0, 0, 'linear'], [0.4, 1, 'easeOut'], [1, 1, 'linear']] },
    ],
    flash:      () => [{ prop: 'opacity', keys: [[0, 1, 'linear'], [0.25, 0, 'linear'], [0.5, 1, 'linear'], [0.75, 0, 'linear'], [1, 1, 'linear']] }],
    spin:       () => [{ prop: 'rotate', keys: [[0, 0, 'linear'], [1, 360, 'easeInOut']] }],
    rubberBand: (a) => [
      { prop: 'scaleX', keys: [[0, 1, 'linear'], [0.3, 1 + a / 130, 'easeOut'], [0.55, 1 - a / 220, 'easeInOut'], [1, 1, 'easeOut']] },
      { prop: 'scaleY', keys: [[0, 1, 'linear'], [0.3, 1 - a / 200, 'easeOut'], [0.55, 1 + a / 260, 'easeInOut'], [1, 1, 'easeOut']] },
    ],
    float:      (a) => [{ prop: 'y', keys: [[0, 0, 'linear'], [0.25, -a / 3, 'easeInOut'], [0.5, 0, 'easeInOut'], [0.75, a / 4, 'easeInOut'], [1, 0, 'easeInOut']] }],
    fadeIn:     () => [{ prop: 'opacity', keys: [[0, 0, 'linear'], [1, 1, 'easeOut']] }],
    fadeOut:    () => [{ prop: 'opacity', keys: [[0, 1, 'linear'], [1, 0, 'easeIn']] }],
    slideInUp: (a) => [
      { prop: 'y', keys: [[0, a, 'linear'], [1, 0, 'backOut']] },
      { prop: 'opacity', keys: [[0, 0, 'linear'], [0.5, 1, 'easeOut'], [1, 1, 'linear']] },
    ],
    slideInLeft: (a) => [
      { prop: 'x', keys: [[0, -a, 'linear'], [1, 0, 'backOut']] },
      { prop: 'opacity', keys: [[0, 0, 'linear'], [0.5, 1, 'easeOut'], [1, 1, 'linear']] },
    ],
    attention: (a) => [
      { prop: 'scale', keys: [[0, 1, 'linear'], [0.4, 1 + a / 90, 'easeOut'], [1, 1, 'easeInOut']] },
      { prop: 'rotate', keys: oscillate(a / 10, 4) },
    ],
  };

  /* ---------- state ---------- */

  let segs = [];               // { id, sel, prop, lane, keys: [{id,t,val,ease,g}] }
  let laneCount = 1;
  let anims = [];
  let markers = [];
  let originals = new Map();
  let selectedEl = null;
  let selection = new Set();   // "segId:keyId"
  let primary = null;          // { segId, keyId }
  let keyNodes = [];
  let segNodes = new Map();  // segId -> live DOM refs, for redrawing mid-drag
  let range = null;
  let ripple = true;
  let picking = false;
  let resetOnEnd = true;
  let liveMove = true;
  let playing = false;
  let hidden = false;
  let time = 0;
  let total = 0;
  let pps = 120;
  let nextId = 1;
  let nextGid = 1;
  let raf = null;
  let last = 0;
  let downButtons = 0;
  let focusedField = null;
  let autoAdvance = true;
  let audioClips = [];        // { id, name, buffer, peaks, offset, inPoint, outPoint }
  let actx = null;            // lazy AudioContext
  let audioGain = null;
  let audioDest = null;       // tap for the video recorder
  let liveSources = [];       // scheduled AudioBufferSourceNodes
  let audioAnchor = null;     // { ctxStart, timeStart } while playing
  let micRec = null;          // an in-progress take
  let takeNo = 0;
  const audioSources = new Map();   // sourceId -> { name, mime, bytes }
  let selectedClip = null;
  let recBar = null;
  let mode = 'bottom';        // bottom | top | float
  let popup = null;
  let floatBox = { x: 60, y: 60, w: 900, h: 340 };
  let dockH = 300;

  const refOf = (sg, k) => sg.id + ':' + k.id;
  const isEventSeg = (sg) => sg.prop === EVT;
  const segStart = (sg) => (sg.keys.length ? Math.min(...sg.keys.map((k) => k.t)) : 0);
  const segEnd = (sg) => (sg.keys.length ? Math.max(...sg.keys.map((k) => k.t)) : 0);
  const segLabel = (sg) => `${shortSel(sg.sel)} · ${isEventSeg(sg) ? 'events' : sg.prop}`;

  function selected() {
    const out = [];
    segs.forEach((sg) => sg.keys.forEach((k) => {
      if (selection.has(refOf(sg, k))) out.push({ sg, k });
    }));
    return out;
  }

  function selectOnly(sg, k) {
    selection = new Set([refOf(sg, k)]);
    primary = { segId: sg.id, keyId: k.id };
  }

  function selectGroup(gid) {
    selection = new Set();
    let first = null;
    segs.forEach((sg) => sg.keys.forEach((k) => {
      if (k.g === gid) {
        selection.add(refOf(sg, k));
        if (!first) first = { segId: sg.id, keyId: k.id };
      }
    }));
    primary = first;
  }

  function clearSelection() {
    selection = new Set();
    primary = null;
  }

  /* ---------- synthetic targets ---------- */

  // absolute, not fixed, so its coordinates are page space and it stays glued
  // to whatever it was aimed at when the page scrolls
  const cursor = document.createElement('div');
  cursor.setAttribute('data-animlab', 'cursor');
  cursor.style.cssText =
    'position:absolute;top:0;left:0;width:26px;height:26px;pointer-events:none;' +
    'z-index:2147483644;transform-origin:4px 3px;opacity:0;';
  cursor.innerHTML =
    '<svg viewBox="0 0 26 26" width="26" height="26">' +
    '<path d="M4 2 L4 20 L9 15.5 L12.5 23 L16 21.4 L12.6 14.2 L19 14 Z" ' +
    'fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(cursor);

  function pageOn() {
    document.body.style.transformOrigin = '0 0';
    document.body.style.willChange = 'transform';
  }

  const resolve = (sel) =>
    sel === '@cursor' ? cursor : sel === '@page' ? document.body : document.querySelector(sel);

  function readValue(sel, prop) {
    const el = resolve(sel);
    if (sel === '@cursor' && (prop === 'x' || prop === 'y')) {
      const r = cursor.getBoundingClientRect();
      return prop === 'x' ? round(r.left + window.scrollX) : round(r.top + window.scrollY);
    }
    if (prop === 'opacity') {
      if (!el) return 1;
      const v = parseFloat(getComputedStyle(el).opacity);
      return Number.isNaN(v) ? 1 : v;
    }
    if ((prop === 'x' || prop === 'y') && el) {
      const m = currentXY(el);
      return round(prop === 'x' ? m.x : m.y);
    }
    if (prop in TRANSFORMS) return TRANSFORMS[prop];
    if (!el) return 0;
    const v = getComputedStyle(el)[prop];
    return v === undefined || v === '' ? 0 : v;
  }

  // the translate already applied to an element, so a new x or y track picks
  // up where the page left off rather than snapping to zero
  function currentXY(el) {
    try {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { x: m.m41, y: m.m42 };
    } catch (_) { return { x: 0, y: 0 }; }
  }

  // page coordinates of an element's centre, stable across scrolling
  function pageCenter(el) {
    const r = el.getBoundingClientRect();
    return {
      x: round(r.left + window.scrollX + r.width / 2),
      y: round(r.top + window.scrollY + r.height / 2),
    };
  }

  // what x and y have to become for this target to sit at a page point.
  // the cursor is positioned by its tip; everything else by its centre.
  const CURSOR_TIP = { x: 4, y: 3 };
  function offsetToPoint(sel, pt) {
    if (sel === '@cursor') {
      return { x: round(pt.x - CURSOR_TIP.x), y: round(pt.y - CURSOR_TIP.y) };
    }
    const el = resolve(sel);
    if (!el) return { x: round(pt.x), y: round(pt.y) };
    const c = pageCenter(el);
    const cur = currentXY(el);
    return { x: round(cur.x + (pt.x - c.x)), y: round(cur.y + (pt.y - c.y)) };
  }

  // A keyframe value may be a live reference like @(#some-button) instead of a
  // number. It resolves to that element's current position every time the
  // sequence is built, so a window resize or a reflow moves the target with it
  // rather than stranding the cursor at a stale coordinate.
  const DYNAMIC = /^@\((.+)\)$/;
  const isDynamic = (v) => DYNAMIC.test(String(v).trim());

  function resolveDynamic(sel, prop, val) {
    const m = DYNAMIC.exec(String(val).trim());
    if (!m) return val;
    const el = document.querySelector(m[1]);
    if (!el) { console.warn('[animlab] target gone:', m[1]); return 0; }
    const c = pageCenter(el);
    if (sel === '@cursor') {
      return round(prop === 'x' ? c.x - CURSOR_TIP.x : c.y - CURSOR_TIP.y);
    }
    // for anything else, work out the translate that lands its own untransformed
    // centre on the target
    const me = resolve(sel);
    if (!me) return 0;
    const prev = me.style.transform;
    me.style.transform = 'none';
    const rest = pageCenter(me);
    me.style.transform = prev;
    return round(prop === 'x' ? c.x - rest.x : c.y - rest.y);
  }

  const hasSeg = (sel, prop) => segs.some((s) => s.sel === sel && s.prop === prop && s.keys.length);

  /* ---------- event dispatch ---------- */

  function cursorPoint() {
    const r = cursor.getBoundingClientRect();
    return { x: r.left + 4, y: r.top + 3 };
  }

  function hitTest(x, y) {
    const prev = host.style.pointerEvents;
    host.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    host.style.pointerEvents = prev;
    return el && el !== host ? el : null;
  }

  function aimFor(sel) {
    const usingCursor = sel === '@cursor' || hasSeg('@cursor', 'x') || hasSeg('@cursor', 'y');
    if (sel && sel !== '@cursor' && sel !== '@page') {
      const el = resolve(sel);
      if (!el) return null;
      if (usingCursor) {
        const p = cursorPoint();
        return { el, x: p.x, y: p.y };
      }
      const r = el.getBoundingClientRect();
      return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    const p = cursorPoint();
    const el = hitTest(p.x, p.y);
    return el ? { el, x: p.x, y: p.y } : null;
  }

  function dispatch(el, name, x, y, button) {
    const shared = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: button < 0 ? 0 : button, buttons: downButtons,
    };
    const ev = name.startsWith('pointer')
      ? new PointerEvent(name, {
          ...shared, pointerId: 1, pointerType: 'mouse', isPrimary: true,
          width: 1, height: 1, pressure: downButtons ? 0.5 : 0,
        })
      : new MouseEvent(name, shared);
    el.dispatchEvent(ev);
  }

  /* ---------- text input ---------- */

  const editable = (el) =>
    !!el && el.isConnected &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

  // find a field for a selector: the element itself, or the first field inside it
  function fieldFor(sel) {
    const el = resolve(sel);
    if (editable(el)) return el;
    if (el) {
      const inner = el.querySelector('input:not([type=hidden]), textarea, [contenteditable=""], [contenteditable=true]');
      if (editable(inner)) return inner;
    }
    return null;
  }

  // typing goes to the last field a focus marker aimed at, then the segment's
  // own target, then whatever the page has focused, then under the cursor
  function textTarget(sel) {
    if (editable(focusedField)) return focusedField;
    const direct = fieldFor(sel);
    if (direct) return direct;
    const active = document.activeElement;
    if (active && active !== host && editable(active)) return active;
    const aim = aimFor(sel);
    if (aim && aim.el) {
      if (editable(aim.el)) return aim.el;
      const inner = aim.el.querySelector('input:not([type=hidden]), textarea, [contenteditable]');
      if (editable(inner)) return inner;
    }
    return null;
  }

  function setValue(el, next) {
    if (el.isContentEditable) { el.textContent = next; return; }
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, next);
    else el.value = next;
  }

  const readText = (el) => (el.isContentEditable ? el.textContent : el.value) || '';

  function keyEvent(el, name, key) {
    return el.dispatchEvent(new KeyboardEvent(name, {
      key,
      code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
      bubbles: true, cancelable: true, composed: true,
    }));
  }

  function editField(el, kind, ch) {
    if (!el) return;
    if (document.activeElement !== el && el.focus) el.focus({ preventScroll: true });

    const before = readText(el);
    const caret = el.isContentEditable || typeof el.selectionStart !== 'number'
      ? before.length
      : el.selectionStart;
    let next = before;
    let pos = caret;

    if (kind === 'wipe') { next = ''; pos = 0; }
    else if (kind === 'back') {
      if (!caret) return;
      next = before.slice(0, caret - 1) + before.slice(caret);
      pos = caret - 1;
    } else {
      next = before.slice(0, caret) + ch + before.slice(caret);
      pos = caret + ch.length;
    }

    const inputType = kind === 'insert' ? 'insertText' : 'deleteContentBackward';
    const key = kind === 'insert' ? ch : 'Backspace';

    keyEvent(el, 'keydown', key);
    el.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, composed: true,
      data: kind === 'insert' ? ch : null, inputType,
    }));
    setValue(el, next);
    if (!el.isContentEditable && typeof el.setSelectionRange === 'function') {
      try { el.setSelectionRange(pos, pos); } catch (_) { /* number inputs */ }
    }
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true,
      data: kind === 'insert' ? ch : null, inputType,
    }));
    keyEvent(el, 'keyup', key);
  }

  function fireMarker(m) {
    const spec = EVENTS[m.type];
    if (!spec) return;

    if (spec.focus) {
      const el = fieldFor(m.sel) || (aimFor(m.sel) || {}).el;
      if (el) {
        focusedField = editable(el) ? el : null;
        if (el.focus) el.focus({ preventScroll: true });
        el.dispatchEvent(new FocusEvent('focus', { bubbles: false, composed: true }));
        el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
      }
      return;
    }

    if (spec.text || spec.back || spec.wipe) {
      const el = textTarget(m.sel);
      if (!el) { console.warn('[animlab] no text field for', m.sel); return; }
      focusedField = el;
      const ch = m.detail == null || m.detail === '' ? ' ' : String(m.detail);
      editField(el, spec.wipe ? 'wipe' : spec.back ? 'back' : 'insert', ch);
      return;
    }

    if (spec.key) {
      const el = editable(focusedField) ? focusedField
        : (editable(document.activeElement) ? document.activeElement
        : (aimFor(m.sel) || {}).el || document.body);
      const key = m.detail || 'Enter';
      keyEvent(el, 'keydown', key);
      keyEvent(el, 'keypress', key);
      keyEvent(el, 'keyup', key);
      return;
    }

    const aim = aimFor(m.sel);
    if (!aim) return;

    if (spec.wheel !== undefined) {
      aim.el.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: aim.x, clientY: aim.y,
        deltaY: spec.wheel * (parseFloat(m.detail) || 1), deltaMode: 0,
      }));
      return;
    }

    spec.seq.forEach(([name, button]) => {
      if (name === 'pointerdown' || name === 'mousedown') downButtons |= button === 2 ? 2 : 1;
      dispatch(aim.el, name, aim.x, aim.y, button);
      if (name === 'pointerup' || name === 'mouseup') downButtons &= button === 2 ? ~2 : ~1;
    });
  }

  let lastMovePt = null;
  function emitMove() {
    if (!liveMove) return;
    if (!hasSeg('@cursor', 'x') && !hasSeg('@cursor', 'y')) return;
    const p = cursorPoint();
    if (lastMovePt && Math.abs(p.x - lastMovePt.x) < 0.5 && Math.abs(p.y - lastMovePt.y) < 0.5) return;
    lastMovePt = p;
    const el = hitTest(p.x, p.y);
    if (!el) return;
    dispatch(el, 'pointermove', p.x, p.y, -1);
    dispatch(el, 'mousemove', p.x, p.y, -1);
  }

  /* ---------- dock ---------- */

  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;height:300px;z-index:2147483646;pointer-events:none;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  const propOptions = (val) => {
    const byGroup = {};
    Object.entries(SPEC).forEach(([k, s]) => {
      (byGroup[s.group] = byGroup[s.group] || []).push(k);
    });
    const known = Object.keys(SPEC).includes(val);
    return Object.entries(byGroup)
      .map(([g, list]) => `<optgroup label="${g}">${list.map((p) =>
        `<option value="${p}"${p === val ? ' selected' : ''}>${p}</option>`).join('')}</optgroup>`)
      .join('') +
      (val && !known ? `<option value="${esc(val)}" selected>${esc(val)}</option>` : '') +
      '<option value="__custom">custom…</option>';
  };

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-monospace, "SF Mono", Menlo, monospace; }

      .dock {
        height: 100%; display: flex; flex-direction: column; position: relative;
        background: #101418; color: #c8d0d8; border-top: 1px solid #232a31;
        font-size: 12px; line-height: 1.5;
        box-shadow: 0 -8px 32px rgba(0,0,0,.5); pointer-events: auto;
      }
      .grip { height: 5px; flex: none; cursor: ns-resize; background: #161c22; border-bottom: 1px solid #232a31; }
      .grip:hover { background: #22303a; }
      :host(.float) .dock { border: 1px solid #2c343c; border-radius: 5px; overflow: hidden; }
      :host(.float) .bar { cursor: grab; }
      :host(.float) .bar.moving { cursor: grabbing; }
      :host(.top) .dock { border-top: none; border-bottom: 1px solid #232a31; box-shadow: 0 8px 32px rgba(0,0,0,.5); }
      .fresize {
        position: absolute; right: 0; bottom: 0; width: 14px; height: 14px;
        cursor: nwse-resize; display: none; z-index: 40;
        background: linear-gradient(135deg, transparent 50%, #3a444e 50%, #3a444e 70%, transparent 70%);
      }
      :host(.float) .fresize { display: block; }

      .bar {
        flex: none; display: flex; align-items: center; gap: 5px;
        padding: 6px 10px; border-bottom: 1px solid #232a31; flex-wrap: wrap;
      }
      .name { color: #7ee0c0; letter-spacing: .04em; margin-right: 3px; }
      .rule { width: 1px; align-self: stretch; background: #232a31; margin: 0 3px; }
      .spacer { flex: 1; }
      .cap { color: #5c6670; font-size: 10px; }

      button {
        background: #1a2027; color: #c8d0d8; border: 1px solid #2c343c;
        border-radius: 3px; padding: 4px 9px; font-size: 11px; cursor: pointer;
        font-family: inherit; white-space: nowrap;
      }
      button:hover { background: #222a32; border-color: #3a444e; }
      button:focus-visible { outline: 2px solid #7ee0c0; outline-offset: 1px; }
      button.on { background: #7ee0c0; color: #101418; border-color: #7ee0c0; }
      button.go { background: #24505f; border-color: #35798e; color: #d6f2fa; }
      button.go:hover { background: #2f6b7f; }
      button.tiny { padding: 1px 5px; font-size: 10px; }

      input, textarea, select {
        background: #0a0d10; color: #c8d0d8; border: 1px solid #2c343c;
        border-radius: 3px; padding: 4px 6px; font-size: 11px; width: 100%;
        font-family: inherit;
      }
      input:focus, textarea:focus, select:focus { outline: 1px solid #7ee0c0; border-color: #7ee0c0; }
      input[type=color] { padding: 1px; width: 28px; height: 24px; flex: none; }
      label.chk {
        display: inline-flex; align-items: center; gap: 5px; font-size: 11px;
        color: #8d98a3; cursor: pointer; user-select: none;
      }
      label.chk input { width: auto; }
      .sel {
        width: 190px; padding: 3px 6px; background: #0a0d10; border: 1px solid #2c343c;
        border-radius: 3px; color: #7ee0c0; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; font-size: 11px;
      }
      .sel.empty { color: #5c6670; }

      /* popovers */
      .pop {
        position: fixed; z-index: 2147483647; display: none; pointer-events: auto;
        background: #141a20; border: 1px solid #2c343c; border-radius: 4px;
        padding: 10px; min-width: 250px; max-width: 420px;
        max-height: 60vh; overflow-y: auto;
        box-shadow: 0 12px 32px rgba(0,0,0,.6);
      }
      .pop.open { display: block; }
      .pop h4 { margin: 0 0 8px; font-size: 10px; font-weight: normal; color: #5c6670; }
      .pg { display: grid; grid-template-columns: 62px 1fr 1fr; gap: 5px; align-items: center; }
      .pg .wide { grid-column: 2 / -1; }
      .pg .full { grid-column: 1 / -1; }
      .prow { display: flex; gap: 5px; margin-top: 8px; flex-wrap: wrap; }
      .lbl { color: #5c6670; font-size: 10px; }

      .main { flex: 1; display: flex; min-height: 0; }
      .tl { flex: 1; overflow: auto; position: relative; outline: none; }
      .snapline {
        position: absolute; top: 0; bottom: 0; width: 1px; background: #7ee0c0;
        pointer-events: none; z-index: 7; display: none; opacity: .8;
      }
      .dragghost {
        position: absolute; top: 0; bottom: 0; background: rgba(126,224,192,.06);
        border-left: 1px dashed rgba(126,224,192,.5); border-right: 1px dashed rgba(126,224,192,.5);
        pointer-events: none; z-index: 2; display: none;
      }
      .grid { position: relative; user-select: none; }

      .rrow { display: flex; position: sticky; top: 0; z-index: 5; }
      .rrow2 { display: flex; position: sticky; top: ${RULER_H}px; z-index: 5; }
      .corner {
        width: ${GUTTER}px; flex: none; background: #0c1013;
        border-right: 1px solid #232a31; position: sticky; left: 0; z-index: 6;
      }
      .corner.c1 { height: ${RULER_H}px; border-bottom: 1px solid #1c2228; }
      .corner.c2 {
        height: ${RANGE_H}px; border-bottom: 1px solid #232a31;
        font-size: 9px; color: #8a7134; display: flex; align-items: center; padding-left: 6px;
      }
      .ruler {
        height: ${RULER_H}px; position: relative; background: #0c1013;
        border-bottom: 1px solid #1c2228; cursor: crosshair; flex: none;
      }
      .rstrip {
        height: ${RANGE_H}px; position: relative; background: #0c1013;
        border-bottom: 1px solid #232a31; cursor: crosshair; flex: none;
      }
      .band {
        position: absolute; top: 1px; bottom: 1px; background: rgba(214,177,90,.25);
        border: 1px solid #8a7134; border-radius: 2px; cursor: grab;
      }
      .band .h { position: absolute; top: -1px; bottom: -1px; width: 6px; background: #d6b15a; cursor: ew-resize; }
      .band .h.l { left: -3px; }
      .band .h.r { right: -3px; }
      .bandfill {
        position: absolute; top: 0; bottom: 0; background: rgba(214,177,90,.06);
        border-left: 1px solid rgba(138,113,52,.5); border-right: 1px solid rgba(138,113,52,.5);
        pointer-events: none; z-index: 1;
      }
      .tick { position: absolute; top: 0; bottom: 0; width: 1px; background: #1c2228; }
      .tick.major { background: #2c343c; }
      .tick-label { position: absolute; top: 3px; font-size: 9px; color: #5c6670; padding-left: 3px; pointer-events: none; }

      .row { display: flex; }
      .gcell {
        width: ${GUTTER}px; flex: none; height: ${LANE_H}px; position: sticky; left: 0; z-index: 4;
        background: #0c1013; border-right: 1px solid #232a31; border-bottom: 1px solid #161b20;
        display: flex; align-items: center; justify-content: center;
        font-size: 10px; color: #47525c;
      }
      .audiorow { display: flex; }
      .audiocell {
        width: ${GUTTER}px; flex: none; height: ${AUDIO_H}px; position: sticky; left: 0; z-index: 4;
        background: #0c1013; border-right: 1px solid #232a31; border-bottom: 1px solid #232a31;
        display: flex; align-items: center; justify-content: center;
        font-size: 9px; color: #3f7f96;
      }
      .audiolane {
        height: ${AUDIO_H}px; position: relative; flex: none;
        background: #0a0e11; border-bottom: 1px solid #232a31; cursor: grab;
      }
      .audiolane.sliding { cursor: grabbing; }
      .audiolane canvas { display: block; position: absolute; top: 0; left: 0; }
      .aclip {
        position: absolute; top: 2px; bottom: 2px; border-radius: 3px;
        border: 1px solid rgba(63,127,150,.65); background: rgba(63,127,150,.10);
        cursor: grab; overflow: hidden;
      }
      .aclip:hover { border-color: #5cb4d0; }
      .aclip.sel { border-color: #7ee0c0; background: rgba(126,224,192,.12); }
      .aclip .nm {
        position: absolute; top: 1px; left: 4px; font-size: 9px;
        color: #7d95a3; pointer-events: none; white-space: nowrap;
      }
      .arec {
        position: absolute; top: 2px; bottom: 2px; border-radius: 3px;
        background: rgba(220,80,80,.18); border: 1px solid #b85454;
        pointer-events: none;
      }
      .arec .dot {
        position: absolute; left: 5px; top: 50%; width: 7px; height: 7px;
        margin-top: -3px; border-radius: 50%; background: #e06a6a;
      }
      .lane { height: ${LANE_H}px; position: relative; border-bottom: 1px solid #161b20; background: #0b0f12; flex: none; }

      .segband {
        position: absolute; top: 1px; bottom: 1px; border-radius: 3px;
        background: rgba(74,157,184,.10); border: 1px solid rgba(74,157,184,.35);
        cursor: pointer;
      }
      .segband.events { background: rgba(138,95,176,.10); border-color: rgba(138,95,176,.4); }
      .segband.sel { border-color: rgba(126,224,192,.55); background: rgba(126,224,192,.09); }
      .segband.allsel { border-color: #7ee0c0; background: rgba(126,224,192,.16); }
      .seglabel {
        position: absolute; top: 1px; font-size: 9px; color: #7d8b96;
        pointer-events: none; white-space: nowrap; padding-left: 4px; z-index: 2;
      }
      .segband.events + .seglabel, .seglabel.events { color: #9b86b5; }

      .seg { position: absolute; top: 65%; height: 2px; background: #2c5866; transform: translateY(-50%); pointer-events: none; }
      /* z-index 5 puts the bar above .key (4). At 3 it made its own stacking
         context and trapped the handles underneath the keyframes that sit on
         its edges by definition, so they could never be grabbed. */
      .glink {
        position: absolute; bottom: 1px; height: 5px; border-radius: 2px;
        cursor: grab; opacity: .85; z-index: 5;
      }
      .glink:hover { opacity: 1; height: 6px; }
      .gh {
        position: absolute; top: -5px; bottom: -3px; width: 9px;
        cursor: ew-resize; z-index: 6; border-radius: 2px;
      }
      .gh.l { left: -5px; }
      .gh.r { right: -5px; }
      .gh:hover { background: rgba(255,255,255,.5); }
      .sbh {
        position: absolute; top: 0; bottom: 0; width: 8px;
        cursor: ew-resize; z-index: 6;
      }
      .sbh.l { left: 0; border-radius: 3px 0 0 3px; }
      .sbh.r { right: 0; border-radius: 0 3px 3px 0; }
      .sbh:hover { background: rgba(126,224,192,.3); }
      .key {
        position: absolute; top: 65%; width: 11px; height: 11px;
        margin: -6px 0 0 -6px; background: #4a9db8; border: 1px solid #7ec4dc;
        transform: rotate(45deg); cursor: grab; z-index: 4;
      }
      .key:hover { background: #5cb4d0; }
      .key.selected { background: #7ee0c0; border-color: #d6fff2; }
      .key.primary { box-shadow: 0 0 0 2px rgba(126,224,192,.35); }
      .key.event {
        transform: none; border-radius: 50%; background: #8a5fb0; border-color: #b79ad6;
        width: 11px; height: 11px;
      }
      .key.event.selected { background: #d0aff0; border-color: #f0e2ff; }
      .key.mini { width: 7px; height: 7px; margin: -4px 0 0 -4px; }
      .key.dynamic { background: #b8934a; border-color: #e0c47e; }
      .key.dynamic.selected { background: #e0c47e; border-color: #fff0c8; }
      .evt-label {
        position: absolute; top: 65%; transform: translateY(-50%);
        font-size: 9px; color: #9b86b5; pointer-events: none; white-space: nowrap;
      }

      .playhead { position: absolute; top: 0; bottom: 0; width: 1px; background: #ff9d5c; pointer-events: none; z-index: 6; }
      .playhead::before {
        content: ''; position: absolute; top: 0; left: -4px;
        border-left: 4px solid transparent; border-right: 4px solid transparent;
        border-top: 6px solid #ff9d5c;
      }
      .marquee {
        position: fixed; border: 1px solid #7ee0c0; background: rgba(126,224,192,.10);
        pointer-events: none; z-index: 2147483647; display: none;
      }

      .side { width: 286px; flex: none; border-left: 1px solid #232a31; overflow-y: auto; padding: 8px; }
      .block { border: 1px solid #232a31; border-radius: 3px; padding: 7px; margin-bottom: 8px; }
      .block h4 { margin: 0 0 6px; font-size: 10px; font-weight: normal; color: #5c6670; }
      .count { color: #7ee0c0; font-size: 11px; margin-bottom: 6px; }
      .empty-note { color: #5c6670; padding: 10px 0; text-align: center; font-size: 11px; }
      .hint { color: #4a535c; font-size: 10px; margin-top: 6px; line-height: 1.45; }
      .actions { display: flex; gap: 5px; margin-top: 8px; flex-wrap: wrap; }
      .klist { max-height: 170px; overflow-y: auto; }
      .krow { display: grid; grid-template-columns: 12px 50px 1fr 20px; gap: 4px; align-items: center; margin-bottom: 3px; }
      .kdot { width: 8px; height: 8px; border-radius: 2px; background: #4a9db8; }
      .kdot.event { border-radius: 50%; background: #8a5fb0; }
      .out { margin-top: 8px; }
      .out textarea { height: 78px; color: #9fb4c4; resize: vertical; line-height: 1.5; }

      .transport {
        flex: none; display: flex; align-items: center; gap: 5px;
        padding: 5px 10px; border-top: 1px solid #232a31;
      }
      .time { color: #5c6670; font-size: 10px; min-width: 92px; }
    </style>

    <div class="dock" id="dock">
      <div class="grip" id="grip" title="drag to resize"></div>

      <div class="bar" id="bar">
        <span class="name">animlab</span>
        <button id="pick">pick</button>
        <div class="sel empty" id="sel">nothing selected</div>
        <button id="selCursor">@cursor</button>
        <button id="selPage">@page</button>
        <div class="rule"></div>
        <button class="go" data-pop="popAnimate">animate ▾</button>
        <button data-pop="popEvent">events ▾</button>
        <button data-pop="popType">typing ▾</button>
        <button data-pop="popPreset">presets ▾</button>
        <button data-pop="popCamera">cursor &amp; zoom ▾</button>
        <button data-pop="popRange">range ▾</button>
        <button data-pop="popFile">file ▾</button>
        <button data-pop="popAudio">audio ▾</button>
        <button data-pop="popRender">render ▾</button>
        <button data-pop="popDock">layout ▾</button>
        <span class="spacer"></span>
        <button id="close">×</button>
      </div>

      <div class="pop" id="popAnimate">
        <h4>add an animation at the playhead</h4>
        <div class="pg">
          <div class="lbl">property</div>
          <select class="wide" id="prop">${propOptions('x')}</select>
          <div class="lbl"></div>
          <input class="wide" id="propCustom" placeholder="property name" hidden>
          <div class="lbl">to</div>
          <input id="toVal" value="200">
          <input type="color" id="toColor" hidden>
          <div class="lbl" id="unit">px</div>
          <div class="lbl">over</div>
          <input id="toDur" value="0.6">
          <div class="lbl">seconds</div>
        </div>
        <div class="prow">
          <button class="go" id="add">add animation</button>
          <button id="addPoint" hidden>move to point ⌖</button>
        </div>
        <div class="hint" id="pointHint" hidden>picks a spot on the page and writes both x and y</div>
      </div>

      <div class="pop" id="popEvent">
        <h4>events fire during playback, aimed under the cursor</h4>
        <div class="pg">
          <div class="lbl">type</div>
          <select class="wide" id="evtType">
            ${Object.entries(EVENTS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
          </select>
          <div class="lbl">detail</div>
          <input class="wide" id="evtDetail" placeholder="detail">
        </div>
        <div class="prow">
          <button id="addEvent">add</button>
          <button id="fireNow">fire now</button>
          <button id="dragPair">drag pair</button>
          <label class="chk"><input type="checkbox" id="liveMove" checked> pointermove follows cursor</label>
        </div>
      </div>

      <div class="pop" id="popType">
        <h4>type text into a field, one keyframe per character</h4>
        <div class="pg">
          <div class="lbl">text</div>
          <input class="wide" id="typeText" placeholder="hello world">
          <div class="lbl">over</div>
          <input id="typeDur" value="1.5">
          <div class="lbl">seconds</div>
        </div>
        <div class="prow">
          <button class="go" id="typeIt">type it</button>
          <button id="typeClear">clear then type</button>
        </div>
        <div class="hint" id="typeInfo">pick a field, or an element containing one</div>
      </div>

      <div class="pop" id="popPreset">
        <h4>drop a canned motion at the playhead</h4>
        <div class="pg">
          <div class="lbl">preset</div>
          <select class="wide" id="preset">
            ${Object.keys(PRESETS).map((k) => `<option value="${k}">${k}</option>`).join('')}
          </select>
          <div class="lbl">amount</div>
          <input id="preAmt" value="16">
          <div class="lbl"></div>
          <div class="lbl">over</div>
          <input id="preDur" value="0.6">
          <div class="lbl">seconds</div>
        </div>
        <div class="prow"><button class="go" id="applyPreset">apply preset</button></div>
      </div>

      <div class="pop" id="popCamera">
        <h4>fake cursor</h4>
        <div class="prow">
          <button id="preview">preview</button>
          <button id="cursorTrack">move to selection</button>
          <button id="cursorPoint">move to point ⌖</button>
          <button id="cursorIn">fade in</button>
          <button id="cursorOut">fade out</button>
          <button id="clickPulse">click pulse</button>
        </div>
        <h4 style="margin-top:12px">page zoom</h4>
        <div class="pg">
          <div class="lbl">factor</div>
          <input id="zoomAmt" value="1.8">
          <div class="lbl">×</div>
        </div>
        <div class="prow">
          <button id="zoomTo">zoom to selection</button>
          <button id="zoomOut">back to 1x</button>
        </div>
      </div>

      <div class="pop" id="popRange">
        <h4>stretch a section, for lining up to beats</h4>
        <div class="pg">
          <div class="lbl">in</div>
          <input id="rIn" value="0">
          <input id="rOut" value="0">
          <div class="lbl">length</div>
          <input id="rLen" value="0">
          <button id="rFit">fit</button>
        </div>
        <div class="prow">
          <button id="rHalf">÷2</button>
          <button id="rDouble">×2</button>
          <button id="rFromSel">from selection</button>
          <button id="rAll">whole timeline</button>
          <button id="rClear">clear</button>
        </div>
        <div class="prow">
          <label class="chk"><input type="checkbox" id="rRipple" checked> ripple the rest of the timeline</label>
        </div>
        <div class="hint">drag the amber strip to set a range, drag its handles to scale what is inside</div>
      </div>

      <div class="pop" id="popAudio">
        <h4>record a take, or drop a clip in</h4>
        <div class="prow">
          <button class="go" id="audRec">record from the playhead</button>
          <button id="audPick">load a file</button>
          <button id="audClear" hidden>remove all</button>
        </div>
        <div class="prow">
          <label class="chk"><input type="checkbox" id="audPlayWhileRec" checked>
            play the sequence while recording</label>
        </div>
        <div class="prow">
          <button id="audSlice">slice at the playhead</button>
          <button id="audSliceRange">slice at both range edges</button>
          <button id="audDelClip">delete the selected clip</button>
        </div>
        <h4 style="margin-top:12px">edit the highlighted range</h4>
        <div class="prow">
          <button id="audCut">cut it out and close the gap</button>
          <button id="audLift">silence it, leave the gap</button>
        </div>
        <div class="prow">
          <button id="audGap">open a gap here</button>
          <label class="chk"><input type="checkbox" id="audRipKeys">
            move keyframes too</label>
        </div>
        <div class="pg" style="margin-top:10px">
          <div class="lbl">volume</div>
          <input id="audVol" value="100">
          <div class="lbl">percent</div>
        </div>
        <div class="hint" id="audInfo">no audio yet</div>
        <div class="hint">s slices at the playhead, delete removes the selected clip.
        set a range with the amber strip to cut. drag a clip to slide it, or grab its
        edges to trim. wear headphones for a take, or playback bleeds into the mic.</div>
      </div>

      <div class="pop" id="popRender">
        <h4>record the sequence and download it</h4>
        <div class="pg">
          <div class="lbl">capture</div>
          <select class="wide" id="rvSource">
            <option value="auto">auto: canvas if the target is one, else screen</option>
            <option value="canvas">the selected canvas only</option>
            <option value="screen">screen, window or tab</option>
          </select>
          <div class="lbl">format</div>
          <select class="wide" id="rvFormat"></select>
          <div class="lbl">fps</div>
          <select id="rvFps">
            <option value="60">60</option>
            <option value="30" selected>30</option>
          </select>
          <div class="lbl">mbit/s</div>
          <div class="lbl">lead in</div>
          <input id="rvLead" value="0.3">
          <input id="rvTail" value="0.5" title="tail">
        </div>
        <div class="prow">
          <label class="chk"><input type="checkbox" id="rvHidePanel" checked> hide the panel while recording</label>
        </div>
        <div class="prow">
          <button class="go" id="rvGo">record and download</button>
          <button id="rvStop" hidden>stop</button>
        </div>
        <div class="hint" id="rvHint">
          recording runs in real time. screen capture asks which surface to share,
          and the panel hides itself for the take. esc aborts.
        </div>
      </div>

      <div class="pop" id="popDock">
        <h4>put the panel somewhere else</h4>
        <div class="prow">
          <button id="dockBottom">dock bottom</button>
          <button id="dockTop">dock top</button>
          <button id="dockFloat">float</button>
        </div>
        <div class="prow">
          <button class="go" id="dockPopOut">pop out to a window</button>
          <button id="dockPopIn">bring back</button>
        </div>
        <div class="prow">
          <label class="chk"><input type="checkbox" id="guardChk" checked>
            hold focus against page dialogs</label>
        </div>
        <div class="hint">float drags by the toolbar and resizes from the bottom right corner. h hides it entirely.</div>
      </div>

      <div class="pop" id="popFile">
        <h4>save and restore</h4>
        <div class="pg">
          <div class="lbl">name</div>
          <input id="seqName" placeholder="my sequence">
          <select id="seqList"><option value="">saved…</option></select>
        </div>
        <div class="prow">
          <label class="chk"><input type="checkbox" id="seqEmbed" checked>
            include audio</label>
          <label class="chk"><input type="checkbox" id="seqJson">
            readable json instead of binary</label>
        </div>
        <div class="prow">
          <button id="seqSave">save</button>
          <button id="seqLoad">load</button>
          <button id="seqDel">delete</button>
          <button id="seqExport">export</button>
          <button id="seqImport">import</button>
          <button id="seqClear">new</button>
        </div>
        <div class="hint">exports are a binary .animlab file: cbor with the audio
        as raw bytes, about a third smaller than json and quicker to read. tick
        readable json if you want to inspect or diff one. both load back.</div>
        <div class="out">
          <button id="copy">copy motion code</button>
          <textarea id="output" readonly spellcheck="false"></textarea>
        </div>
      </div>

      <div class="main">
        <div class="tl" id="tl" tabindex="-1">
          <div class="grid" id="grid">
            <div class="rrow">
              <div class="corner c1"></div>
              <div class="ruler" id="ruler"></div>
            </div>
            <div class="rrow2">
              <div class="corner c2">range</div>
              <div class="rstrip" id="rstrip"></div>
            </div>
            <div id="rows"></div>
            <div class="bandfill" id="bandfill" style="display:none"></div>
            <div class="dragghost" id="dragghost"></div>
            <div class="snapline" id="snapline"></div>
            <div class="playhead" id="playhead" style="left:${GUTTER}px"></div>
          </div>
        </div>
        <div class="side"><div id="insp"></div></div>
      </div>

      <div class="transport">
        <button id="play">play</button>
        <button id="reset">reset</button>
        <span class="time" id="time">0.00 / 0.00s</span>
        <label class="chk"><input type="checkbox" id="autoreset" checked> reset on end</label>
        <label class="chk"><input type="checkbox" id="autoAdv" checked> auto-advance</label>
        <div class="rule"></div>
        <button id="zo">−</button>
        <button id="zi">+</button>
        <span class="spacer"></span>
        <span class="hint">shift-click to multi-select · drag a band edge to stretch · s slices audio · alt for free timing · h hide · space play · g group · r range</span>
      </div>
      <div class="fresize" id="fresize"></div>
    </div>

    <div class="marquee" id="marquee"></div>
    <input type="file" id="fileIn" accept=".animlab,.json,application/json,application/octet-stream" style="display:none">
    <input type="file" id="audIn" accept="audio/*" style="display:none">
    <datalist id="eases">${EASES.map((e) => `<option value="${e}">`).join('')}</datalist>
  `;

  const $ = (id) => root.getElementById(id);

  /* ---------- scrolling ----------
     Pages that call preventDefault on a document-level wheel listener, which
     is every WebGL canvas and every modal scroll-lock, also kill native
     scrolling inside this panel. So we do it ourselves: find the nearest
     scrollable ancestor of whatever the pointer is over and move it directly,
     which works whether or not the default action survived.                  */

  function scrollableFrom(node) {
    let n = node;
    while (n && n !== host) {
      if (n.nodeType === 1) {
        const s = getComputedStyle(n);
        const canY = /(auto|scroll)/.test(s.overflowY) && n.scrollHeight - n.clientHeight > 1;
        const canX = /(auto|scroll)/.test(s.overflowX) && n.scrollWidth - n.clientWidth > 1;
        if (canY || canX) return { el: n, canX, canY };
      }
      n = n.parentNode || n.host;
    }
    return null;
  }

  function onWheel(e) {
    if (!e.composedPath().includes(host)) return;

    // ctrl or cmd over the timeline zooms it instead of scrolling
    const overTimeline = e.composedPath().includes($('tl'));
    if ((e.ctrlKey || e.metaKey) && overTimeline) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const at = ($('tl').scrollLeft + e.clientX - $('tl').getBoundingClientRect().left - GUTTER) / pps;
      pps = Math.max(20, Math.min(500, pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      renderTracks();
      renderRange();
      seek(time);
      $('tl').scrollLeft = Math.max(0, at * pps - (e.clientX - $('tl').getBoundingClientRect().left - GUTTER));
      return;
    }

    const target = scrollableFrom(e.composedPath()[0]);
    if (!target) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? target.el.clientHeight : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;

    // shift-wheel pans horizontally, and a vertical wheel over a pane that can
    // only scroll sideways does the same
    if (e.shiftKey || (target.canX && !target.canY)) {
      dx = dx || dy;
      dy = 0;
    }

    const before = { x: target.el.scrollLeft, y: target.el.scrollTop };
    if (target.canX && dx) target.el.scrollLeft += dx;
    if (target.canY && dy) target.el.scrollTop += dy;

    if (target.el.scrollLeft !== before.x || target.el.scrollTop !== before.y) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }


  /* ---------- focus trap defence ----------
     Modal dialogs (Kobalte, Radix, Ark and friends) install document-level
     listeners that yank focus back inside themselves and dismiss on any
     outside press. Our panel is outside, so it loses every fight.

     The shield has to sit on the way OUT, not the way in. Capture runs
     top-down, so stopping an event at document capture would kill it before
     our own keyframes and grip ever saw it. Instead we let it reach our
     handlers, then stop it bubbling on at the host, where page listeners live.
     Focus is defended separately, by taking it back if something steals it.  */

  let guardFocus = true;
  let ownField = null;
  let reclaims = 0;

  const fromUs = (e) => e.composedPath().includes(host);

  // Pointer events are shielded on the way OUT, at the host, after our own
  // handlers have run. Stopping them on the way in would kill our own drags.
  ['pointerdown', 'mousedown', 'touchstart', 'click']
    .forEach((name) => {
      host.addEventListener(name, (e) => { if (guardFocus) e.stopPropagation(); });
    });

  // Focus events are different, and this is what the last attempt got wrong.
  // Focus traps listen at document CAPTURE, which runs before the event ever
  // reaches our host, so a shield at the host is too late and the trap yanks
  // focus straight back. Nothing inside the panel needs these events to
  // descend, so we can safely kill them at document capture instead, doing our
  // own bookkeeping first. 'focus' and 'blur' do not bubble but do capture,
  // so they have to be listed too.
  ['focusin', 'focusout', 'focus', 'blur'].forEach((name) => {
    document.addEventListener(name, (e) => {
      if (!guardFocus || !fromUs(e)) return;
      if (name === 'focusin' || name === 'focus') {
        const t = e.composedPath()[0];
        if (t && t.nodeType === 1 && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
          ownField = t;
          reclaims = 0;
        }
      }
      // keep the page's focus machinery from ever learning about our panel
      e.stopImmediatePropagation();
    }, true);
  });

  // belt and braces: if something still drags focus away, take it back
  document.addEventListener('focusin', (e) => {
    if (!guardFocus || !ownField || !ownField.isConnected) return;
    if (fromUs(e)) return;
    if (reclaims++ > 6) return;
    requestAnimationFrame(() => {
      if (ownField && ownField.isConnected && root.activeElement !== ownField) {
        ownField.focus({ preventScroll: true });
      }
    });
  }, true);

  /* ---------- the part that actually wins ----------
     Everything above depends on our listener running before the dialog's, and
     for listeners on the same node in the same phase that comes down to who
     registered first. A dialog that opened before this tool loaded always wins
     that race, which is why shielding events was never enough.

     So intercept the one thing every focus trap has to do in the end: call
     .focus() on something. While a field in our panel holds focus, calls
     aimed anywhere outside it are ignored. The condition is self-limiting.
     Click away and root.activeElement stops being one of our fields, so the
     page goes straight back to behaving normally.                            */

  const panelHasTextFocus = () => {
    const a = root.activeElement;
    return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  };

  /* The guard used to arm only once one of our fields already held focus, and
     there is a window before that where it does not. Pressing a field runs the
     trap's document-capture pointerdown handler BEFORE the browser's default
     action moves focus, so at that instant root.activeElement is still null,
     the guard is asleep, and the trap takes focus unopposed.

     So arm on engagement instead of on focus: pressing anywhere in the panel
     claims focus ownership, pressing anywhere else gives it back. */
  let panelEngaged = false;
  root.addEventListener('pointerdown', () => { panelEngaged = true; }, true);
  root.addEventListener('mousedown', () => { panelEngaged = true; }, true);
  const releaseFocus = (e) => {
    if (fromUs(e)) return;
    panelEngaged = false;
    // let go of our own field too, or panelHasTextFocus keeps the guard armed
    // and the page can never take focus back
    const a = root.activeElement;
    if (a && a.blur) a.blur();
    ownField = null;
  };
  document.addEventListener('pointerdown', releaseFocus, true);
  document.addEventListener('mousedown', releaseFocus, true);

  const panelOwnsFocus = () => guardFocus && (panelEngaged || panelHasTextFocus());

  const patchedFocus = new Map();
  [window.HTMLElement, window.SVGElement].forEach((ctor) => {
    if (!ctor || typeof ctor.prototype.focus !== 'function') return;
    const proto = ctor.prototype;
    const native = proto.focus;
    patchedFocus.set(proto, native);
    proto.focus = function patchedFocusFn(...args) {
      if (panelOwnsFocus() &&
          this !== host && this.getRootNode && this.getRootNode() !== root) {
        return undefined;   // a focus trap reaching for the page. not today.
      }
      return native.apply(this, args);
    };
  });

  function restoreFocusPatch() {
    patchedFocus.forEach((native, proto) => { proto.focus = native; });
    patchedFocus.clear();
  }

  /* ---------- focus our own fields explicitly ----------
     A field gets focus from the browser's default action on mousedown. Any
     page listener at document CAPTURE that calls preventDefault kills that
     default before the event ever reaches us, and WebGL canvases and modal
     overlays both do exactly that to suppress text selection and dragging.
     Nothing we do at the host can undo it, because it already happened.
     So stop relying on the default and focus the field ourselves.            */

  const isField = (el) =>
    !!el && el.nodeType === 1 && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.disabled;

  ['pointerdown', 'mousedown'].forEach((name) => {
    root.addEventListener(name, (e) => {
      const t = e.composedPath()[0];
      if (!isField(t)) return;
      ownField = t;
      reclaims = 0;
      // after the event settles, whether or not the default survived
      setTimeout(() => {
        if (root.activeElement !== t && t.isConnected) {
          t.focus({ preventScroll: true });
          // a prevented default also skips caret placement, so put it somewhere
          if (typeof t.setSelectionRange === 'function' && t.type !== 'color') {
            try { t.setSelectionRange(t.value.length, t.value.length); } catch (_) {}
          }
        }
      }, 0);
    }, true);
  });

  // some libraries mark everything outside the dialog inert, which blocks
  // focus at the browser level where no amount of event handling helps
  const clearInert = () => {
    if (host.hasAttribute('inert')) host.removeAttribute('inert');
    let n = host.parentElement;
    while (n) {
      if (n.hasAttribute && n.hasAttribute('inert')) n.removeAttribute('inert');
      n = n.parentElement;
    }
  };
  clearInert();
  new MutationObserver(clearInert).observe(document.documentElement, {
    attributes: true, attributeFilter: ['inert'], subtree: false,
  });

  /* ---------- popovers ---------- */

  let openPop = null;
  function closePop() {
    if (openPop) {
      $(openPop).classList.remove('open');
      root.querySelector(`[data-pop="${openPop}"]`).classList.remove('on');
      openPop = null;
    }
  }
  // Popovers are position:fixed and placed in viewport coordinates, so they
  // escape the float panel's overflow clipping and can flip to whichever side
  // of the toolbar actually has room. Docked, floating or popped out, the
  // measurement is the same.
  function togglePop(id, trigger) {
    if (openPop === id) { closePop(); return; }
    closePop();
    const pop = $(id);
    pop.classList.add('open');
    trigger.classList.add('on');

    const win = popup || window;
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const t = trigger.getBoundingClientRect();

    pop.style.maxHeight = 'none';
    const wanted = pop.offsetHeight;
    const above = t.top - 8;
    const below = vh - t.bottom - 8;
    const openUp = above >= Math.min(wanted, below) || above > below;
    const room = Math.max(120, openUp ? above : below);
    pop.style.maxHeight = Math.min(wanted, room) + 'px';

    if (openUp) {
      pop.style.top = 'auto';
      pop.style.bottom = (vh - t.top + 4) + 'px';
    } else {
      pop.style.bottom = 'auto';
      pop.style.top = (t.bottom + 4) + 'px';
    }
    pop.style.left = Math.max(8, Math.min(t.left, vw - pop.offsetWidth - 8)) + 'px';

    openPop = id;
    const first = pop.querySelector('input:not([type=checkbox]), select');
    if (first) first.focus({ preventScroll: true });
  }
  root.querySelectorAll('[data-pop]').forEach((b) =>
    b.addEventListener('click', () => togglePop(b.dataset.pop, b)));
  root.querySelectorAll('.pop').forEach((p) =>
    p.addEventListener('mousedown', (e) => e.stopPropagation()));
  $('dock').addEventListener('mousedown', (e) => {
    if (!openPop) return;
    const path = e.composedPath();
    if (path.includes($(openPop))) return;
    if (path.some((n) => n.dataset && n.dataset.pop)) return;
    closePop();
  });

  /* ---------- property picker ---------- */

  function currentProp() {
    const v = $('prop').value;
    return v === '__custom' ? ($('propCustom').value.trim() || 'x') : v;
  }

  function syncPropUI() {
    const custom = $('prop').value === '__custom';
    $('propCustom').hidden = !custom;
    const spec = SPEC[currentProp()];
    const isColor = spec && spec.kind === 'color';
    $('toColor').hidden = !isColor;
    $('unit').textContent = spec && spec.hint ? spec.hint : '';
    if (spec) {
      $('toVal').value = spec.to;
      if (isColor) $('toColor').value = spec.to;
    }
    const positional = currentProp() === 'x' || currentProp() === 'y';
    $('addPoint').hidden = !positional;
    $('pointHint').hidden = !positional;
  }
  $('prop').addEventListener('change', syncPropUI);
  $('toColor').addEventListener('input', (e) => { $('toVal').value = e.target.value; });
  $('evtType').addEventListener('change', () => {
    const s = EVENTS[$('evtType').value] || {};
    $('evtDetail').placeholder = s.detailHint || (s.wheel !== undefined ? 'multiplier' : 'detail');
  });
  syncPropUI();

  /* ---------- element picker ---------- */

  const hi = document.createElement('div');
  hi.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483645;' +
    'border:1px solid #7ee0c0;background:rgba(126,224,192,.12);display:none;';
  document.documentElement.appendChild(hi);

  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let seg = node.tagName.toLowerCase();
      const parent = node.parentNode;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(' > ') || 'body';
  }

  const onMove = (e) => {
    if (!picking) return;
    const el = e.composedPath()[0];
    if (!el || el === host || el === cursor || el.nodeType !== 1 || host.contains(el)) return;
    const r = el.getBoundingClientRect();
    Object.assign(hi.style, {
      display: 'block', top: r.top + 'px', left: r.left + 'px',
      width: r.width + 'px', height: r.height + 'px',
    });
  };

  const onPickClick = (e) => {
    if (!picking) return;
    const el = e.composedPath()[0];
    if (!el || el === host || host.contains(el)) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(cssPath(el));
    stopPick();
  };

  function setSelected(sel) {
    selectedEl = sel;
    $('sel').textContent = sel;
    $('sel').classList.remove('empty');
    $('selCursor').classList.toggle('on', sel === '@cursor');
    $('selPage').classList.toggle('on', sel === '@page');
    const f = fieldFor(sel);
    $('typeInfo').textContent = f
      ? `target: <${f.tagName.toLowerCase()}> found, typing will land here`
      : 'target: no text field found under this element';
    if (root.getElementById('rvHint')) describeSource();
  }

  function startPick() {
    picking = true;
    $('pick').classList.add('on');
    $('pick').textContent = 'esc';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onPickClick, true);
  }

  function stopPick() {
    picking = false;
    hi.style.display = 'none';
    $('pick').classList.remove('on');
    $('pick').textContent = 'pick';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onPickClick, true);
  }

  $('pick').addEventListener('click', () => (picking ? stopPick() : startPick()));
  $('selCursor').addEventListener('click', () => setSelected('@cursor'));
  $('selPage').addEventListener('click', () => setSelected('@page'));

  /* ---------- point picker ----------
     An eyedropper for coordinates: crosshairs track the pointer, the readout
     shows the page position and what is under it, click to take it.          */

  const cross = document.createElement('div');
  cross.setAttribute('data-animlab', 'crosshair');
  cross.style.cssText =
    'position:fixed;inset:0;z-index:2147483645;pointer-events:none;display:none;';
  cross.innerHTML =
    '<div data-h style="position:absolute;left:0;right:0;height:1px;background:#7ee0c0;opacity:.75"></div>' +
    '<div data-v style="position:absolute;top:0;bottom:0;width:1px;background:#7ee0c0;opacity:.75"></div>' +
    '<div data-dot style="position:absolute;width:11px;height:11px;margin:-6px 0 0 -6px;' +
    'border:1px solid #d6fff2;background:rgba(126,224,192,.45);border-radius:50%"></div>' +
    '<div data-tip style="position:absolute;font:11px ui-monospace,Menlo,monospace;' +
    'background:#101418;color:#c8d0d8;border:1px solid #2c343c;border-radius:3px;' +
    'padding:3px 7px;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.5)"></div>';
  document.documentElement.appendChild(cross);

  let pickingPoint = false;

  function pickPoint(label, onPick) {
    if (pickingPoint) return;
    pickingPoint = true;
    const wasHidden = hidden;
    if (!popup) setHidden(true);
    cross.style.display = 'block';

    const h = cross.querySelector('[data-h]');
    const v = cross.querySelector('[data-v]');
    const dot = cross.querySelector('[data-dot]');
    const tip = cross.querySelector('[data-tip]');

    const move = (e) => {
      const x = e.clientX;
      const y = e.clientY;
      h.style.top = y + 'px';
      v.style.left = x + 'px';
      dot.style.left = x + 'px';
      dot.style.top = y + 'px';
      const under = document.elementFromPoint(x, y);
      const tag = under && under !== cross
        ? '<' + under.tagName.toLowerCase() + (under.id ? '#' + under.id : '') + '>'
        : '';
      tip.textContent =
        `${label}  ${Math.round(x + window.scrollX)}, ${Math.round(y + window.scrollY)}  ${tag}`;
      tip.style.left = Math.min(x + 14, window.innerWidth - tip.offsetWidth - 8) + 'px';
      tip.style.top = Math.min(y + 16, window.innerHeight - tip.offsetHeight - 8) + 'px';
    };

    const take = (e) => {
      e.preventDefault();
      e.stopPropagation();
      finish({ x: round(e.clientX + window.scrollX), y: round(e.clientY + window.scrollY) });
    };

    const key = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    };

    function finish(pt) {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', take, true);
      document.removeEventListener('keydown', key, true);
      cross.style.display = 'none';
      pickingPoint = false;
      if (!wasHidden && !popup) setHidden(false);
      if (pt) onPick(pt);
    }

    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', take, true);
    document.addEventListener('keydown', key, true);
  }

  // lay an x and y pair onto a target so it travels to a page point
  function moveToPoint(sel, pt, dur) {
    const at = time;
    const gid = nextGid++;
    const to = offsetToPoint(sel, pt);
    addSegment(sel, 'x', [
      { t: at, val: readValue(sel, 'x'), ease: 'linear' },
      { t: at + dur, val: to.x, ease: 'easeInOut' },
    ], gid);
    addSegment(sel, 'y', [
      { t: at, val: readValue(sel, 'y'), ease: 'linear' },
      { t: at + dur, val: to.y, ease: 'easeInOut' },
    ], gid);
    if (sel === '@cursor' && !hasSeg('@cursor', 'opacity')) {
      addSegment('@cursor', 'opacity', [
        { t: at, val: 0, ease: 'linear' },
        { t: at + Math.min(0.3, dur), val: 1, ease: 'easeOut' },
      ], gid);
    }
    selectGroup(gid);
    commit(at + dur);
  }

  /* ---------- lane packing ---------- */

  // segments share a lane whenever their time spans do not overlap
  function packLanes() {
    const ordered = [...segs].sort((a, b) => segStart(a) - segStart(b));
    const ends = [];
    ordered.forEach((sg) => {
      const s = segStart(sg);
      const e = segEnd(sg);
      let idx = sg.lane;
      const free = (i) => i != null && i < ends.length && ends[i] <= s - 0.02;
      if (!free(idx)) {
        idx = ends.findIndex((end) => end <= s - 0.02);
        if (idx === -1) { idx = ends.length; ends.push(-Infinity); }
      }
      ends[idx] = e;
      sg.lane = idx;
    });
    laneCount = Math.max(1, ends.length);
  }

  /* ---------- build ---------- */

  function remember(el) {
    if (el && el !== cursor && !originals.has(el)) originals.set(el, el.getAttribute('style'));
  }

  function revert() {
    anims.forEach((a) => { try { a.stop(); } catch (_) {} });
    anims = [];
  }

  function restoreAll() {
    revert();
    originals.forEach((style, el) => {
      if (style === null) el.removeAttribute('style');
      else el.setAttribute('style', style);
    });
    originals.clear();
  }

  // one motion animation per element+property, merging every segment on it
  function build() {
    revert();
    segs = segs.filter((sg) => sg.keys.length);
    total = 0;
    segs.forEach((sg) => sg.keys.forEach((k) => { total = Math.max(total, k.t); }));
    total = Math.max(total, audioEnd());
    if (total <= 0) total = 0.001;

    markers = [];
    segs.filter(isEventSeg).forEach((sg) => {
      sg.keys.forEach((k) => markers.push({ t: k.t, type: k.val, detail: k.ease, sel: sg.sel }));
    });
    markers.sort((a, b) => a.t - b.t);

    const byTarget = new Map();
    segs.filter((sg) => !isEventSeg(sg)).forEach((sg) => {
      const id = sg.sel + '\u0000' + sg.prop;
      const bucket = byTarget.get(id) || { sel: sg.sel, prop: sg.prop, keys: [] };
      bucket.keys.push(...sg.keys);
      byTarget.set(id, bucket);
    });

    byTarget.forEach(({ sel, prop, keys }) => {
      const target = resolve(sel);
      if (!target) { console.warn('[animlab] no match for', sel); return; }
      remember(target);
      if (sel === '@page') pageOn();

      const sorted = [...keys].sort((a, b) => a.t - b.t);
      const pts = [];
      if (sorted[0].t > 0) pts.push({ t: 0, val: sorted[0].val, ease: 'linear' });
      pts.push(...sorted);
      if (pts[pts.length - 1].t < total) {
        pts.push({ t: total, val: pts[pts.length - 1].val, ease: 'linear' });
      }
      if (pts.length < 2) pts.push({ ...pts[0], t: total });

      const times = [];
      pts.forEach((p, i) => {
        let v = p.t / total;
        if (i && v <= times[i - 1]) v = times[i - 1] + 1e-4;
        times.push(Math.min(v, 1));
      });

      try {
        const ctrl = animate(
          target,
          { [prop]: pts.map((p) => coerce(resolveDynamic(sel, prop, p.val))) },
          { duration: total, times, ease: pts.slice(1).map((p) => parseEase(p.ease)) }
        );
        ctrl.pause();
        anims.push(ctrl);
      } catch (err) {
        console.warn('[animlab]', sel, prop, err.message);
      }
    });

    packLanes();
    seek(Math.min(time, total));
    $('output').value = exportCode();
    renderTracks();
    renderRange();
  }

  function seek(t) {
    time = Math.max(0, Math.min(t, total));
    anims.forEach((a) => { try { a.time = time; } catch (_) {} });
    $('playhead').style.left = GUTTER + time * pps + 'px';
    $('time').textContent = `${time.toFixed(2)} / ${total.toFixed(2)}s`;
    // the take's live block grows with the playhead
    if (recBar && micRec) recBar.style.width = Math.max((time - micRec.at) * pps, 4) + 'px';
    emitMove();
  }

  /* ---------- transport ---------- */

  function tick(now) {
    if (!playing) return;
    const dt = (now - last) / 1000;
    last = now;
    const from = time;
    // with audio scheduled, its clock is the authority. rAF deltas drift,
    // the audio context clock does not.
    let t;
    if (audioAnchor && actx) {
      t = audioAnchor.timeStart + (actx.currentTime - audioAnchor.ctxStart);
      if (t < from) t = from;   // before the scheduled start, hold
    } else {
      t = from + dt;
    }

    // a take is allowed to run past the end of what exists, so make room for
    // it rather than stopping the playhead dead at the last keyframe
    if (micRec && t > total - 0.5) {
      total = Math.ceil(t + 5);
      renderTracks();
      renderRange();
    }
    t = Math.min(t, total);
    seek(t);
    markers.forEach((m) => { if (m.t > from && m.t <= t) fireMarker(m); });
    if (t >= total && !micRec) {
      stop();
      if (resetOnEnd) seek(0);
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function play() {
    // a take starts wherever the playhead is and runs past the end. rewinding
    // to zero because the playhead sits at total is right for review and
    // wrong for recording, and auto-advance parks it at total constantly.
    if (!micRec) {
      if (total <= 0.01) return;
      if (time >= total) seek(0);
    }
    focusedField = null;
    scheduleAudio(time);
    playing = true;
    last = performance.now();
    $('play').textContent = 'pause';
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    downButtons = 0;
    stopAudio();
    $('play').textContent = 'play';
  }

  /* ---------- creating segments ---------- */

  // adding something walks the playhead to its end, so the next thing you add
  // lands after it rather than on top of it
  function commit(endT) {
    build();
    if (autoAdvance && typeof endT === 'number') {
      seek(endT <= time + 1e-6 ? time + MIN_ADVANCE : endT);
    }
    closePop();
    renderInspector();
  }

  function addSegment(sel, prop, keys, gid) {
    const sg = {
      id: nextId++, sel, prop, lane: null,
      keys: keys.map((k) => {
        const key = { id: nextId++, t: round(k.t), val: String(k.val), ease: k.ease || 'easeOut' };
        if (gid) key.g = gid;
        return key;
      }),
    };
    segs.push(sg);
    const lastK = sg.keys[sg.keys.length - 1];
    if (lastK) selectOnly(sg, lastK);
    return sg;
  }

  $('add').addEventListener('click', () => {
    if (!selectedEl) return;
    const prop = currentProp();
    const dur = Math.max(0.05, parseFloat($('toDur').value) || 0.6);
    addSegment(selectedEl, prop, [
      { t: time, val: readValue(selectedEl, prop), ease: 'linear' },
      { t: time + dur, val: $('toVal').value, ease: 'easeOut' },
    ]);
    commit(time + dur);
  });

  $('applyPreset').addEventListener('click', () => {
    if (!selectedEl) return;
    const amt = parseFloat($('preAmt').value) || 16;
    const dur = Math.max(0.05, parseFloat($('preDur').value) || 0.6);
    const at = time;
    const gid = nextGid++;
    PRESETS[$('preset').value](amt, dur).forEach((spec) => {
      addSegment(selectedEl, spec.prop,
        spec.keys.map(([f, v, e]) => ({ t: at + f * dur, val: v, ease: e || 'easeInOut' })), gid);
    });
    selectGroup(gid);
    commit(at + dur);
  });

  /* ---------- events ---------- */

  $('addEvent').addEventListener('click', () => {
    addSegment(selectedEl || '@cursor', EVT,
      [{ t: time, val: $('evtType').value, ease: $('evtDetail').value.trim() }]);
    commit(time);
  });

  $('fireNow').addEventListener('click', () => {
    fireMarker({
      t: time, type: $('evtType').value,
      detail: $('evtDetail').value.trim(), sel: selectedEl || '@cursor',
    });
  });

  $('dragPair').addEventListener('click', () => {
    const sel = selectedEl || '@cursor';
    const dur = Math.max(0.1, parseFloat($('toDur').value) || 0.6);
    const gid = nextGid++;
    addSegment(sel, EVT, [
      { t: time, val: 'down', ease: '' },
      { t: time + dur, val: 'up', ease: '' },
    ], gid);
    commit(time + dur);
  });

  // typing resolves the real field now, so the segment records exactly where
  // the characters will land instead of guessing at playback time
  function typeOut(text, dur, clearFirst) {
    const chars = [...text];
    if (!chars.length) return;
    const base = selectedEl || 'body';
    const field = fieldFor(base);
    const sel = field ? cssPath(field) : base;
    if (!field) console.warn('[animlab] no text field under', base, '- typing may not land');

    const gid = nextGid++;
    const at = time;
    const step = dur / chars.length;
    const keys = [{ t: at, val: 'focus', ease: '' }];
    if (clearFirst) keys.push({ t: at + step * 0.3, val: 'clearText', ease: '' });
    chars.forEach((ch, i) => {
      const wobble = (Math.sin(i * 12.9898) * 0.5 + 0.5) * 0.5 - 0.25;
      keys.push({ t: at + step * (i + 1 + wobble * 0.6), val: 'text', ease: ch });
    });
    addSegment(sel, EVT, keys, gid);
    selectGroup(gid);
    commit(Math.max(...keys.map((k) => k.t)));
  }

  $('typeIt').addEventListener('click', () =>
    typeOut($('typeText').value, Math.max(0.1, parseFloat($('typeDur').value) || 1.5), false));
  $('typeClear').addEventListener('click', () =>
    typeOut($('typeText').value, Math.max(0.1, parseFloat($('typeDur').value) || 1.5), true));
  $('liveMove').addEventListener('change', (e) => {
    liveMove = e.target.checked;
    lastMovePt = null;
  });

  /* ---------- cursor and zoom ---------- */

  $('preview').addEventListener('click', () => {
    const on = parseFloat(cursor.style.opacity || '0') < 0.5;
    cursor.style.opacity = on ? '1' : '0';
    $('preview').classList.toggle('on', on);
  });

  function fadeCursor(from, to) {
    const dur = Math.max(0.05, parseFloat($('toDur').value) || 0.4);
    addSegment('@cursor', 'opacity', [
      { t: time, val: from, ease: 'linear' },
      { t: time + dur, val: to, ease: to ? 'easeOut' : 'easeIn' },
    ], nextGid++);
    commit(time + dur);
  }
  $('cursorIn').addEventListener('click', () => fadeCursor(0, 1));
  $('cursorOut').addEventListener('click', () => fadeCursor(1, 0));

  $('cursorTrack').addEventListener('click', () => {
    const dur = Math.max(0.2, parseFloat($('toDur').value) || 0.8);
    const at = time;
    const gid = nextGid++;
    // store a reference rather than a coordinate, so the move re-aims itself
    // whenever the page reflows or the window is a different size at render
    const live = selectedEl && !selectedEl.startsWith('@');
    const tx = live ? `@(${selectedEl})` : 500;
    const ty = live ? `@(${selectedEl})` : 400;
    addSegment('@cursor', 'x', [
      { t: at, val: readValue('@cursor', 'x'), ease: 'linear' },
      { t: at + dur, val: tx, ease: 'easeInOut' },
    ], gid);
    addSegment('@cursor', 'y', [
      { t: at, val: readValue('@cursor', 'y'), ease: 'linear' },
      { t: at + dur, val: ty, ease: 'easeInOut' },
    ], gid);
    if (!hasSeg('@cursor', 'opacity')) {
      addSegment('@cursor', 'opacity', [
        { t: at, val: 0, ease: 'linear' },
        { t: at + Math.min(0.3, dur), val: 1, ease: 'easeOut' },
      ], gid);
    }
    selectGroup(gid);
    commit(at + dur);
  });

  $('cursorPoint').addEventListener('click', () => {
    closePop();
    pickPoint('cursor to', (pt) =>
      moveToPoint('@cursor', pt, Math.max(0.2, parseFloat($('toDur').value) || 0.8)));
  });

  $('addPoint').addEventListener('click', () => {
    if (!selectedEl) return;
    closePop();
    const sel = selectedEl;
    pickPoint(shortSel(sel) + ' to', (pt) =>
      moveToPoint(sel, pt, Math.max(0.05, parseFloat($('toDur').value) || 0.6)));
  });

  $('clickPulse').addEventListener('click', () => {
    const at = time;
    addSegment('@cursor', 'scale', [
      { t: at, val: 1, ease: 'linear' },
      { t: at + 0.08, val: 0.72, ease: 'easeOut' },
      { t: at + 0.22, val: 1, ease: 'backOut' },
    ], nextGid++);
    commit(at + 0.22);
  });

  function untransformedCenter(el) {
    const prev = document.body.style.transform;
    document.body.style.transform = 'none';
    const r = el.getBoundingClientRect();
    const box = {
      cx: r.left + window.scrollX + r.width / 2,
      cy: r.top + window.scrollY + r.height / 2,
    };
    document.body.style.transform = prev;
    return box;
  }

  $('zoomTo').addEventListener('click', () => {
    if (!selectedEl || selectedEl.startsWith('@')) return;
    const el = resolve(selectedEl);
    if (!el) return;
    pageOn();
    const s = parseFloat($('zoomAmt').value) || 1.8;
    const { cx, cy } = untransformedCenter(el);
    const dur = 0.8;
    const at = time;
    const gid = nextGid++;
    [
      ['scale', 1, s],
      ['x', 0, round(window.innerWidth / 2 - s * cx)],
      ['y', 0, round(window.innerHeight / 2 - s * cy)],
    ].forEach(([p, from, to]) => {
      addSegment('@page', p, [
        { t: at, val: from, ease: 'linear' },
        { t: at + dur, val: to, ease: 'easeInOut' },
      ], gid);
    });
    selectGroup(gid);
    commit(at + dur);
  });

  $('zoomOut').addEventListener('click', () => {
    pageOn();
    const dur = 0.8;
    const at = time;
    const gid = nextGid++;
    ['scale', 'x', 'y'].forEach((p) => {
      const prior = segs.filter((s) => s.sel === '@page' && s.prop === p).flatMap((s) => s.keys);
      const from = prior.length
        ? prior.sort((a, b) => a.t - b.t)[prior.length - 1].val
        : (p === 'scale' ? 1 : 0);
      addSegment('@page', p, [
        { t: at, val: from, ease: 'linear' },
        { t: at + dur, val: p === 'scale' ? 1 : 0, ease: 'easeInOut' },
      ], gid);
    });
    selectGroup(gid);
    commit(at + dur);
  });

  /* ---------- range ---------- */

  function setRange(a, b) {
    range = b - a < 0.02 ? null : { a: round(Math.max(0, a)), b: round(Math.max(0, b)) };
    renderRange();
  }

  function scaleRange(newA, newB) {
    if (!range) return;
    const { a, b } = range;
    const span = b - a;
    if (span < 1e-6) return;
    const f = (newB - newA) / span;
    if (!isFinite(f) || f <= 0) return;
    const headShift = newA - a;
    const tailShift = newB - b;

    segs.forEach((sg) => sg.keys.forEach((k) => {
      if (k.t < a - 1e-6) {
        if (ripple && headShift) k.t = round(Math.max(0, k.t + headShift));
      } else if (k.t <= b + 1e-6) {
        k.t = round(Math.max(0, newA + (k.t - a) * f));
      } else if (ripple) {
        k.t = round(Math.max(0, k.t + tailShift));
      }
    }));

    range = { a: round(newA), b: round(newB) };
    build();
    renderInspector();
  }

  function renderRange() {
    const strip = $('rstrip');
    const fill = $('bandfill');
    strip.innerHTML = '';
    if (!range) {
      fill.style.display = 'none';
      $('rIn').value = 0; $('rOut').value = 0; $('rLen').value = 0;
      return;
    }
    $('rIn').value = round(range.a);
    $('rOut').value = round(range.b);
    $('rLen').value = round(range.b - range.a);

    const band = document.createElement('div');
    band.className = 'band';
    band.style.left = range.a * pps + 'px';
    band.style.width = Math.max((range.b - range.a) * pps, 4) + 'px';
    const lh = document.createElement('div'); lh.className = 'h l';
    const rh = document.createElement('div'); rh.className = 'h r';
    band.append(lh, rh);
    strip.appendChild(band);

    fill.style.display = 'block';
    fill.style.left = GUTTER + range.a * pps + 'px';
    fill.style.width = Math.max((range.b - range.a) * pps, 2) + 'px';

    const timeAt = (ev) => {
      const r = strip.getBoundingClientRect();
      return Math.max(0, (ev.clientX - r.left) / pps);
    };
    const handle = (node, onEnd, live) => node.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const drag = (ev) => live(snapT(timeAt(ev), ev.altKey), band);
      const up = (ev) => {
        window.removeEventListener('mousemove', drag, true);
        window.removeEventListener('mouseup', up, true);
        onEnd(snapT(timeAt(ev), ev.altKey));
      };
      window.addEventListener('mousemove', drag, true);
      window.addEventListener('mouseup', up, true);
    });

    handle(lh, (t) => scaleRange(Math.min(t, range.b - 0.02), range.b), (t, el) => {
      el.style.left = t * pps + 'px';
      el.style.width = Math.max((range.b - t) * pps, 4) + 'px';
    });
    handle(rh, (t) => scaleRange(range.a, Math.max(t, range.a + 0.02)), (t, el) => {
      el.style.width = Math.max((t - range.a) * pps, 4) + 'px';
    });

    band.addEventListener('mousedown', (e) => {
      if (e.target !== band) return;
      e.preventDefault(); e.stopPropagation();
      const t0 = timeAt(e);
      const a0 = range.a, len = range.b - range.a;
      const drag = (ev) => {
        band.style.left = Math.max(0, snapT(a0 + (timeAt(ev) - t0), ev.altKey)) * pps + 'px';
      };
      const up = (ev) => {
        window.removeEventListener('mousemove', drag, true);
        window.removeEventListener('mouseup', up, true);
        const a = Math.max(0, snapT(a0 + (timeAt(ev) - t0), ev.altKey));
        setRange(a, a + len);
      };
      window.addEventListener('mousemove', drag, true);
      window.addEventListener('mouseup', up, true);
    });
  }

  $('rstrip').addEventListener('mousedown', (e) => {
    if (e.target !== $('rstrip')) return;
    e.preventDefault();
    const r = $('rstrip').getBoundingClientRect();
    const t0 = Math.max(0, (e.clientX - r.left) / pps);
    const drag = (ev) => {
      const t1 = Math.max(0, (ev.clientX - r.left) / pps);
      setRange(snapT(Math.min(t0, t1), ev.altKey), snapT(Math.max(t0, t1), ev.altKey));
    };
    const up = () => {
      window.removeEventListener('mousemove', drag, true);
      window.removeEventListener('mouseup', up, true);
    };
    window.addEventListener('mousemove', drag, true);
    window.addEventListener('mouseup', up, true);
  });

  $('rRipple').addEventListener('change', (e) => (ripple = e.target.checked));
  $('rFit').addEventListener('click', () => {
    if (!range) return;
    scaleRange(range.a, range.a + Math.max(0.02, parseFloat($('rLen').value) || 0));
  });
  $('rHalf').addEventListener('click', () => range && scaleRange(range.a, range.a + (range.b - range.a) / 2));
  $('rDouble').addEventListener('click', () => range && scaleRange(range.a, range.a + (range.b - range.a) * 2));
  $('rFromSel').addEventListener('click', () => {
    const ts = selected().map((p) => p.k.t);
    if (ts.length) setRange(Math.min(...ts), Math.max(...ts));
  });
  $('rAll').addEventListener('click', () => setRange(0, total));
  $('rClear').addEventListener('click', () => setRange(0, 0));
  ['rIn', 'rOut'].forEach((id) => $(id).addEventListener('change', () =>
    setRange(parseFloat($('rIn').value) || 0, parseFloat($('rOut').value) || 0)));

  /* ---------- rendering ---------- */

  function renderTracks() {
    const rows = $('rows');
    const ruler = $('ruler');
    rows.innerHTML = '';
    ruler.innerHTML = '';
    keyNodes = [];
    segNodes.clear();

    const span = Math.max(total + 1.5, 6);
    const w = span * pps;
    ruler.style.width = w + 'px';
    $('rstrip').style.width = w + 'px';
    $('grid').style.width = GUTTER + w + 'px';

    for (let t = 0; t <= span; t += 0.5) {
      const major = Math.abs(t - Math.round(t)) < 1e-6;
      const tk = document.createElement('div');
      tk.className = 'tick' + (major ? ' major' : '');
      tk.style.left = t * pps + 'px';
      ruler.appendChild(tk);
      if (major) {
        const lb = document.createElement('div');
        lb.className = 'tick-label';
        lb.style.left = t * pps + 'px';
        lb.textContent = t + 's';
        ruler.appendChild(lb);
      }
    }

    if (audioClips.length || micRec) {
      const arow = document.createElement('div');
      arow.className = 'audiorow';
      const acell = document.createElement('div');
      acell.className = 'audiocell';
      acell.textContent = micRec ? 'rec' : 'audio';
      const alane = document.createElement('div');
      alane.className = 'audiolane';
      alane.style.width = w + 'px';

      const cv = document.createElement('canvas');
      alane.appendChild(cv);
      arow.append(acell, alane);
      rows.appendChild(arow);
      drawWaves(cv, w);

      audioClips.forEach((c) => {
        const el = document.createElement('div');
        el.className = 'aclip' + (selectedClip === c.id ? ' sel' : '');
        el.style.left = c.offset * pps + 'px';
        el.style.width = Math.max(clipLen(c) * pps, 6) + 'px';
        el.title = `${c.name} · ${round(clipLen(c))}s`;
        const nm = document.createElement('div');
        nm.className = 'nm';
        nm.textContent = c.name;
        el.appendChild(nm);
        el.addEventListener('mousedown', (ev) => {
          if (ev.target !== el && ev.target !== nm) return;
          ev.preventDefault();
          ev.stopPropagation();
          takeTimelineFocus();
          selectedClip = c.id;
          slideClip(ev, c, el, cv, w);
        });
        addClipHandles(el, c, cv, w);
        alane.appendChild(el);
      });

      if (micRec) {
        const live = document.createElement('div');
        live.className = 'arec';
        live.style.left = micRec.at * pps + 'px';
        live.style.width = Math.max((time - micRec.at) * pps, 4) + 'px';
        live.innerHTML = '<div class="dot"></div>';
        alane.appendChild(live);
        recBar = live;
      } else recBar = null;
    }

    if (!segs.length) {
      // append a node rather than touching innerHTML: reassigning it would
      // re-parse the audio row above, handing back a blank canvas and
      // throwing away every listener on the clips
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = audioClips.length
        ? 'audio is loaded. pick a target, then add an animation, an event or a preset'
        : 'pick a target, then add an animation, an event or a preset';
      rows.appendChild(note);
      return;
    }

    for (let i = 0; i < laneCount; i++) {
      const row = document.createElement('div');
      row.className = 'row';
      const cell = document.createElement('div');
      cell.className = 'gcell';
      cell.textContent = i + 1;
      const lane = document.createElement('div');
      lane.className = 'lane';
      lane.style.width = w + 'px';

      segs.filter((sg) => sg.lane === i).forEach((sg) => renderSegment(sg, lane));

      lane.addEventListener('mousedown', (e) => {
        if (e.target !== lane) return;
        startMarquee(e);
      });
      lane.addEventListener('dblclick', (e) => {
        if (e.target !== lane) return;
        const picked = selected();
        const sg = picked.length && picked.every((p) => p.sg === picked[0].sg) ? picked[0].sg : null;
        if (!sg) return;
        const r = lane.getBoundingClientRect();
        addKeyToSegment(sg, snapT((e.clientX - r.left) / pps, e.altKey));
      });
      row.append(cell, lane);
      rows.appendChild(row);
    }
  }

  function renderSegment(sg, lane) {
    const evt = isEventSeg(sg);
    const sorted = [...sg.keys].sort((a, b) => a.t - b.t);
    const s = segStart(sg);
    const e = segEnd(sg);
    const anySel = sg.keys.some((k) => selection.has(refOf(sg, k)));
    const allSel = sg.keys.length > 0 && sg.keys.every((k) => selection.has(refOf(sg, k)));
    const dom = { band: null, label: null, lines: [], links: [], keys: [], labels: [] };
    segNodes.set(sg.id, dom);

    const band = document.createElement('div');
    dom.band = band;
    band.className = 'segband' + (evt ? ' events' : '') +
      (allSel ? ' sel allsel' : anySel ? ' sel' : '');
    band.style.left = s * pps - 3 + 'px';
    band.style.width = Math.max((e - s) * pps + 6, 20) + 'px';
    band.title = `${segLabel(sg)} · ${round(s)}s → ${round(e)}s`;
    band.addEventListener('mousedown', (ev) => {
      if (ev.target !== band) return;
      ev.preventDefault();
      ev.stopPropagation();
      takeTimelineFocus();
      dragBundle(ev, sorted.map((k) => ({ sg, k })));
    });
    addEdgeHandles(band, 'sbh', () =>
      [...sg.keys].sort((a, b) => a.t - b.t).map((k) => ({ sg, k })));
    lane.appendChild(band);

    const label = document.createElement('div');
    dom.label = label;
    label.className = 'seglabel' + (evt ? ' events' : '');
    label.style.left = s * pps - 1 + 'px';
    label.textContent = segLabel(sg);
    lane.appendChild(label);

    // group bars: drag one to move that whole gesture
    const extents = new Map();
    sorted.forEach((k) => {
      if (!k.g) return;
      const x = extents.get(k.g) || { min: k.t, max: k.t };
      x.min = Math.min(x.min, k.t);
      x.max = Math.max(x.max, k.t);
      extents.set(k.g, x);
    });
    extents.forEach((x, gid) => {
      const bar = document.createElement('div');
      bar.className = 'glink';
      bar.style.left = x.min * pps + 'px';
      bar.style.width = Math.max(x.max - x.min, 0.05) * pps + 'px';
      bar.style.background = `hsl(${groupHue(gid)} 60% 55%)`;
      bar.title = 'drag to move the whole group';
      // a group can span several segments, so gather it from all of them
      const groupBundle = () => {
        const out = [];
        segs.forEach((s2) => s2.keys.forEach((k2) => {
          if (k2.g === gid) out.push({ sg: s2, k: k2 });
        }));
        return out.sort((a, b) => a.k.t - b.k.t);
      };
      bar.addEventListener('mousedown', (ev) => {
        if (ev.target !== bar) return;
        ev.preventDefault();
        ev.stopPropagation();
        takeTimelineFocus();
        dragBundle(ev, groupBundle());
      });
      addEdgeHandles(bar, 'gh', groupBundle);
      lane.appendChild(bar);
      dom.links.push({ el: bar, gid });
    });

    const mini = evt && sorted.length > 12;
    sorted.forEach((k, i) => {
      if (!evt && i) {
        const prev = sorted[i - 1];
        const line = document.createElement('div');
        line.className = 'seg';
        line.style.left = prev.t * pps + 'px';
        line.style.width = (k.t - prev.t) * pps + 'px';
        lane.appendChild(line);
        dom.lines.push(line);
      }
      const node = document.createElement('div');
      const isSel = selection.has(refOf(sg, k));
      const isPrim = primary && primary.segId === sg.id && primary.keyId === k.id;
      node.className = 'key' + (evt ? ' event' : '') + (mini ? ' mini' : '') +
        (isSel ? ' selected' : '') + (isPrim ? ' primary' : '');
      node.style.left = k.t * pps + 'px';
      if (k.g) node.style.borderColor = `hsl(${groupHue(k.g)} 70% 70%)`;
      node.title = evt
        ? `${round(k.t)}s · ${(EVENTS[k.val] || {}).label || k.val}${k.ease ? ' “' + k.ease + '”' : ''}`
        : isDynamic(k.val)
          ? `${round(k.t)}s → follows ${k.val.slice(2, -1)} (now ${resolveDynamic(sg.sel, sg.prop, k.val)})`
          : `${round(k.t)}s → ${k.val}`;
      if (!evt && isDynamic(k.val)) node.classList.add('dynamic');
      node.addEventListener('mousedown', (ev) => onKeyDown(ev, sg, k));
      lane.appendChild(node);
      keyNodes.push({ node, sg, k });
      dom.keys.push({ el: node, k });

      if (evt && !mini) {
        const lb = document.createElement('div');
        lb.className = 'evt-label';
        lb.style.left = k.t * pps + 9 + 'px';
        lb.textContent = k.val === 'text' ? JSON.stringify(k.ease || ' ') : (EVENTS[k.val] || {}).label || k.val;
        lane.appendChild(lb);
        dom.labels.push({ el: lb, k });
      }
    });

    band.addEventListener('dblclick', (ev) => {
      if (ev.target !== band) return;
      const r = lane.getBoundingClientRect();
      addKeyToSegment(sg, snapT((ev.clientX - r.left) / pps, ev.altKey));
    });
  }

  // recompute a segment's geometry from its current key times, mid-drag
  function refreshSeg(sg) {
    const dom = segNodes.get(sg.id);
    if (!dom) return;
    const sorted = [...sg.keys].sort((a, b) => a.t - b.t);
    const s = sorted.length ? sorted[0].t : 0;
    const e = sorted.length ? sorted[sorted.length - 1].t : 0;

    if (dom.band) {
      dom.band.style.left = s * pps - 3 + 'px';
      dom.band.style.width = Math.max((e - s) * pps + 6, 20) + 'px';
    }
    if (dom.label) dom.label.style.left = s * pps - 1 + 'px';

    dom.lines.forEach((line, i) => {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (!a || !b) { line.style.width = '0px'; return; }
      line.style.left = a.t * pps + 'px';
      line.style.width = (b.t - a.t) * pps + 'px';
    });

    dom.links.forEach(({ el, gid }) => {
      const ts = sg.keys.filter((k) => k.g === gid).map((k) => k.t);
      if (!ts.length) return;
      const min = Math.min(...ts);
      const max = Math.max(...ts);
      el.style.left = min * pps + 'px';
      el.style.width = Math.max(max - min, 0.05) * pps + 'px';
    });

    dom.keys.forEach(({ el, k }) => { el.style.left = k.t * pps + 'px'; });
    dom.labels.forEach(({ el, k }) => { el.style.left = k.t * pps + 9 + 'px'; });
  }

  function addKeyToSegment(sg, t) {
    const evt = isEventSeg(sg);
    const sorted = [...sg.keys].sort((a, b) => a.t - b.t);
    const near = sorted.filter((x) => x.t <= t).pop() || sorted[0];
    const key = {
      id: nextId++, t: round(t),
      val: evt ? ($('evtType').value) : String(near ? near.val : readValue(sg.sel, sg.prop)),
      ease: evt ? $('evtDetail').value.trim() : 'easeOut',
    };
    sg.keys.push(key);
    selectOnly(sg, key);
    build();
    renderInspector();
  }

  /* ---------- dragging ---------- */

  // clicking the timeline must pull focus out of any inspector field, or the
  // field keeps swallowing delete and the arrow keys
  function takeTimelineFocus() {
    const a = root.activeElement;
    if (a && a.blur) a.blur();
    ownField = null;
    $('tl').focus({ preventScroll: true });
  }

  // Select a whole bundle of keyframes at once: a segment band, or a group
  // bar. Shift adds it to what is already selected, or takes it back out if
  // the whole bundle was in. A plain click on a bundle that is already fully
  // selected leaves the wider selection alone, so it drags as one.
  // Returns false when there is nothing left to drag.
  function selectBundle(e, bundle) {
    if (!bundle.length) return false;
    const refs = bundle.map(({ sg, k }) => refOf(sg, k));
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const allIn = refs.every((r) => selection.has(r));

    if (additive && allIn) {
      refs.forEach((r) => selection.delete(r));
      primary = null;
      return false;
    }
    if (additive) refs.forEach((r) => selection.add(r));
    else if (!allIn) selection = new Set(refs);

    primary = { segId: bundle[0].sg.id, keyId: bundle[0].k.id };
    return true;
  }

  function dragBundle(e, bundle) {
    if (!selectBundle(e, bundle)) {
      renderTracks();
      renderInspector();
      return;
    }
    renderTracks();
    renderInspector();
    const picked = selected();
    const anchor = picked.find((p) => p.k === bundle[0].k) || picked[0];
    if (anchor) beginDrag(e, anchor.k, picked);
  }

  // a keyframe drags alone unless it is part of an explicit multi-selection
  function onKeyDown(e, sg, k) {
    e.preventDefault();
    e.stopPropagation();
    takeTimelineFocus();
    const ref = refOf(sg, k);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;

    if (additive && selection.has(ref)) {
      // shift-clicking something already selected takes it out, and there is
      // nothing sensible to drag from a keyframe you just dropped
      selection.delete(ref);
      if (primary && primary.keyId === k.id) primary = null;
      renderTracks();
      renderInspector();
      return;
    }

    if (additive) {
      selection.add(ref);
      primary = { segId: sg.id, keyId: k.id };
    } else if (!selection.has(ref)) {
      selectOnly(sg, k);
    } else {
      primary = { segId: sg.id, keyId: k.id };
    }

    renderTracks();
    renderInspector();
    // whatever is selected now moves together, including the one just added
    beginDrag(e, k, selected());
  }

  // everything a dragged keyframe can stick to
  function snapTargets(dragged) {
    const out = [];
    segs.forEach((sg) => sg.keys.forEach((k) => {
      if (!dragged.has(k)) out.push(k.t);
    }));
    segs.forEach((sg) => {
      const ts = sg.keys.filter((k) => !dragged.has(k)).map((k) => k.t);
      if (ts.length) { out.push(Math.min(...ts)); out.push(Math.max(...ts)); }
    });
    out.push(time, 0);
    if (range) out.push(range.a, range.b);
    for (let t = 0; t <= total + 3; t += 0.5) out.push(t);
    return [...new Set(out.map((t) => round(t)))];
  }

  function beginDrag(e, anchor, picked) {
    if (!picked.length) return;
    const starts = picked.map(({ sg, k }) => ({ sg, k, t0: k.t }));
    const touched = [...new Set(starts.map((s) => s.sg))];
    const minT = Math.min(...starts.map((s) => s.t0));
    const anchorT0 = anchor.t;
    const x0 = e.clientX;
    const dragged = new Set(starts.map((s) => s.k));
    const targets = snapTargets(dragged);
    const guide = $('snapline');
    const ghost = $('dragghost');
    const spanLen = Math.max(...starts.map((s) => s.t0)) - minT;

    ghost.style.display = 'block';
    document.body.style.cursor = 'grabbing';

    const move = (ev) => {
      if (ev.buttons === 0) { up(); return; }
      let dt = snapT(anchorT0 + (ev.clientX - x0) / pps, ev.altKey) - anchorT0;
      if (minT + dt < 0) dt = -minT;

      // magnetic pull toward the nearest edge, unless shift says otherwise
      let hit = null;
      if (!ev.altKey) {
        const tol = 7 / pps;
        starts.forEach(({ t0 }) => {
          const t = t0 + dt;
          targets.forEach((c) => {
            const d = c - t;
            if (Math.abs(d) <= tol && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, at: c };
          });
        });
        if (hit && minT + dt + hit.d >= 0) dt += hit.d;
      }

      starts.forEach(({ k, t0 }) => { k.t = t0 + dt; });
      touched.forEach(refreshSeg);

      if (hit) {
        guide.style.display = 'block';
        guide.style.left = GUTTER + hit.at * pps + 'px';
      } else guide.style.display = 'none';

      ghost.style.left = GUTTER + (minT + dt) * pps + 'px';
      ghost.style.width = Math.max(spanLen * pps, 2) + 'px';

      $('time').textContent =
        (picked.length > 1 ? `${picked.length} keys ` : 'key ') +
        (dt >= 0 ? '+' : '') + round(dt) + 's' +
        (hit ? `  ↦ ${round(hit.at)}s` : '');
    };

    let done = false;
    const up = () => {
      if (done) return;
      done = true;
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      window.removeEventListener('blur', up);
      guide.style.display = 'none';
      ghost.style.display = 'none';
      document.body.style.cursor = '';
      starts.forEach(({ k }) => { k.t = round(k.t); });
      build();
      renderInspector();
    };

    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    window.addEventListener('blur', up, { once: true });
  }

  /* Grab the side of a group or a segment to stretch or squeeze it. The far
     edge stays put and everything inside scales toward or away from it, so the
     shape of the gesture survives and only its speed changes. */
  function beginEdgeScale(e, bundle, edge) {
    if (!bundle.length) return;
    const ts = bundle.map((p) => p.k.t);
    const a0 = Math.min(...ts);
    const b0 = Math.max(...ts);
    if (b0 - a0 < 1e-6) return;          // a single instant has no side to pull

    const anchor = edge === 'l' ? b0 : a0;
    const starts = bundle.map((p) => ({ k: p.k, t0: p.k.t }));
    const touched = [...new Set(bundle.map((p) => p.sg))];
    const dragged = new Set(starts.map((s) => s.k));
    const targets = snapTargets(dragged);
    const guide = $('snapline');
    const x0 = e.clientX;
    const edge0 = edge === 'l' ? a0 : b0;

    document.body.style.cursor = 'ew-resize';

    const move = (ev) => {
      if (ev.buttons === 0) { up(); return; }
      let t = snapT(edge0 + (ev.clientX - x0) / pps, ev.altKey);

      let hit = null;
      if (!ev.altKey) {
        const tol = 7 / pps;
        targets.forEach((c) => {
          const d = c - t;
          if (Math.abs(d) <= tol && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, at: c };
        });
        if (hit) t = hit.at;
      }

      // keep at least one snap step of span, and never cross the anchor
      t = edge === 'l'
        ? Math.max(0, Math.min(t, anchor - SNAP))
        : Math.max(t, anchor + SNAP);

      const f = edge === 'l'
        ? (anchor - t) / (anchor - a0)
        : (t - anchor) / (b0 - anchor);
      if (!isFinite(f) || f <= 0) return;

      starts.forEach(({ k, t0 }) => { k.t = Math.max(0, anchor + (t0 - anchor) * f); });
      touched.forEach(refreshSeg);

      if (hit) {
        guide.style.display = 'block';
        guide.style.left = GUTTER + hit.at * pps + 'px';
      } else guide.style.display = 'none';

      const span = Math.abs(t - anchor);
      $('time').textContent = `span ${round(span)}s  ×${round(f)}`;
    };

    let closed = false;
    const up = () => {
      if (closed) return;
      closed = true;
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      window.removeEventListener('blur', up);
      guide.style.display = 'none';
      document.body.style.cursor = '';
      starts.forEach(({ k }) => { k.t = round(k.t); });
      build();
      renderInspector();
    };

    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    window.addEventListener('blur', up, { once: true });
  }

  function addEdgeHandles(parent, cls, getBundle) {
    ['l', 'r'].forEach((edge) => {
      const h = document.createElement('div');
      h.className = `${cls} ${edge}`;
      h.title = 'drag to stretch or squeeze this, anchored at the far end';
      h.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        takeTimelineFocus();
        const bundle = getBundle();
        selectBundle({ shiftKey: false, metaKey: false, ctrlKey: false }, bundle);
        renderTracks();
        renderInspector();
        beginEdgeScale(ev, bundle, edge);
      });
      parent.appendChild(h);
    });
  }

  function startMarquee(e) {
    e.preventDefault();
    takeTimelineFocus();
    selectedClip = null;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? new Set(selection) : new Set();
    const box = $('marquee');
    const bounds = $('tl').getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    const clampX = (v) => Math.max(bounds.left, Math.min(bounds.right, v));
    const clampY = (v) => Math.max(bounds.top, Math.min(bounds.bottom, v));

    const move = (ev) => {
      if (ev.buttons === 0) { up(); return; }
      moved = true;
      const x1 = clampX(ev.clientX), y1 = clampY(ev.clientY);
      const r = {
        left: Math.min(x0, x1), right: Math.max(x0, x1),
        top: Math.min(y0, y1), bottom: Math.max(y0, y1),
      };
      Object.assign(box.style, {
        display: 'block', left: r.left + 'px', top: r.top + 'px',
        width: r.right - r.left + 'px', height: r.bottom - r.top + 'px',
      });
      selection = new Set(base);
      keyNodes.forEach(({ node, sg, k }) => {
        const kr = node.getBoundingClientRect();
        if (kr.right >= r.left && kr.left <= r.right && kr.bottom >= r.top && kr.top <= r.bottom) {
          selection.add(refOf(sg, k));
        }
      });
      keyNodes.forEach(({ node, sg, k }) =>
        node.classList.toggle('selected', selection.has(refOf(sg, k))));
      $('time').textContent = `${selection.size} selected`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      box.style.display = 'none';
      if (!moved && !additive) clearSelection();
      if (selection.size && !primary) {
        const first = selected()[0];
        if (first) primary = { segId: first.sg.id, keyId: first.k.id };
      }
      renderTracks();
      renderInspector();
      seek(time);
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  }

  function deleteSelected() {
    if (!selection.size) return;
    segs.forEach((sg) => { sg.keys = sg.keys.filter((k) => !selection.has(refOf(sg, k))); });
    clearSelection();
    build();
    renderInspector();
  }

  /* ---------- inspector ---------- */

  function retarget(sg, field, value) {
    sg[field] = value;
    build();
    renderInspector();
  }

  function segBlock(sg) {
    const evt = isEventSeg(sg);
    return `
      <div class="block">
        <h4>segment</h4>
        <div class="pg">
          <div class="lbl">target</div>
          <input class="wide" id="tSel" value="${esc(sg.sel)}">
          ${evt ? '' : `
          <div class="lbl">property</div>
          <select class="wide" id="tProp">${propOptions(sg.prop)}</select>
          <div class="lbl"></div>
          <input class="wide" id="tPropCustom" placeholder="property name" hidden>`}
          <div class="lbl">lane</div>
          <div class="wide" style="display:flex;gap:5px">
            <button id="laneUp">▲</button>
            <button id="laneDown">▼</button>
            <span class="lbl" style="align-self:center">now ${sg.lane + 1}</span>
          </div>
        </div>
        <div class="prow">
          <button class="go" id="segAddKey">+ keyframe at playhead</button>
          <button id="segAddEnd">+ at end</button>
          <button id="segDel">delete segment</button>
        </div>
      </div>`;
  }

  function wireSegBlock(box, sg) {
    const si = box.querySelector('#tSel');
    if (si) si.addEventListener('change', () => {
      const v = si.value.trim();
      if (v && v !== sg.sel) retarget(sg, 'sel', v);
    });
    const ps = box.querySelector('#tProp');
    if (ps) {
      const custom = box.querySelector('#tPropCustom');
      ps.addEventListener('change', () => {
        if (ps.value === '__custom') { custom.hidden = false; custom.focus(); return; }
        retarget(sg, 'prop', ps.value);
      });
      custom.addEventListener('change', () => {
        const v = custom.value.trim();
        if (v) retarget(sg, 'prop', v);
      });
    }
    box.querySelector('#laneUp').addEventListener('click', () => {
      sg.lane = Math.max(0, sg.lane - 1);
      build();
      renderInspector();
    });
    box.querySelector('#laneDown').addEventListener('click', () => {
      sg.lane = sg.lane + 1;
      build();
      renderInspector();
    });
    box.querySelector('#segAddKey').addEventListener('click', () => addKeyToSegment(sg, time));
    box.querySelector('#segAddEnd').addEventListener('click', () =>
      addKeyToSegment(sg, segEnd(sg) + Math.max(0.05, parseFloat($('toDur').value) || 0.5)));
    box.querySelector('#segDel').addEventListener('click', () => {
      segs = segs.filter((s) => s !== sg);
      clearSelection();
      build();
      renderInspector();
    });
  }

  function renderInspector() {
    const box = $('insp');
    const picked = selected();

    if (!picked.length) {
      box.innerHTML =
        '<div class="empty-note">nothing selected</div>' +
        '<div class="hint">click a keyframe, a segment band, or a group bar to select it. ' +
        'shift-click any of them to add or remove. drag a lane to marquee. ' +
        'dragging anything selected moves the whole selection, spacing kept. ' +
        'grab the left or right edge of a band or group bar to stretch or squeeze it. ' +
        'hold alt for free timing.</div>';
      return;
    }

    const oneSeg = picked.every((p) => p.sg === picked[0].sg) ? picked[0].sg : null;

    if (picked.length > 1) {
      const times = picked.map((p) => p.k.t);
      const gids = new Set(picked.map((p) => p.k.g).filter(Boolean));
      const ordered = [...picked].sort((a, b) => a.k.t - b.k.t);
      const rows = ordered.slice(0, 40).map((p, i) => {
        const ev = isEventSeg(p.sg);
        const color = p.k.g ? `background:hsl(${groupHue(p.k.g)} 60% 55%)` : '';
        return `<div class="krow">
          <div class="kdot${ev ? ' event' : ''}" style="${color}" title="${esc(p.sg.prop)}"></div>
          <input data-i="${i}" data-f="t" value="${round(p.k.t)}">
          <input data-i="${i}" data-f="val" value="${esc(p.k.val)}">
          <button class="tiny" data-i="${i}">×</button>
        </div>`;
      }).join('');

      box.innerHTML = (oneSeg ? segBlock(oneSeg) : '') + `
        <div class="count">${picked.length} keyframes${gids.size ? ` · ${gids.size} group${gids.size > 1 ? 's' : ''}` : ''}</div>
        <div class="block">
          <h4>values</h4>
          <div class="klist" id="klist">${rows}</div>
          ${picked.length > 40 ? '<div class="hint">showing the first 40</div>' : ''}
        </div>
        <div class="block">
          <h4>timing</h4>
          <div class="pg">
            <div class="lbl">nudge</div><input id="mNudge" value="0.1"><button id="mNudgeGo">shift</button>
            <div class="lbl">spread</div><input id="mScale" value="1.25"><button id="mScaleGo">rescale</button>
            <div class="lbl">ease in</div><input list="eases" id="mEase" value="easeInOut"><button id="mEaseGo">all</button>
          </div>
        </div>
        <div class="actions">
          <button id="mRange">set range</button>
          <button id="mGroup">group</button>
          <button id="mUngroup">ungroup</button>
          <button id="mDel">delete ${picked.length}</button>
          <button id="mClear">clear</button>
        </div>
      `;
      if (oneSeg) wireSegBlock(box, oneSeg);

      box.querySelectorAll('#klist input').forEach((inp) => inp.addEventListener('change', () => {
        const p = ordered[Number(inp.dataset.i)];
        if (!p) return;
        if (inp.dataset.f === 't') p.k.t = Math.max(0, parseFloat(inp.value) || 0);
        else p.k.val = inp.value;
        build();
        renderInspector();
      }));
      box.querySelectorAll('#klist button').forEach((btn) => btn.addEventListener('click', () => {
        const p = ordered[Number(btn.dataset.i)];
        if (!p) return;
        selection.delete(refOf(p.sg, p.k));
        p.sg.keys = p.sg.keys.filter((x) => x !== p.k);
        build();
        renderInspector();
      }));
      box.querySelector('#mNudgeGo').addEventListener('click', () => {
        const dt = parseFloat(box.querySelector('#mNudge').value) || 0;
        const minT = Math.min(...picked.map((p) => p.k.t));
        const d = Math.max(dt, -minT);
        picked.forEach(({ k }) => { k.t = round(k.t + d); });
        build();
        renderInspector();
      });
      box.querySelector('#mScaleGo').addEventListener('click', () => {
        const f = parseFloat(box.querySelector('#mScale').value) || 1;
        const minT = Math.min(...picked.map((p) => p.k.t));
        picked.forEach(({ k }) => { k.t = round(minT + (k.t - minT) * f); });
        build();
        renderInspector();
      });
      box.querySelector('#mEaseGo').addEventListener('click', () => {
        const e = box.querySelector('#mEase').value;
        picked.forEach(({ sg, k }) => { if (!isEventSeg(sg)) k.ease = e; });
        build();
        renderInspector();
      });
      box.querySelector('#mRange').addEventListener('click', () =>
        setRange(Math.min(...times), Math.max(...times)));
      box.querySelector('#mGroup').addEventListener('click', () => {
        const gid = nextGid++;
        picked.forEach(({ k }) => { k.g = gid; });
        renderTracks(); renderInspector();
      });
      box.querySelector('#mUngroup').addEventListener('click', () => {
        picked.forEach(({ k }) => { delete k.g; });
        renderTracks(); renderInspector();
      });
      box.querySelector('#mDel').addEventListener('click', deleteSelected);
      box.querySelector('#mClear').addEventListener('click', () => {
        clearSelection(); renderTracks(); renderInspector();
      });
      return;
    }

    const { sg, k } = picked[0];
    const evt = isEventSeg(sg);
    const spec = evt ? (EVENTS[k.val] || {}) : SPEC[sg.prop];
    const swatch = !evt && spec && spec.kind === 'color'
      ? `<div class="lbl">color</div><div class="wide"><input type="color" id="kColor" value="${/^#[0-9a-f]{6}$/i.test(k.val) ? k.val : '#ffffff'}"></div>`
      : '';

    box.innerHTML = segBlock(sg) + `
      <div class="block">
        <h4>${evt ? 'event marker' : 'keyframe'}</h4>
        <div class="pg">
          <div class="lbl">time</div>
          <input value="${round(k.t)}" data-k="t">
          ${evt ? '<button id="eFire">fire now</button>' : `<input value="${esc(k.val)}" data-k="val">`}
          ${evt ? `
          <div class="lbl">type</div>
          <select class="wide" id="eType">
            ${Object.entries(EVENTS).map(([key, v]) =>
              `<option value="${key}"${key === k.val ? ' selected' : ''}>${v.label}</option>`).join('')}
          </select>
          <div class="lbl">detail</div>
          <input class="wide" value="${esc(k.ease || '')}" data-k="ease"
                 placeholder="${spec.detailHint || (spec.wheel !== undefined ? 'multiplier' : 'unused')}">`
          : `
          <div class="lbl">ease in</div>
          <input list="eases" class="wide" value="${esc(k.ease)}" data-k="ease">
          ${swatch}
          ${sg.prop === 'x' || sg.prop === 'y' ? `
          <div class="lbl">point</div>
          <div class="wide" style="display:flex;gap:5px">
            <button id="kPoint">pick a spot ⌖</button>
            ${isDynamic(k.val)
              ? '<button id="kFreeze">freeze to a number</button>'
              : '<button id="kFollow">follow an element ⌖</button>'}
          </div>
          ${isDynamic(k.val) ? `<div class="full hint">follows ${esc(k.val.slice(2, -1))}, currently ${resolveDynamic(sg.sel, sg.prop, k.val)}. it re-aims on every rebuild, resize and render.</div>` : ''}` : ''}`}
        </div>
      </div>
      <div class="actions">
        ${evt ? '' : '<button id="grab">read from page</button>'}
        <button id="kdup">duplicate</button>
        <button id="kdel">delete</button>
        ${k.g ? '<button id="kUngroup">ungroup</button>' : ''}
      </div>
    `;
    wireSegBlock(box, sg);
    box.querySelectorAll('input[data-k]').forEach((inp) => inp.addEventListener('change', () => {
      const key = inp.dataset.k;
      k[key] = key === 't' ? Math.max(0, parseFloat(inp.value) || 0) : inp.value;
      build();
      renderInspector();
    }));
    const et = box.querySelector('#eType');
    if (et) et.addEventListener('change', (e) => { k.val = e.target.value; build(); renderInspector(); });
    const ef = box.querySelector('#eFire');
    if (ef) ef.addEventListener('click', () =>
      fireMarker({ t: k.t, type: k.val, detail: k.ease, sel: sg.sel }));
    const kc = box.querySelector('#kColor');
    if (kc) kc.addEventListener('input', () => { k.val = kc.value; build(); renderInspector(); });
    const kfz = box.querySelector('#kFreeze');
    if (kfz) kfz.addEventListener('click', () => {
      k.val = String(resolveDynamic(sg.sel, sg.prop, k.val));
      build();
      renderInspector();
    });
    const kfl = box.querySelector('#kFollow');
    if (kfl) kfl.addEventListener('click', () => {
      pickPoint('follow which element', (pt) => {
        const el = document.elementFromPoint(pt.x - window.scrollX, pt.y - window.scrollY);
        if (!el) return;
        const ref = `@(${cssPath(el)})`;
        k.val = ref;
        const other = sg.prop === 'x' ? 'y' : 'x';
        segs.filter((s) => s.sel === sg.sel && s.prop === other).forEach((s) => {
          const twin = s.keys.find((x) => Math.abs(x.t - k.t) < 0.001);
          if (twin) twin.val = ref;
        });
        build();
        renderInspector();
      });
    });

    const kp = box.querySelector('#kPoint');
    if (kp) kp.addEventListener('click', () => {
      pickPoint(`${shortSel(sg.sel)} ${sg.prop} to`, (pt) => {
        const to = offsetToPoint(sg.sel, pt);
        k.val = String(sg.prop === 'x' ? to.x : to.y);
        // keep the other axis in step if it has a keyframe at the same moment
        const other = sg.prop === 'x' ? 'y' : 'x';
        segs.filter((s) => s.sel === sg.sel && s.prop === other).forEach((s) => {
          const twin = s.keys.find((x) => Math.abs(x.t - k.t) < 0.001);
          if (twin) twin.val = String(other === 'x' ? to.x : to.y);
        });
        build();
        renderInspector();
      });
    });

    const gb = box.querySelector('#grab');
    if (gb) gb.addEventListener('click', () => {
      k.val = String(readValue(sg.sel, sg.prop));
      build(); renderInspector();
    });
    box.querySelector('#kdup').addEventListener('click', () => {
      const copy = { ...k, id: nextId++, t: round(k.t + 0.3) };
      delete copy.g;
      sg.keys.push(copy);
      selectOnly(sg, copy);
      build(); renderInspector();
    });
    box.querySelector('#kdel').addEventListener('click', deleteSelected);
    const ug = box.querySelector('#kUngroup');
    if (ug) ug.addEventListener('click', () => {
      const gid = k.g;
      segs.forEach((s2) => s2.keys.forEach((k2) => { if (k2.g === gid) delete k2.g; }));
      renderTracks(); renderInspector();
    });
  }

  /* ---------- save and restore ---------- */

  /* ---------- save and restore ----------
     A sequence is segments, audio clips and the settings that change how it
     reads back. Audio is the awkward part: the decoded buffers are far too
     big to keep, so what gets stored is the original encoded bytes, once per
     source no matter how many clips were sliced out of it. Exported files
     embed those bytes as base64 and are self-contained. Browser slots put
     them in IndexedDB instead, because one take would blow the localStorage
     quota on its own.                                                       */

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }

  function fromB64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function openDb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('animlab', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('audio');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  async function dbPut(key, value) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const tx = db.transaction('audio', 'readwrite');
      tx.objectStore('audio').put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function dbDelete(key) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const tx = db.transaction('audio', 'readwrite');
      tx.objectStore('audio').delete(key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function dbGet(key) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const tx = db.transaction('audio', 'readonly');
      const q = tx.objectStore('audio').get(key);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => rej(q.error);
    });
  }

  const usedSourceIds = () => [...new Set(audioClips.map((c) => c.sourceId).filter(Boolean))];

  /* ---------- the container format ----------
     "ANIMLAB" + a version byte + a CBOR payload. CBOR carries the encoded
     audio as byte strings, where base64 in JSON would inflate it by a third
     and cost a pass of string work in each direction. The header means a
     file can be identified and version-checked before anything is parsed,
     and old JSON saves still load because the first byte tells them apart. */

  const MAGIC = 'ANIMLAB';
  const FORMAT_VERSION = 5;

  // JSON cannot hold bytes, so base64 them on the way out
  function jsonSafe(snap) {
    return {
      ...snap,
      audio: {
        ...snap.audio,
        sources: (snap.audio.sources || []).map((s) => ({
          ...s,
          data: s.data ? toB64(s.data.buffer ? s.data.buffer.slice(
            s.data.byteOffset, s.data.byteOffset + s.data.byteLength) : s.data) : null,
        })),
      },
    };
  }

  function packSequence(snap) {
    if (!cborLib) {
      return {
        bytes: new TextEncoder().encode(JSON.stringify(jsonSafe(snap), null, 2)),
        ext: 'json', mime: 'application/json', kind: 'json',
      };
    }
    const body = cborLib.encode(snap);
    const head = new TextEncoder().encode(MAGIC);
    const out = new Uint8Array(head.length + 1 + body.length);
    out.set(head, 0);
    out[head.length] = FORMAT_VERSION;
    out.set(body, head.length + 1);
    return { bytes: out, ext: 'animlab', mime: 'application/octet-stream', kind: 'cbor' };
  }

  function unpackSequence(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    // a JSON save from before this format starts with a brace or whitespace
    const first = bytes[0];
    if (first === 0x7b || first === 0x20 || first === 0x0a || first === 0x09) {
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    const magic = new TextDecoder().decode(bytes.subarray(0, MAGIC.length));
    if (magic !== MAGIC) throw new Error('not an animlab file');
    const version = bytes[MAGIC.length];
    if (version > FORMAT_VERSION) {
      throw new Error(`saved by a newer version (${version}), this build reads up to ${FORMAT_VERSION}`);
    }
    if (!cborLib) throw new Error('cbor-x is needed to read this file and could not be loaded');
    return cborLib.decode(bytes.subarray(MAGIC.length + 1));
  }

  function snapshot({ embedAudio }) {
    const used = usedSourceIds();
    return {
      version: 4,
      duration: round(total),
      range: range ? { a: range.a, b: range.b } : null,
      view: { pps: round(pps), ripple, autoAdvance, liveMove, resetOnEnd, takeNo },
      audio: {
        volume: audioGain ? round(audioGain.gain.value * 100) : 100,
        sources: used.map((id) => {
          const s = audioSources.get(id);
          return {
            id, name: s.name, mime: s.mime,
            size: s.bytes.byteLength,
            // raw bytes. the packer decides whether they travel as CBOR byte
            // strings or get base64'd into JSON
            data: embedAudio ? new Uint8Array(s.bytes) : null,
          };
        }),
        clips: audioClips.map((c) => ({
          name: c.name, sourceId: c.sourceId,
          offset: round(c.offset), inPoint: round(c.inPoint), outPoint: round(c.outPoint),
        })),
      },
      segments: segs.map((sg) => ({
        sel: sg.sel, prop: sg.prop, lane: sg.lane,
        keys: [...sg.keys].sort((a, b) => a.t - b.t).map((k) => {
          const o = { t: round(k.t), val: k.val, ease: k.ease };
          if (k.g) o.group = k.g;
          return o;
        }),
      })),
    };
  }

  async function restore(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;

    const remap = new Map();
    const list = data.segments || data.tracks || [];
    segs = list.map((t) => ({
      id: nextId++, sel: t.sel, prop: t.prop,
      lane: typeof t.lane === 'number' ? t.lane : null,
      keys: (t.keys || []).map((k) => {
        const key = { id: nextId++, t: Number(k.t) || 0, val: String(k.val), ease: k.ease || '' };
        if (k.group) {
          if (!remap.has(k.group)) remap.set(k.group, nextGid++);
          key.g = remap.get(k.group);
        }
        return key;
      }),
    }));

    range = data.range && data.range.b > data.range.a ? { a: data.range.a, b: data.range.b } : null;

    if (data.view) {
      pps = data.view.pps || pps;
      ripple = data.view.ripple !== false;
      autoAdvance = data.view.autoAdvance !== false;
      liveMove = data.view.liveMove !== false;
      resetOnEnd = data.view.resetOnEnd !== false;
      takeNo = data.view.takeNo || 0;
      $('rRipple').checked = ripple;
      $('autoAdv').checked = autoAdvance;
      $('liveMove').checked = liveMove;
      $('autoreset').checked = resetOnEnd;
    }

    stopAudio();
    audioClips = [];
    audioSources.clear();

    const a = data.audio;
    if (a && a.clips && a.clips.length) {
      const ctx = ensureCtx();
      if (a.volume != null) {
        $('audVol').value = a.volume;
        if (audioGain) audioGain.gain.value = a.volume / 100;
      }

      const decoded = new Map();
      for (const s of a.sources || []) {
        try {
          // raw bytes from CBOR, base64 from a legacy JSON file, or parked
          // in IndexedDB by a version 4 slot save
          let bytes = null;
          if (s.data instanceof Uint8Array) bytes = s.data.buffer.slice(
            s.data.byteOffset, s.data.byteOffset + s.data.byteLength);
          else if (s.data instanceof ArrayBuffer) bytes = s.data;
          else if (typeof s.data === 'string') bytes = fromB64(s.data);
          if (!bytes) {
            const stored = await dbGet(s.id);
            if (stored) bytes = stored.bytes;
          }
          if (!bytes) { console.warn('[animlab] audio source missing:', s.name); continue; }
          audioSources.set(s.id, { name: s.name, mime: s.mime, bytes });
          decoded.set(s.id, await ctx.decodeAudioData(bytes.slice(0)));
        } catch (err) {
          console.warn('[animlab] could not restore', s.name, err.message);
        }
      }

      a.clips.forEach((c) => {
        const buf = decoded.get(c.sourceId);
        if (!buf) return;
        addClip(c.name, buf, c.offset, c.sourceId, c.inPoint, c.outPoint);
      });
    }

    refreshClipList();
    clearSelection();
    selectedClip = null;
    time = 0;
    build();
    renderInspector();
  }

  const savedNames = () => {
    try { return JSON.parse(localStorage.getItem(LS_INDEX) || '[]'); } catch (_) { return []; }
  };
  const refreshSeqList = () => {
    $('seqList').innerHTML = '<option value="">saved…</option>' +
      savedNames().map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  };
  const flash = (btn, text) => {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = old; }, 1100);
  };

  $('seqList').addEventListener('change', (e) => { if (e.target.value) $('seqName').value = e.target.value; });
  // a slot is one packed blob in IndexedDB, audio and all. localStorage keeps
  // only the list of names, which is what it is actually good for.
  $('seqSave').addEventListener('click', async () => {
    const name = ($('seqName').value || '').trim();
    if (!name) { $('seqName').focus(); return; }
    try {
      const packed = packSequence(snapshot({ embedAudio: true }));
      await dbPut('seq:' + name, {
        bytes: packed.bytes, kind: packed.kind, saved: Date.now(),
        duration: round(total), clips: audioClips.length, segments: segs.length,
      });
      const names = savedNames();
      if (!names.includes(name)) { names.push(name); localStorage.setItem(LS_INDEX, JSON.stringify(names)); }
      refreshSeqList();
      $('seqList').value = name;
      flash($('seqSave'), `${(packed.bytes.length / 1048576).toFixed(1)} MB`);
    } catch (err) { console.error('[animlab] save failed:', err); flash($('seqSave'), 'failed'); }
  });

  $('seqLoad').addEventListener('click', async () => {
    const name = ($('seqName').value || '').trim();
    try {
      const rec = await dbGet('seq:' + name);
      if (rec && rec.bytes) {
        await restore(unpackSequence(rec.bytes));
        flash($('seqLoad'), 'loaded');
        return;
      }
      // anything saved before the binary format lives in localStorage
      const raw = localStorage.getItem(LS_PREFIX + name);
      if (!raw) { flash($('seqLoad'), 'not found'); return; }
      await restore(raw);
      flash($('seqLoad'), 'loaded');
    } catch (err) {
      console.error('[animlab] load failed:', err);
      flash($('seqLoad'), 'unreadable');
    }
  });
  $('seqDel').addEventListener('click', async () => {
    const name = ($('seqName').value || '').trim();
    if (!name) return;
    localStorage.removeItem(LS_PREFIX + name);
    try { await dbDelete('seq:' + name); } catch (_) {}
    localStorage.setItem(LS_INDEX, JSON.stringify(savedNames().filter((n) => n !== name)));
    refreshSeqList();
    flash($('seqDel'), 'deleted');
  });
  $('seqExport').addEventListener('click', () => {
    const name = ($('seqName').value || 'animlab').trim();
    const snap = snapshot({ embedAudio: $('seqEmbed').checked });
    let out;
    if ($('seqJson').checked) {
      const text = JSON.stringify(jsonSafe(snap), null, 2);
      out = { bytes: new TextEncoder().encode(text), ext: 'animlab.json', mime: 'application/json' };
    } else {
      const p = packSequence(snap);
      out = { bytes: p.bytes, ext: p.ext === 'json' ? 'animlab.json' : 'animlab', mime: p.mime };
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out.bytes], { type: out.mime }));
    a.download = `${name}.${out.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    console.log(`[animlab] exported ${(out.bytes.length / 1048576).toFixed(2)} MB as ${out.ext}`);
  });
  $('seqImport').addEventListener('click', () => $('fileIn').click());
  $('fileIn').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      await restore(unpackSequence(await f.arrayBuffer()));
      $('seqName').value = f.name.replace(/\.animlab(\.json)?$|\.json$/, '');
      flash($('seqImport'), 'imported');
    } catch (err) { console.error('[animlab] import failed:', err); flash($('seqImport'), 'bad file'); }
    e.target.value = '';
  });
  $('seqClear').addEventListener('click', () => {
    stop(); restoreAll(); clearAudio();
    segs = []; range = null; time = 0; takeNo = 0;
    clearSelection(); build(); renderInspector();
  });
  refreshSeqList();

  /* ---------- audio ----------
     A reference track. The waveform is drawn from precomputed peaks so it
     redraws instantly at any zoom, playback is driven off the audio element's
     own clock so it cannot drift from the animation, and the same element is
     tapped into the recorder so the render comes out with sound already in it. */

  // Peak level per clip. A voice take sits far below full scale, so drawing
  // it against an absolute ceiling gives a flat line that reads as "empty".
  // Every clip is scaled against its own loudest moment instead.
  const peakCeiling = (peaks) => {
    let m = 0;
    for (let i = 0; i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
    return Math.max(m, 0.02);
  };

  function computePeaks(buffer) {
    const ch = buffer.getChannelData(0);
    const n = Math.max(1, Math.ceil(buffer.duration * PEAKS_PER_SEC));
    const per = Math.max(1, Math.floor(ch.length / n));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const s = i * per;
      const e = Math.min(s + per, ch.length);
      for (let j = s; j < e; j++) {
        const v = ch[j] < 0 ? -ch[j] : ch[j];
        if (v > m) m = v;
      }
      out[i] = m;
    }
    return out;
  }

  function ensureCtx() {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      audioGain = actx.createGain();
      audioGain.gain.value = (parseFloat($('audVol').value) || 100) / 100;
      audioGain.connect(actx.destination);
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

  function registerSource(name, mime, bytes) {
    const id = 'src' + (nextId++);
    audioSources.set(id, { name, mime, bytes });
    return id;
  }

  const clipLen = (c) => c.outPoint - c.inPoint;
  const clipEnd = (c) => c.offset + clipLen(c);
  const audioEnd = () => audioClips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);

  function addClip(name, buffer, offset, sourceId, inPoint, outPoint) {
    const c = {
      id: nextId++, name, buffer, sourceId,
      peaks: computePeaks(buffer),
      offset: Math.max(0, round(offset)),
      inPoint: inPoint == null ? 0 : inPoint,
      outPoint: outPoint == null ? buffer.duration : outPoint,
    };
    c.ceiling = peakCeiling(c.peaks);
    audioClips.push(c);
    refreshClipList();
    build();
    return c;
  }

  async function loadAudioFile(file) {
    try {
      const bytes = await file.arrayBuffer();
      // decodeAudioData detaches what it is given, so hand it a copy and keep
      // the original encoded bytes for saving
      const decoded = await ensureCtx().decodeAudioData(bytes.slice(0));
      const name = file.name.replace(/\.[^.]+$/, '');
      addClip(name, decoded, time, registerSource(name, file.type || 'audio/*', bytes));
    } catch (err) {
      console.error('[animlab] could not decode that audio:', err);
      $('audInfo').textContent = 'could not decode that file';
    }
  }

  function refreshClipList() {
    const n = audioClips.length;
    $('audInfo').textContent = n
      ? `${n} clip${n > 1 ? 's' : ''} · ${round(audioEnd())}s of timeline covered`
      : 'no audio yet';
    $('audClear').hidden = !n;
  }

  /* ---------- audio playback ----------
     Clips are scheduled on the WebAudio clock rather than played through an
     element, which is what makes trims, gaps and overlaps work at all. That
     clock also drives the playhead, so picture cannot drift from sound.      */

  function stopAudio() {
    liveSources.forEach((s) => { try { s.stop(); } catch (_) {} });
    liveSources = [];
    audioAnchor = null;
  }

  function scheduleAudio(fromTime) {
    stopAudio();
    if (!audioClips.length) return;
    const ctx = ensureCtx();
    const t0 = ctx.currentTime + 0.06;
    audioAnchor = { ctxStart: t0, timeStart: fromTime };

    audioClips.forEach((c) => {
      const end = clipEnd(c);
      if (end <= fromTime) return;
      const startAt = Math.max(c.offset, fromTime);
      const dur = end - startAt;
      if (dur <= 0.001) return;
      const node = ctx.createBufferSource();
      node.buffer = c.buffer;
      node.connect(audioGain);
      if (audioDest) node.connect(audioDest);
      node.start(t0 + (startAt - fromTime), c.inPoint + (startAt - c.offset), dur);
      liveSources.push(node);
    });
  }

  /* ---------- destructive-looking edits, done non-destructively ----------
     Cutting a span just re-points clip in and out markers around it. The
     underlying buffers are never touched, so a cut costs nothing and two
     halves of a split clip still share one decode.                          */

  function cutAudioRange(a, b, ripple, alsoKeys) {
    if (b - a < 1e-4) return;
    const len = b - a;
    const next = [];
    audioClips.forEach((c) => {
      const s = c.offset;
      const e = clipEnd(c);
      if (e <= a + 1e-6 || s >= b - 1e-6) { next.push(c); return; }
      if (s < a) {
        next.push({ ...c, id: nextId++, outPoint: c.inPoint + (a - s) });
      }
      if (e > b) {
        next.push({ ...c, id: nextId++, offset: round(b), inPoint: c.inPoint + (b - s) });
      }
    });
    audioClips = next.filter((c) => clipLen(c) > 0.01);

    if (ripple) {
      audioClips.forEach((c) => {
        if (c.offset >= b - 1e-6) c.offset = round(Math.max(0, c.offset - len));
      });
      if (alsoKeys) {
        segs.forEach((sg) => sg.keys.forEach((k) => {
          if (k.t >= b - 1e-6) k.t = round(Math.max(0, k.t - len));
        }));
      }
    }
    refreshClipList();
    build();
    renderInspector();
  }

  // Slice at a time, keeping both halves. Like every other audio edit this is
  // just marker arithmetic: the two pieces go on sharing one decoded buffer
  // and one set of peaks, so slicing a long take costs nothing.
  function splitAudioAt(t, quiet) {
    const next = [];
    let cuts = 0;
    audioClips.forEach((c) => {
      const s = c.offset;
      const e = clipEnd(c);
      if (t <= s + 0.02 || t >= e - 0.02) { next.push(c); return; }
      cuts += 1;
      const at = c.inPoint + (t - s);
      next.push({ ...c, id: nextId++, outPoint: at });
      next.push({ ...c, id: nextId++, offset: round(t), inPoint: at });
    });
    if (!cuts) {
      if (!quiet) flash($('audSlice'), 'nothing under it');
      return 0;
    }
    audioClips = next;
    selectedClip = null;
    refreshClipList();
    build();
    return cuts;
  }

  function deleteClip(id) {
    const before = audioClips.length;
    audioClips = audioClips.filter((c) => c.id !== id);
    if (audioClips.length === before) return false;
    selectedClip = null;
    refreshClipList();
    build();
    return true;
  }

  function insertAudioGap(at, len, alsoKeys) {
    audioClips.forEach((c) => {
      if (c.offset >= at - 1e-6) c.offset = round(c.offset + len);
    });
    if (alsoKeys) {
      segs.forEach((sg) => sg.keys.forEach((k) => {
        if (k.t >= at - 1e-6) k.t = round(k.t + len);
      }));
    }
    build();
  }

  /* ---------- recording ---------- */

  async function startTake() {
    if (micRec) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      console.warn('[animlab] microphone unavailable:', err.message);
      $('audInfo').textContent = 'no microphone access';
      return;
    }
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    micRec = { rec, stream, chunks, at: time, startedWall: performance.now() };
    $('audRec').textContent = 'stop the take';
    $('audRec').classList.add('on');
    rec.start();
    if ($('audPlayWhileRec').checked) play();
    renderTracks();
  }

  async function stopTake() {
    if (!micRec) return;
    const { rec, stream, chunks, at } = micRec;
    const blob = await new Promise((res) => {
      rec.onstop = () => res(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      if (rec.state !== 'inactive') rec.stop();
      else res(new Blob(chunks, { type: 'audio/webm' }));
    });
    stream.getTracks().forEach((t) => t.stop());
    const endedAt = time;
    micRec = null;
    $('audRec').textContent = 'record from the playhead';
    $('audRec').classList.remove('on');
    stop();
    time = endedAt;   // stay where the take finished, ready for the next one

    if (!blob.size) { renderTracks(); return; }
    try {
      takeNo += 1;
      const bytes = await blob.arrayBuffer();
      const decoded = await ensureCtx().decodeAudioData(bytes.slice(0));
      const name = `take ${takeNo}`;
      addClip(name, decoded, at, registerSource(name, blob.type || 'audio/webm', bytes));
      seek(endedAt);
    } catch (err) {
      console.error('[animlab] could not decode the take:', err);
    }
  }

  function clearAudio() {
    stopAudio();
    audioClips = [];
    audioSources.clear();
    refreshClipList();
    build();
  }

  function drawWaves(canvas, w) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.round(AUDIO_H * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = AUDIO_H + 'px';
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, AUDIO_H);

    const mid = AUDIO_H / 2;
    const step = Math.max(1, Math.floor(PEAKS_PER_SEC / pps));

    audioClips.forEach((c) => {
      const x0 = c.offset * pps;
      const x1 = clipEnd(c) * pps;
      g.fillStyle = '#3f7f96';
      const ceil = c.ceiling || peakCeiling(c.peaks);
      for (let px = Math.max(0, Math.floor(x0)); px < Math.min(w, x1); px++) {
        // map the pixel back into the source buffer, honouring the trim
        const tIn = c.inPoint + (px - x0) / pps;
        const idx = Math.floor(tIn * PEAKS_PER_SEC);
        let a = 0;
        for (let k = idx; k < idx + step && k < c.peaks.length; k++) {
          if (c.peaks[k] > a) a = c.peaks[k];
        }
        const h = Math.min(a / ceil, 1) * (mid - 4);
        g.fillRect(px, mid - h, 1, Math.max(h * 2, 1));
      }
      g.strokeStyle = 'rgba(63,127,150,.35)';
      g.beginPath();
      g.moveTo(Math.max(0, x0), mid);
      g.lineTo(Math.min(w, x1), mid);
      g.stroke();
    });
  }

  /* ---------- moving and trimming clips ---------- */

  function slideClip(e, c, el, cv, w) {
    const x0 = e.clientX;
    const o0 = c.offset;
    const others = audioClips.filter((x) => x !== c);
    const targets = [
      0, time,
      ...(range ? [range.a, range.b] : []),
      ...others.flatMap((x) => [x.offset, clipEnd(x)]),
      ...segs.flatMap((sg) => sg.keys.map((k) => k.t)),
    ];
    const guide = $('snapline');
    document.body.style.cursor = 'grabbing';

    const move = (ev) => {
      if (ev.buttons === 0) { up(); return; }
      let t = snapT(Math.max(0, o0 + (ev.clientX - x0) / pps), ev.altKey);
      let hit = null;
      if (!ev.altKey) {
        const tol = 7 / pps;
        [t, t + clipLen(c)].forEach((edge) => targets.forEach((cand) => {
          const d = cand - edge;
          if (Math.abs(d) <= tol && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, at: cand };
        }));
        if (hit && t + hit.d >= 0) t += hit.d;
      }
      c.offset = t;
      el.style.left = c.offset * pps + 'px';
      drawWaves(cv, w);
      guide.style.display = hit ? 'block' : 'none';
      if (hit) guide.style.left = GUTTER + hit.at * pps + 'px';
      $('time').textContent = `clip at ${round(c.offset)}s`;
    };
    let closed = false;
    const up = () => {
      if (closed) return;
      closed = true;
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      window.removeEventListener('blur', up);
      guide.style.display = 'none';
      document.body.style.cursor = '';
      c.offset = round(c.offset);
      build();
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    window.addEventListener('blur', up, { once: true });
  }

  // trimming moves the in or out marker. the buffer is never touched, so a
  // trim is reversible and costs nothing
  function addClipHandles(parent, c, cv, w) {
    ['l', 'r'].forEach((edge) => {
      const h = document.createElement('div');
      h.className = `sbh ${edge}`;
      h.title = edge === 'l' ? 'trim the start' : 'trim the end';
      h.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        takeTimelineFocus();
        selectedClip = c.id;
        const x0 = e.clientX;
        const inP = c.inPoint;
        const outP = c.outPoint;
        const off = c.offset;

        const move = (ev) => {
          if (ev.buttons === 0) { up(); return; }
          const d = (ev.clientX - x0) / pps;
          if (edge === 'l') {
            const delta = Math.max(-inP, Math.min(d, outP - inP - 0.05));
            c.inPoint = inP + delta;
            c.offset = Math.max(0, off + delta);
          } else {
            c.outPoint = Math.max(c.inPoint + 0.05, Math.min(outP + d, c.buffer.duration));
          }
          parent.style.left = c.offset * pps + 'px';
          parent.style.width = Math.max(clipLen(c) * pps, 6) + 'px';
          drawWaves(cv, w);
          $('time').textContent = `clip ${round(clipLen(c))}s`;
        };
        let closed = false;
        const up = () => {
          if (closed) return;
          closed = true;
          window.removeEventListener('mousemove', move, true);
          window.removeEventListener('mouseup', up, true);
          window.removeEventListener('blur', up);
          c.offset = round(c.offset);
          build();
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
        window.addEventListener('blur', up, { once: true });
      });
      parent.appendChild(h);
    });
  }

  /* ---------- render to video ----------
     There is no way to rasterise an arbitrary live page deterministically from
     inside it, so this records in real time off a MediaStream. Two sources: a
     canvas captured directly, which is exact and never shows our own UI, or a
     screen share, which catches the whole composited page including DOM.     */

  const RENDER_MIMES = [
    ['video/webm;codecs=vp9', 'webm · vp9'],
    ['video/webm;codecs=vp8', 'webm · vp8'],
    ['video/mp4;codecs=avc1.42E01E', 'mp4 · h264'],
    ['video/webm', 'webm'],
  ];
  let rendering = null;

  (function fillFormats() {
    const ok = RENDER_MIMES.filter(([m]) =>
      window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    $('rvFormat').innerHTML = ok.length
      ? ok.map(([m, label], i) =>
          `<option value="${m}"${i === 0 ? ' selected' : ''}>${label}</option>`).join('')
      : '<option value="">no recorder support</option>';
    if (!ok.length) $('rvGo').disabled = true;
  })();

  function canvasFor(sel) {
    const el = resolve(sel);
    if (!el) return null;
    if (el.tagName === 'CANVAS') return el;
    return el.querySelector ? el.querySelector('canvas') : null;
  }

  async function getStream(kind, fps) {
    if (kind !== 'screen') {
      const c = canvasFor(selectedEl || 'body') || document.querySelector('canvas');
      if (c && c.captureStream) return { stream: c.captureStream(fps), kind: 'canvas', el: c };
      if (kind === 'canvas') throw new Error('no canvas found under the selected target');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: fps },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
    });
    return { stream, kind: 'screen' };
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function renderVideo() {
    if (rendering) return;
    if (total <= 0.01) { flash($('rvGo'), 'nothing to render'); return; }

    const fps = parseInt($('rvFps').value, 10) || 30;
    const mime = $('rvFormat').value;
    const lead = Math.max(0, parseFloat($('rvLead').value) || 0);
    const tail = Math.max(0, parseFloat($('rvTail').value) || 0);

    let src;
    try {
      src = await getStream($('rvSource').value, fps);
    } catch (err) {
      console.warn('[animlab] capture cancelled or unavailable:', err.message);
      flash($('rvGo'), 'no source');
      return;
    }

    // tap the mix into the recorded stream so the file lands with sound in it
    if (audioClips.length) {
      try {
        const ctx = ensureCtx();
        if (!audioDest) audioDest = ctx.createMediaStreamDestination();
        const track = audioDest.stream.getAudioTracks()[0];
        if (track) src.stream.addTrack(track);
      } catch (err) {
        console.warn('[animlab] recording without audio:', err.message);
      }
    }

    const chunks = [];
    let rec;
    try {
      rec = new MediaRecorder(src.stream, {
        mimeType: mime || undefined,
        videoBitsPerSecond: 12_000_000,
      });
    } catch (err) {
      console.error('[animlab] recorder refused those settings:', err);
      src.stream.getTracks().forEach((t) => t.stop());
      flash($('rvGo'), 'bad format');
      return;
    }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const wasHidden = hidden;
    // a screen or whole-desktop share sees the panel wherever it lives, popped
    // out included, so hide it for every screen take
    const hideForTake = src.kind === 'screen' && $('rvHidePanel').checked;
    let aborted = false;

    const onEsc = (e) => {
      if (e.key === 'Escape') { aborted = true; e.preventDefault(); e.stopPropagation(); }
    };

    rendering = { rec, src };
    closePop();
    $('rvStop').hidden = false;
    $('rvGo').disabled = true;
    document.addEventListener('keydown', onEsc, true);
    if (hideForTake) {
      setHidden(true);
      if (popup && !popup.closed) popup.blur();
      window.focus();
    }

    // resolve any element-relative targets against the layout as it is now
    build();

    // let the compositor settle after the share prompt and the panel hiding,
    // otherwise the first frames still contain it
    stop();
    seek(0);
    await wait(450);

    const fired = new Set();
    stopAudio();
    rec.start();
    await wait(lead * 1000);

    // one schedule for the whole take, from the top
    scheduleAudio(0);
    const started = performance.now();
    await new Promise((done) => {
      const step = (now) => {
        if (aborted || rendering === null) return done();
        const t = Math.min((now - started) / 1000, total);
        seek(t);
        markers.forEach((m, i) => {
          if (m.t <= t && !fired.has(i)) { fired.add(i); fireMarker(m); }
        });
        if (t >= total) return done();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    await wait(tail * 1000);

    const blob = await new Promise((res) => {
      rec.onstop = () => res(new Blob(chunks, { type: mime || 'video/webm' }));
      if (rec.state !== 'inactive') rec.stop();
      else res(new Blob(chunks, { type: mime || 'video/webm' }));
    });

    stopAudio();
    src.stream.getTracks().forEach((t) => t.stop());
    document.removeEventListener('keydown', onEsc, true);
    rendering = null;
    $('rvStop').hidden = true;
    $('rvGo').disabled = false;
    if (hideForTake && !wasHidden) setHidden(false);
    seek(0);

    if (aborted || !blob.size) {
      console.warn('[animlab] render aborted');
      return;
    }
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const name = ($('seqName').value || 'animlab').trim();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    console.log(`[animlab] rendered ${round(total)}s, ${(blob.size / 1048576).toFixed(1)} MB, ${src.kind} capture`);
  }

  function describeSource() {
    const kind = $('rvSource').value;
    const c = canvasFor(selectedEl || 'body') || document.querySelector('canvas');
    if (kind === 'screen') {
      $('rvHint').textContent =
        'you will be asked which surface to share. the panel hides itself for the take. esc aborts.';
    } else if (c) {
      $('rvHint').textContent =
        `captures <canvas> ${c.width}×${c.height} directly. exact pixels, no share prompt, ` +
        'and the panel never appears in frame. dom outside the canvas will not be recorded.';
    } else {
      $('rvHint').textContent = kind === 'canvas'
        ? 'no canvas under the selected target. pick one, or switch to screen capture.'
        : 'no canvas found, so this will fall back to screen capture.';
    }
  }
  $('rvSource').addEventListener('change', describeSource);
  describeSource();

  $('audPick').addEventListener('click', () => $('audIn').click());
  $('audIn').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) await loadAudioFile(f);
    e.target.value = '';
  });
  $('audRec').addEventListener('click', () => (micRec ? stopTake() : startTake()));
  $('audClear').addEventListener('click', clearAudio);
  $('audVol').addEventListener('change', () => {
    const v = Math.max(0, Math.min(2, (parseFloat($('audVol').value) || 100) / 100));
    if (audioGain) audioGain.gain.value = v;
  });
  $('audSlice').addEventListener('click', () => { splitAudioAt(time); });
  $('audSliceRange').addEventListener('click', () => {
    if (!range) { flash($('audSliceRange'), 'set a range'); return; }
    // slice the later edge first, or splitting the earlier one renumbers
    // the clip the second cut is aiming at
    const n = splitAudioAt(range.b, true) + splitAudioAt(range.a, true);
    if (!n) flash($('audSliceRange'), 'nothing under it');
  });
  $('audDelClip').addEventListener('click', () => {
    if (!selectedClip || !deleteClip(selectedClip)) flash($('audDelClip'), 'select a clip');
  });

  $('audCut').addEventListener('click', () => {
    if (!range) { flash($('audCut'), 'set a range'); return; }
    cutAudioRange(range.a, range.b, true, $('audRipKeys').checked);
  });
  $('audLift').addEventListener('click', () => {
    if (!range) { flash($('audLift'), 'set a range'); return; }
    cutAudioRange(range.a, range.b, false, false);
  });
  $('audGap').addEventListener('click', () => {
    if (!range) { flash($('audGap'), 'set a range'); return; }
    insertAudioGap(range.a, range.b - range.a, $('audRipKeys').checked);
  });

  // dropping a clip anywhere on the timeline loads it at the playhead
  ['dragover', 'drop'].forEach((n) => $('tl').addEventListener(n, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (n !== 'drop') return;
    const f = [...(e.dataTransfer.files || [])].find((x) => x.type.startsWith('audio/'));
    if (f) loadAudioFile(f);
  }));

  $('rvGo').addEventListener('click', renderVideo);
  $('rvStop').addEventListener('click', () => {
    if (rendering) { rendering = null; }
  });

  /* ---------- export ---------- */

  function exportCode() {
    if (!segs.length) return '';
    const lines = [`import { animate } from "motion";`, ``, `const total = ${round(total)};`, ``];
    const byTarget = new Map();
    segs.filter((sg) => !isEventSeg(sg)).forEach((sg) => {
      const id = sg.sel + '\u0000' + sg.prop;
      const b = byTarget.get(id) || { sel: sg.sel, prop: sg.prop, keys: [] };
      b.keys.push(...sg.keys);
      byTarget.set(id, b);
    });
    byTarget.forEach(({ sel, prop, keys }) => {
      const t = sel === '@cursor' ? 'cursor' : sel === '@page' ? 'document.body' : JSON.stringify(sel);
      const sorted = [...keys].sort((a, b) => a.t - b.t);
      const vals = sorted.map((k) => {
        const v = coerce(k.val);
        return typeof v === 'number' ? v : JSON.stringify(v);
      });
      lines.push(
        `animate(${t}, { ${prop}: [${vals.join(', ')}] }, {\n` +
        `  duration: total,\n  times: [${sorted.map((k) => round(k.t / total)).join(', ')}],\n` +
        `  ease: [${sorted.slice(1).map((k) => JSON.stringify(parseEase(k.ease))).join(', ')}],\n});`
      );
    });
    if (markers.length) {
      lines.push('', 'const events = [');
      markers.forEach((m) => lines.push(
        `  { t: ${round(m.t)}, type: ${JSON.stringify(m.type)}, target: ${JSON.stringify(m.sel)}` +
        (m.detail ? `, detail: ${JSON.stringify(m.detail)}` : '') + ' },'));
      lines.push('];');
    }
    if (segs.some((s) => s.sel === '@page')) lines.push('', '// document.body needs transform-origin: 0 0');
    return lines.join('\n');
  }

  /* ---------- keyboard ---------- */

  // judge by where the keystroke actually came from, not by activeElement,
  // which reports the shadow host and is easy to misread
  function inAField(e) {
    const t = e.composedPath()[0];
    return !!t && t.nodeType === 1 &&
      (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  }

  function setHidden(v) {
    hidden = v;
    host.style.display = v ? 'none' : 'block';
    hi.style.display = 'none';
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const field = inAField(e);
    if (e.key === 'Escape') {
      if (picking) { e.preventDefault(); stopPick(); return; }
      if (field) { e.target.blur && e.target.blur(); return; }
      if (openPop) { e.preventDefault(); closePop(); return; }
      if (selection.size) {
        e.preventDefault(); clearSelection(); renderTracks(); renderInspector(); return;
      }
    }
    // a focused field owns every key. nothing below this line runs while typing
    if (field) return;
    if (e.code === 'Space' && playing) { e.preventDefault(); stop(); return; }
    if (e.key === 'h' || e.key === 'H') { e.preventDefault(); setHidden(!hidden); }
    else if (e.code === 'Space') { e.preventDefault(); play(); }
    else if (e.key === 'g' || e.key === 'G') {
      if (!selection.size) return;
      e.preventDefault();
      const picked = selected();
      if (e.shiftKey) picked.forEach(({ k }) => { delete k.g; });
      else { const gid = nextGid++; picked.forEach(({ k }) => { k.g = gid; }); }
      renderTracks(); renderInspector();
    } else if (e.key === 'r' || e.key === 'R') {
      const ts = selected().map((p) => p.k.t);
      if (!ts.length) return;
      e.preventDefault();
      setRange(Math.min(...ts), Math.max(...ts));
    } else if (e.key === 's' || e.key === 'S') {
      if (!audioClips.length) return;
      e.preventDefault();
      splitAudioAt(time);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selection.size) { e.preventDefault(); deleteSelected(); return; }
      if (selectedClip) { e.preventDefault(); deleteClip(selectedClip); }
    }
  }

  // keys and wheel have to be bound per document so the popped-out window works
  function bindDoc(doc) {
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('wheel', onWheel, { capture: true, passive: false });
  }
  function unbindDoc(doc) {
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('wheel', onWheel, { capture: true });
  }
  bindDoc(document);

  /* ---------- wiring ---------- */

  $('play').addEventListener('click', () => (playing ? stop() : play()));
  $('reset').addEventListener('click', () => { stop(); seek(0); });
  $('autoreset').addEventListener('change', (e) => (resetOnEnd = e.target.checked));
  $('autoAdv').addEventListener('change', (e) => (autoAdvance = e.target.checked));
  $('ruler').addEventListener('mousedown', (e) => {
    stop();
    const go = (ev) => {
      const r = $('ruler').getBoundingClientRect();
      seek((ev.clientX - r.left) / pps);
    };
    go(e);
    const up = () => {
      window.removeEventListener('mousemove', go, true);
      window.removeEventListener('mouseup', up, true);
    };
    window.addEventListener('mousemove', go, true);
    window.addEventListener('mouseup', up, true);
  });
  $('zi').addEventListener('click', () => { pps = Math.min(400, pps * 1.4); renderTracks(); renderRange(); seek(time); });
  $('zo').addEventListener('click', () => { pps = Math.max(30, pps / 1.4); renderTracks(); renderRange(); seek(time); });
  $('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('output').value);
    flash($('copy'), 'copied');
  });
  $('close').addEventListener('click', () => window.__animLab.destroy());
  /* ---------- layout: dock, float, pop out ---------- */

  function applyMode() {
    host.classList.remove('float', 'top', 'bottom');
    host.classList.add(mode);
    if (popup) {
      host.style.cssText = 'position:absolute;inset:0;pointer-events:auto;';
      return;
    }
    const base = 'position:fixed;z-index:2147483646;pointer-events:none;';
    if (mode === 'bottom') {
      host.style.cssText = base + `left:0;right:0;bottom:0;top:auto;height:${dockH}px;`;
    } else if (mode === 'top') {
      host.style.cssText = base + `left:0;right:0;top:0;bottom:auto;height:${dockH}px;`;
    } else {
      const w = Math.min(floatBox.w, window.innerWidth - 20);
      const h = Math.min(floatBox.h, window.innerHeight - 20);
      const x = Math.max(0, Math.min(floatBox.x, window.innerWidth - w));
      const y = Math.max(0, Math.min(floatBox.y, window.innerHeight - h));
      host.style.cssText = base + `left:${x}px;top:${y}px;right:auto;bottom:auto;width:${w}px;height:${h}px;`;
    }
    try { localStorage.setItem('animlab:layout', JSON.stringify({ mode, dockH, floatBox })); } catch (_) {}
  }

  try {
    const saved = JSON.parse(localStorage.getItem('animlab:layout') || 'null');
    if (saved) {
      mode = saved.mode === 'top' || saved.mode === 'float' ? saved.mode : 'bottom';
      dockH = saved.dockH || dockH;
      floatBox = saved.floatBox || floatBox;
    }
  } catch (_) {}

  $('dockBottom').addEventListener('click', () => { mode = 'bottom'; applyMode(); closePop(); });
  $('dockTop').addEventListener('click', () => { mode = 'top'; applyMode(); closePop(); });
  $('dockFloat').addEventListener('click', () => { mode = 'float'; applyMode(); closePop(); });

  function popOut() {
    if (popup && !popup.closed) { popup.focus(); return; }
    const w = window.open('', 'animlab_' + Date.now(),
      `popup=yes,width=${Math.round(floatBox.w)},height=${Math.round(floatBox.h + 40)}`);
    if (!w) {
      console.warn('[animlab] the popup was blocked. Allow popups for this site, or use float.');
      mode = 'float';
      applyMode();
      return;
    }
    popup = w;
    w.document.title = 'animlab';
    w.document.head.innerHTML = '<meta charset="utf-8">';
    w.document.body.style.cssText = 'margin:0;background:#101418;overflow:hidden';
    try {
      w.document.body.appendChild(host);   // implicit adoption, shadow root included
    } catch (err) {
      console.warn('[animlab] could not move the panel into the window:', err);
      popup = null;
      w.close();
      mode = 'float';
      applyMode();
      return;
    }
    applyMode();
    bindDoc(w.document);
    w.addEventListener('beforeunload', () => { popup = null; popIn(); });
    w.focus();
  }

  function popIn() {
    if (popup) {
      try { unbindDoc(popup.document); } catch (_) {}
      const p = popup;
      popup = null;
      document.documentElement.appendChild(host);
      if (!p.closed) p.close();
    }
    applyMode();
    renderTracks();
    renderRange();
    seek(time);
  }

  $('guardChk').addEventListener('change', (e) => {
    guardFocus = e.target.checked;
    if (!guardFocus) ownField = null;
  });

  $('dockPopOut').addEventListener('click', () => { closePop(); popOut(); });
  $('dockPopIn').addEventListener('click', () => { closePop(); popIn(); });

  // drag the toolbar to move a floating panel
  $('bar').addEventListener('mousedown', (e) => {
    if (mode !== 'float' || popup) return;
    const t = e.composedPath()[0];
    if (t !== $('bar') && !t.classList.contains('name') && !t.classList.contains('spacer')) return;
    e.preventDefault();
    $('bar').classList.add('moving');
    const r = host.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev) => {
      floatBox.x = ev.clientX - dx;
      floatBox.y = ev.clientY - dy;
      host.style.left = floatBox.x + 'px';
      host.style.top = floatBox.y + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      $('bar').classList.remove('moving');
      applyMode();
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  });

  $('fresize').addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = host.getBoundingClientRect();
    const move = (ev) => {
      floatBox.w = Math.max(520, ev.clientX - r.left);
      floatBox.h = Math.max(200, ev.clientY - r.top);
      host.style.width = floatBox.w + 'px';
      host.style.height = floatBox.h + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      applyMode();
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  });

  // the grip resizes a docked panel, growing in whichever direction it is pinned
  $('grip').addEventListener('mousedown', (e) => {
    if (mode === 'float' || popup) return;
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = host.getBoundingClientRect().height;
    const move = (ev) => {
      const delta = mode === 'top' ? ev.clientY - y0 : y0 - ev.clientY;
      dockH = Math.max(200, Math.min(window.innerHeight * 0.85, h0 + delta));
      host.style.height = dockH + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      applyMode();
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!popup) applyMode();
    // element references resolve against layout, so refresh them once it settles
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (segs.some((sg) => sg.keys.some((k) => isDynamic(k.val)))) build();
    }, 200);
  });

  applyMode();
  renderTracks();
  renderRange();
  renderInspector();

  window.__animLab = {
    toggle() { setHidden(!hidden); },
    get segments() { return segs; },
    get selection() { return selected(); },
    get events() { return markers; },
    get range() { return range; },
    presets: Object.keys(PRESETS),
    eventTypes: Object.keys(EVENTS),
    cursor,
    fire: fireMarker,
    seek, play, pause: stop, setRange, typeOut,
    render: renderVideo,
    get audioClips() {
      return audioClips.map((c) => ({
        name: c.name, offset: c.offset, length: round(clipLen(c)),
        inPoint: round(c.inPoint), outPoint: round(c.outPoint),
      }));
    },

    // run __animLab.diagnoseFocus() and paste the table if fields still fight back
    async diagnoseFocus() {
      // open the popover first: a field inside a display:none subtree can
      // never take focus, and testing one tells you nothing
      const wasOpen = openPop;
      if (openPop !== 'popAnimate') {
        togglePop('popAnimate', root.querySelector('[data-pop="popAnimate"]'));
      }
      await new Promise((r2) => setTimeout(r2, 30));

      const f = root.getElementById('toVal');
      const r = {};
      r.fieldVisible = !!(f.offsetWidth || f.offsetHeight);
      r.dockPointerEvents = getComputedStyle(root.getElementById('dock')).pointerEvents;
      r.panelEngaged = panelEngaged;
      r.guardFocus = guardFocus;
      r.inertOnHost = host.hasAttribute('inert');
      r.inertOnHtml = document.documentElement.hasAttribute('inert');
      r.hostPointerEvents = getComputedStyle(host).pointerEvents;
      r.bodyPointerEvents = getComputedStyle(document.body).pointerEvents;
      r.hostInDocument = host.isConnected;
      r.poppedOut = !!popup;

      const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
      f.dispatchEvent(md);
      r.mousedownDefaultPrevented = md.defaultPrevented;

      const pd = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true });
      f.dispatchEvent(pd);
      r.pointerdownDefaultPrevented = pd.defaultPrevented;

      f.focus();
      r.focusTookImmediately = root.activeElement === f;
      r.documentActiveIsHost = document.activeElement === host;

      // does typing actually reach it?
      f.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }));
      r.canType = root.activeElement === f;

      return new Promise((res) => setTimeout(() => {
        r.stillFocusedAfter150ms = root.activeElement === f;
        r.stolenBy = r.stillFocusedAfter150ms ? null :
          ((document.activeElement && document.activeElement.tagName) || 'unknown') +
          (document.activeElement && document.activeElement.className
            ? '.' + String(document.activeElement.className).split(' ')[0] : '');
        console.table(r);
        if (!wasOpen) closePop();
        res(r);
      }, 150));
    },
    loadAudioFile, cutAudioRange, insertAudioGap, splitAudioAt, deleteClip,
    startTake, stopTake, clearAudio,
    fitRange(a, b, length) { setRange(a, b); scaleRange(a, a + length); },
    // save() gives packed bytes ready to write; saveObject() the raw snapshot
    save(opts) {
      return packSequence(snapshot({ embedAudio: (opts && opts.embedAudio) !== false }));
    },
    saveObject: (opts) => snapshot({ embedAudio: (opts && opts.embedAudio) !== false }),
    load(input) {
      const data = (input instanceof ArrayBuffer || input instanceof Uint8Array)
        ? unpackSequence(input)
        : input;
      return restore(data);
    },
    formatVersion: FORMAT_VERSION,
    get mode() { return popup ? 'popped-out' : mode; },
    dock(next) { mode = next === 'top' || next === 'float' ? next : 'bottom'; applyMode(); },
    popOut, popIn,
    destroy() {
      stopPick(); stop(); restoreAll();
      restoreFocusPatch();
      if (micRec) { try { micRec.rec.stop(); } catch (_) {} micRec.stream.getTracks().forEach((t) => t.stop()); }
      stopAudio();
      if (actx) { try { actx.close(); } catch (_) {} }
      if (rendering) {
        try { rendering.rec.stop(); } catch (_) {}
        rendering.src.stream.getTracks().forEach((t) => t.stop());
        rendering = null;
      }
      unbindDoc(document);
      if (popup && !popup.closed) { try { unbindDoc(popup.document); } catch (_) {} popup.close(); }
      popup = null;
      cursor.remove(); hi.remove(); cross.remove(); host.remove();
      delete window.__animLab;
    },
  };

  window.addEventListener('beforeunload', () => { if (popup && !popup.closed) popup.close(); });

  console.log('[animlab] ready. h hide · space play · g group · r range.');
})();
