// The world: one screen, one lever, three things to write.
//
// Nothing on this page is drawn by hand. The cities are the ends of the routes
// in TRIPLEG, placed on a ring by angle; the roads are the route rows; the
// trucks are TRIP rows sitting somewhere along their own route; the numbers on
// the right are DRIVER rows. Change the data and the picture changes. If the
// database is the DOM, this file is only the projection.

(function () {
  const RATES = [
    { v: 0, label: '❚❚' },
    { v: 0.25, label: '¼×' },
    { v: 0.5, label: '½×' },
    { v: 1, label: '1×' },
    { v: 4, label: '4×' },
    { v: 16, label: '16×' },
    { v: 64, label: '64×' },
  ];

  const SKELETONS = {
    hire: {
      name: 'the hire procedure',
      hint: 'A hire writes one TRKEMPLOYEE row, then one DRIVER or one MECHANIC row. Refuse what the depot would never allow: an unknown role, a licence the other kind already holds, a mechanic with no experience.',
      sql: `-- 1. hire someone
CREATE OR REPLACE PROCEDURE add_employee(
    p_enum NUMERIC, p_name VARCHAR, p_dob DATE, p_address VARCHAR,
    p_hiredate DATE, p_lnum NUMERIC, p_status VARCHAR,
    p_experience VARCHAR DEFAULT NULL, p_role VARCHAR DEFAULT 'DRIVER')
LANGUAGE plpgsql
AS $$
BEGIN
    -- refuse a role that is neither DRIVER nor MECHANIC

    -- refuse a licence already held by the other kind
    -- (DRIVER and MECHANIC share LNUM; nobody may be both)

    -- refuse a MECHANIC with no experience, a DRIVER with one

    INSERT INTO trkemployee (enum, name, dob, address, hiredate)
    VALUES (p_enum, p_name, p_dob, p_address, p_hiredate);

    -- then the matching row:
    --   DRIVER(enum, lnum, status) or MECHANIC(enum, lnum, status, experience)

END;
$$;
`,
    },
    counter: {
      name: 'the trip counter',
      hint: 'DRIVER.totalTripMade is a stored count of TRIP rows. A trigger keeps it honest. Cover insert, delete, and update — a trip can move between drivers. Rows that already exist never fire a trigger, so backfill them once.',
      sql: `-- 2. keep the counter honest
CREATE OR REPLACE FUNCTION trg_total_trip_made() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- which driver's counter moved?
    --   INSERT, UPDATE: NEW.lnum     DELETE: OLD.lnum
    -- an UPDATE that changes lnum moves the count between two drivers

    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER trip_total_trip_made
    AFTER INSERT OR UPDATE OR DELETE ON trip
    FOR EACH ROW
    EXECUTE FUNCTION trg_total_trip_made();
`,
    },
    longest: {
      name: 'the longest trip',
      hint: 'A function answers a question without changing anything: the most legs on any one trip of a driver. A driver with no trips answers 0, not null.',
      sql: `-- 3. the longest trip
CREATE OR REPLACE FUNCTION longtrip(p_lnum NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_max NUMERIC;
BEGIN
    -- count the legs of each trip for this driver, take the largest
    -- a trip with no legs counts 0, a driver with no trips answers 0

    RETURN coalesce(v_max, 0);
END;
$$;
`,
    },
  };

  // Tables the picture is made of, and what one row means. Shown in the panel
  // so nobody has to guess what a number is.
  const LEGEND = [
    { table: 'driver', what: 'one row per driver, its trip counter' },
    { table: 'trip', what: 'one row per trip; the depot adds and cancels these' },
    { table: 'truck', what: 'one row per vehicle on the road' },
  ];

  const pad = (n) => String(n).padStart(2, '0');

  function sessionId() {
    let id = sessionStorage.getItem('trk.world');
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      sessionStorage.setItem('trk.world', id);
    }
    return id;
  }

  // Three depot hours per tick. Tick 0 is day 1, 06:00.
  function clockOf(tick) {
    const hours = 6 + tick * 3;
    return { day: 1 + Math.floor(hours / 24), hour: `${pad(hours % 24)}:00` };
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function worldHTML() {
    return `
      <div class="world">
        <header class="world-bar">
          <div class="brand-inline">
            <span class="mark">T</span>
            <span class="brand-name">TRUCK</span>
            <span class="brand-sub">live depot</span>
          </div>
          <div class="clock"><span id="w-day">Day 1</span><span id="w-hour" class="mono">06:00</span></div>
          <div class="speed" id="w-speed">
            ${RATES.map((r) => `<button data-rate="${r.v}" class="${r.v === 0 ? 'on' : ''}">${r.label}</button>`).join('')}
          </div>
          <div class="headline" id="w-headline"></div>
          <button class="btn quiet tiny" id="w-console">console</button>
          <button class="btn quiet tiny" id="w-reset">new world</button>
        </header>

        <section class="map" id="w-map">
          <div class="zoom" id="w-zoom">
            <svg class="roads" id="w-roads" preserveAspectRatio="none"></svg>
            <div class="map-stage" id="w-stage"></div>
          </div>
          <div class="zoom-controls">
            <button data-zoom="in" title="zoom in">+</button>
            <button data-zoom="out" title="zoom out">−</button>
            <button data-zoom="reset" title="fit">fit</button>
          </div>
          <div class="map-key" id="w-key"></div>
        </section>

        <aside class="side">
          <div class="damage" id="w-damage">
            <span class="num">0</span>
            <span class="cap">DRIVER rows out of step</span>
          </div>
          <p class="hint" id="w-hint"></p>

          <div class="panel-head slim"><span>drivers</span><span id="w-dcount"></span></div>
          <div class="dhead"><span>driver</span><span>trips</span><span>counter</span><span>off by</span></div>
          <div class="dtable" id="w-drivers"></div>

          <div class="panel-head slim"><span>what you are looking at</span></div>
          <div class="legend" id="w-legend">
            ${LEGEND.map(
              (l) => `<div class="legend-row"><code>${l.table}</code><span id="w-n-${l.table}">—</span><em>${l.what}</em></div>`,
            ).join('')}
            <div class="legend-note">Every tick is one statement against a clone of the seed: an insert, a cancel, a move between drivers, or a hire.</div>
          </div>
        </aside>

        <section class="ticker" id="w-ticker">
          <div class="ticker-head"><span>what just happened</span><span class="mono" id="w-count"></span></div>
          <div class="ticker-list" id="w-list"></div>
        </section>

        <section class="desk" id="w-desk">
          <div class="desk-head">
            <span class="desk-title">change the physics</span>
            <div class="desk-tabs">
              ${Object.entries(SKELETONS)
                .map(([k, s]) => `<button class="tab" data-load="${k}">${s.name}</button>`)
                .join('')}
            </div>
            <span class="spacer"></span>
            <span class="mono" id="w-desk-note"></span>
            <button class="btn primary" id="w-apply">Apply to the world</button>
          </div>
          <div class="desk-body">
            <div class="desk-hint" id="w-desk-hint"></div>
            <div class="desk-editor" id="w-editor"></div>
          </div>
        </section>
      </div>`;
  }

  // ------------------------------------------------------------------- paint

  let state = { snap: null, rate: 0, timer: null, busy: false, session: null, editor: null, unkey: null };
  // Zoom is a transform on one layer, so nothing else has to know about it.
  const view = { z: 1, x: 0, y: 0 };
  const ZMIN = 1;
  const ZMAX = 5;

  function applyZoom() {
    const el = document.getElementById('w-zoom');
    if (el) el.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  }

  function panBounds() {
    const box = document.getElementById('w-map').getBoundingClientRect();
    // Keep at least the middle of the map on screen, whatever the zoom.
    const mx = box.width * (view.z - 1) / 2 + 40;
    const my = box.height * (view.z - 1) / 2 + 40;
    view.x = Math.max(-mx, Math.min(mx, view.x));
    view.y = Math.max(-my, Math.min(my, view.y));
  }

  function zoomTo(next, cx, cy) {
    const z2 = Math.max(ZMIN, Math.min(ZMAX, next));
    if (z2 === view.z) return;
    view.x = cx - ((cx - view.x) * z2) / view.z;
    view.y = cy - ((cy - view.y) * z2) / view.z;
    view.z = z2;
    if (z2 === 1) {
      view.x = 0;
      view.y = 0;
    }
    panBounds();
    applyZoom();
  }
  let truckEls = new Map();
  let lastGraphKey = '';

  function tickMs() {
    if (state.rate === 0) return 1000;
    if (state.rate <= 1) return 1000 / state.rate;
    return 250;
  }

  function batch() {
    return state.rate <= 4 ? 1 : Math.round(state.rate / 4);
  }

  // Where the ring puts a city, in the pane's own pixels. This is the only
  // geometry in the file, and it is three lines of trigonometry.
  function projector() {
    const box = document.getElementById('w-map').getBoundingClientRect();
    const cx = box.width / 2;
    const cy = box.height / 2;
    const rx = Math.min(box.width * 0.34, box.width / 2 - 110);
    const ry = Math.min(box.height * 0.36, box.height / 2 - 60);
    return {
      w: box.width,
      h: box.height,
      cx,
      cy,
      at(angle) {
        return [cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry];
      },
    };
  }

  function paintRoads(snap, force) {
    const g = snap.graph;
    const svg = document.getElementById('w-roads');
    const proj = projector();
    if (!g || !svg) return proj;

    const key = `${g.nodes.map((n) => n.name).join('|')}@${Math.round(proj.w)}x${Math.round(proj.h)}`;
    if (!force && key === lastGraphKey) return proj;
    lastGraphKey = key;

    const angle = new Map(g.nodes.map((n) => [n.name, n.angle]));
    const lines = g.edges
      .map((e) => {
        if (!angle.has(e.from) || !angle.has(e.to)) return '';
        const a = proj.at(angle.get(e.from));
        const b = proj.at(angle.get(e.to));
        const w = 0.6 + (e.n / g.max) * 2.6;
        return `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke-width="${w.toFixed(2)}" />`;
      })
      .join('');

    svg.setAttribute('viewBox', `0 0 ${proj.w} ${proj.h}`);
    svg.innerHTML =
      lines +
      `<g class="depot"><circle cx="${proj.cx}" cy="${proj.cy}" r="3.5" /><text x="${proj.cx}" y="${proj.cy + 18}" text-anchor="middle">depot</text></g>`;

    // City dots live in the SVG so they scale with it; the labels are HTML so
    // they stay legible at any size.
    const stage = document.getElementById('w-stage');
    const seen = new Set();
    for (const node of g.nodes) {
      seen.add(node.name);
      const [x, y] = proj.at(node.angle);
      let el = stage.querySelector(`.city[data-city="${CSS.escape(node.name)}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'city';
        el.dataset.city = node.name;
        el.innerHTML = '<span class="dot"></span>';
        stage.appendChild(el);
      }
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;

      let label = stage.querySelector(`.city-label[data-city="${CSS.escape(node.name)}"]`);
      if (!label) {
        label = document.createElement('span');
        label.className = 'city-label';
        label.dataset.city = node.name;
        label.textContent = node.name;
        stage.appendChild(label);
      }
      label.style.left = `${x}px`;
      label.style.top = `${y}px`;
    }
    for (const el of stage.querySelectorAll('.city, .city-label')) {
      if (!seen.has(el.dataset.city)) el.remove();
    }
    return proj;
  }

  function paintTrucks(snap, proj) {
    const stage = document.getElementById('w-stage');
    const angle = new Map((snap.graph ? snap.graph.nodes : []).map((n) => [n.name, n.angle]));
    const next = new Map();

    for (const t of snap.trucks || []) {
      if (!angle.has(t.from) || !angle.has(t.to)) continue;
      const a = proj.at(angle.get(t.from));
      const b = proj.at(angle.get(t.to));
      const x = a[0] + (b[0] - a[0]) * t.p;
      const y = a[1] + (b[1] - a[1]) * t.p;

      let el = truckEls.get(t.tnum);
      if (!el) {
        el = document.createElement('div');
        el.className = 'truck';
        el.title = `${t.regnum} · trip ${t.tnum}`;
        stage.appendChild(el);
      }
      el.style.transition = `left ${Math.max(120, tickMs() * 0.9)}ms linear, top ${Math.max(120, tickMs() * 0.9)}ms linear`;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      next.set(t.tnum, el);
    }
    for (const [key, el] of truckEls) {
      if (!next.has(key)) {
        el.classList.add('gone');
        setTimeout(() => el.remove(), 500);
      }
    }
    truckEls = next;
  }

  // People are rows too. A driver stands where their latest trip ended; a
  // mechanic stands at the depot, because that is where the work is. Both are
  // placed by the same ring as the cities, so they cannot drift from the map.
  function paintPeople(snap, proj) {
    const stage = document.getElementById('w-stage');
    const angle = new Map((snap.graph ? snap.graph.nodes : []).map((n) => [n.name, n.angle]));
    const placed = new Map(); // city -> how many already there

    const put = (el, x, y) => {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    };

    const initials = (name) =>
      String(name || '?')
        .trim()
        .split(/\s+/)
        .map((p) => p[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();

    const seen = new Set();

    const draw = (person, kind) => {
      const key = `${kind}-${person.enum}`;
      seen.add(key);
      let x = proj.cx;
      let y = proj.cy;
      if (kind === 'driver' && person.at_city && angle.has(person.at_city)) {
        const a = angle.get(person.at_city);
        [x, y] = proj.at(a);
        const n = placed.get(person.at_city) || 0;
        placed.set(person.at_city, n + 1);
        // Fan the drivers out around their city so a crowd is still readable.
        const spread = 13;
        x += Math.cos(n * 2.1) * spread * (n ? 1 : 0.6);
        y += Math.sin(n * 2.1) * spread * (n ? 1 : 0.6);
      } else if (kind === 'mechanic') {
        const n = placed.get('depot') || 0;
        placed.set('depot', n + 1);
        x += Math.cos(n * 1.6) * 24;
        y += 40 + Math.sin(n * 1.6) * 10;
      }

      let el = stage.querySelector(`.person[data-key="${key}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = `person ${kind}`;
        el.dataset.key = key;
        el.innerHTML = `<span class="who"></span>`;
        stage.appendChild(el);
      }
      el.querySelector('.who').textContent = initials(person.name);
      el.title = `${person.name} · ${kind} · ${person.lnum}`;
      put(el, x, y);
    };

    for (const d of snap.drivers || []) draw(d, 'driver');
    for (const m of snap.mechanics || []) draw(m, 'mechanic');

    for (const el of stage.querySelectorAll('.person')) {
      if (!seen.has(el.dataset.key)) el.remove();
    }
  }

  function paintSide(snap) {
    const drift = snap.integrity.drift;
    const box = document.getElementById('w-damage');
    box.querySelector('.num').textContent = String(drift);
    box.classList.toggle('bad', drift > 0);
    box.classList.toggle('good', drift === 0);

    const hint = document.getElementById('w-hint');
    if (!snap.objects.trigger) {
      hint.innerHTML = drift
        ? 'Nothing is keeping <code>driver.totalTripMade</code>. Load the trip counter below and apply it, then backfill the rows that already drifted.'
        : 'Nothing is keeping <code>driver.totalTripMade</code> yet. Load the trip counter below.';
    } else if (drift) {
      hint.innerHTML =
        'The trigger is in place, but rows that drifted before it still disagree. Backfill once: <code>UPDATE driver SET totalTripMade = (SELECT count(*) …)</code>.';
    } else {
      hint.textContent = 'Every driver row agrees with the trips on file.';
    }

    document.getElementById('w-dcount').textContent = `${(snap.drivers || []).length} rows`;
    document.getElementById('w-drivers').innerHTML = (snap.drivers || [])
      .map((d) => {
        const trips = Number(d.trips) || 0;
        const counter = d.counter === null || d.counter === undefined ? null : Number(d.counter);
        const diff = counter === null ? null : trips - counter;
        const bad = diff === null ? trips > 0 : diff !== 0;
        return `<div class="drow ${bad ? 'bad' : ''}">
          <span class="dname">${escapeHtml(d.name)}<em>${d.lnum}</em></span>
          <span class="dtrips">${trips}</span>
          <span class="dcounter">${counter === null ? '—' : counter}</span>
          <span class="ddiff">${diff === null ? 'null' : diff > 0 ? `+${diff}` : diff === 0 ? 'same' : diff}</span>
        </div>`;
      })
      .join('');

    const setCount = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    setCount('w-n-driver', snap.totals.drivers ?? snap.drivers.length);
    setCount('w-n-trip', snap.totals.trips);
    setCount('w-n-truck', snap.totals.trucks);

    const c = clockOf(snap.cursor);
    document.getElementById('w-day').textContent = `Day ${c.day}`;
    document.getElementById('w-hour').textContent = c.hour;
    document.getElementById('w-count').textContent = `${snap.cursor} ticks · ${snap.totals.trips} trips on file`;

    const head = document.getElementById('w-headline');
    head.className = `headline ${drift ? 'bad' : 'good'}`;
    head.textContent = drift ? `${drift} driver${drift === 1 ? '' : 's'} out of step` : 'records clean';

    // Key under the map: what a dot, a line and a square are.
    document.getElementById('w-key').innerHTML =
      '<span><i class="k-dot"></i>city</span>' +
      '<span><i class="k-line"></i>route, width = trips on it</span>' +
      '<span><i class="k-truck"></i>truck on a trip</span>' +
      '<span><i class="k-driver"></i>driver, at the end of their latest trip</span>' +
      '<span><i class="k-mech"></i>mechanic, at the depot</span>';
  }

  function paint(snap, events) {
    state.snap = snap;
    const proj = paintRoads(snap, false);
    paintTrucks(snap, proj);
    paintPeople(snap, proj);
    paintSide(snap);
    if (events) pushEvents(events);
  }

  function pushEvents(events) {
    const list = document.getElementById('w-list');
    if (!list || !events.length) return;
    for (const ev of events.slice().reverse()) {
      const c = clockOf(ev.tick);
      const row = document.createElement('div');
      row.className = `tick-row ${ev.ok ? 'ok' : ev.soft ? 'soft' : 'bad'}`;
      row.innerHTML = `<span class="when">d${c.day} ${c.hour}</span>
        <span class="what">${escapeHtml(ev.label)}</span>
        <span class="said">${escapeHtml(ev.soft ? 'nothing to run it yet' : ev.error || ev.detail || 'done')}</span>`;
      list.prepend(row);
    }
    while (list.children.length > 120) list.lastChild.remove();
  }

  // ------------------------------------------------------------------ engine

  async function call(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function step() {
    if (state.busy || !state.rate) return;
    state.busy = true;
    try {
      const out = await call('/api/world/advance', { session: state.session, n: batch() });
      if (out.ok) paint(out, out.events);
    } catch (err) {
      setNote(String(err.message || err));
    } finally {
      state.busy = false;
    }
  }

  function loop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (!state.rate) return;
    state.timer = setInterval(step, tickMs());
  }

  function setRate(v) {
    state.rate = v;
    document.querySelectorAll('#w-speed button').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.rate) === v);
    });
    loop();
  }

  function setNote(text) {
    const el = document.getElementById('w-desk-note');
    if (el) el.textContent = text;
  }

  async function reset() {
    // A new world is always born paused. You pick the speed.
    setRate(0);
    setNote('building the world…');
    const out = await call('/api/world/reset', { session: state.session });
    if (!out.ok) {
      setNote(out.error?.message || 'could not build the world');
      return;
    }
    document.getElementById('w-list').innerHTML = '';
    document.querySelectorAll('.truck').forEach((n) => n.remove());
    truckEls = new Map();
    paint(out);
    setNote('world ready — pick a speed');
  }

  // -------------------------------------------------------------------- desk

  let cm = null;

  function mountEditor(host) {
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.value = localStorage.getItem('trk.world.sql') || '';
    host.appendChild(ta);
    if (window.CodeMirror) {
      cm = window.CodeMirror.fromTextArea(ta, {
        mode: 'text/x-pgsql',
        lineNumbers: true,
        indentUnit: 4,
        tabSize: 4,
        matchBrackets: true,
        extraKeys: {
          'Cmd-Enter': () => applyScript(),
          'Ctrl-Enter': () => applyScript(),
          Tab: (i) => i.replaceSelection('    '),
          'Ctrl-Space': 'autocomplete',
        },
        hintOptions: { completeSingle: false },
      });
      cm.on('change', () => localStorage.setItem('trk.world.sql', cm.getValue()));
      setTimeout(() => cm.refresh(), 0);
    } else {
      ta.oninput = () => localStorage.setItem('trk.world.sql', ta.value);
    }
    return {
      get: () => (cm ? cm.getValue() : ta.value),
      set: (v) => {
        if (cm) cm.setValue(v);
        else ta.value = v;
        localStorage.setItem('trk.world.sql', v);
      },
    };
  }

  async function applyScript() {
    if (!state.editor) return;
    setNote('applying…');
    const out = await call('/api/world/apply', { session: state.session, script: state.editor.get() });
    if (out.error) {
      setNote(`ERROR: ${out.error.message}`);
      return;
    }
    paint(out);
    setNote(`${out.statements} statement${out.statements === 1 ? '' : 's'} applied — the world is running your SQL`);
  }

  // -------------------------------------------------------------------- mount

  async function mount(host) {
    host.className = 'view world-mode';
    host.innerHTML = worldHTML();
    state.session = sessionId();
    state.rate = 0;
    state.busy = false;
    lastGraphKey = '';
    truckEls = new Map();

    state.editor = mountEditor(document.getElementById('w-editor'));

    document.querySelectorAll('#w-speed button').forEach((b) => {
      b.onclick = () => setRate(Number(b.dataset.rate));
    });
    document.getElementById('w-reset').onclick = reset;
    document.getElementById('w-console').onclick = () => window.TRK.show('console');
    document.getElementById('w-apply').onclick = applyScript;

    document.querySelectorAll('[data-load]').forEach((b) => {
      b.onclick = () => {
        const s = SKELETONS[b.dataset.load];
        state.editor.set(s.sql);
        document.getElementById('w-desk-hint').textContent = s.hint;
      };
    });

    document.getElementById('w-desk-hint').textContent =
      'Pick one of the three, fill in the body, apply. The depot keeps running while you edit.';

    // Space pauses. It is the only key the world listens for.
    const onKey = (e) => {
      if (e.code !== 'Space') return;
      if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
      if (document.querySelector('.CodeMirror-focused')) return;
      e.preventDefault();
      setRate(state.rate ? 0 : 1);
    };
    document.addEventListener('keydown', onKey);
    state.unkey = () => document.removeEventListener('keydown', onKey);

    // Zoom and pan. Wheel zooms about the pointer, drag moves the sheet, and
    // "fit" puts it back. The projection never changes, only the transform, so
    // the map cannot disagree with itself at a different scale.
    const map = document.getElementById('w-map');
    map.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = map.getBoundingClientRect();
      zoomTo(view.z * Math.exp(-e.deltaY * 0.0014), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    let drag = null;
    map.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.zoom-controls')) return;
      drag = { x: e.clientX, y: e.clientY };
      map.classList.add('dragging');
      map.setPointerCapture(e.pointerId);
    });
    map.addEventListener('pointermove', (e) => {
      if (!drag) return;
      view.x += e.clientX - drag.x;
      view.y += e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      panBounds();
      applyZoom();
    });
    const drop = () => {
      drag = null;
      map.classList.remove('dragging');
    };
    map.addEventListener('pointerup', drop);
    map.addEventListener('pointercancel', drop);

    document.querySelectorAll('[data-zoom]').forEach((b) => {
      b.onclick = () => {
        const box = map.getBoundingClientRect();
        if (b.dataset.zoom === 'in') zoomTo(view.z * 1.4, box.width / 2, box.height / 2);
        if (b.dataset.zoom === 'out') zoomTo(view.z / 1.4, box.width / 2, box.height / 2);
        if (b.dataset.zoom === 'reset') {
          const z = view.z;
          view.z = 1;
          view.x = 0;
          view.y = 0;
          void z;
          applyZoom();
        }
      };
    });

    view.z = 1;
    view.x = 0;
    view.y = 0;
    applyZoom();

    // The ring is pixel geometry, so it is redrawn when the pane changes size.
    state.onResize = () => {
      lastGraphKey = '';
      if (state.snap) paint(state.snap);
    };
    window.addEventListener('resize', state.onResize);

    await reset();
  }

  function unmount() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (state.unkey) state.unkey();
    if (state.onResize) window.removeEventListener('resize', state.onResize);
  }

  window.TRK_VIEWS = {
    world: { label: 'World', icon: 'route', render: () => '', mount: () => mount(document.getElementById('view')), unmount },
  };

  window.TRK_WORLD = { mount, unmount };
})();
