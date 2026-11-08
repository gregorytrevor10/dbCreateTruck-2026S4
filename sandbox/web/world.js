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

  // Snippets are only a place to start. Each one is inserted at the cursor in
  // the workbench, so a learner can compose several objects in one file, or
  // ignore the shapes and write their own from a blank page.
  const SNIPPETS = {
    procedure: {
      name: 'procedure',
      hint: 'A hire writes one TRKEMPLOYEE row, then one DRIVER or one MECHANIC row. Refuse what the depot would never allow: an unknown role, a licence the other kind already holds, a mechanic with no experience.',
      sql: `-- a procedure: called with CALL, may change rows
CREATE OR REPLACE PROCEDURE add_employee(
    p_enum NUMERIC, p_name VARCHAR, p_dob DATE, p_address VARCHAR,
    p_hiredate DATE, p_lnum NUMERIC, p_status VARCHAR,
    p_experience VARCHAR DEFAULT NULL, p_role VARCHAR DEFAULT 'DRIVER')
LANGUAGE plpgsql
AS $$
BEGIN
    -- refuse a role that is neither DRIVER nor MECHANIC
    --   RAISE EXCEPTION '...' USING ERRCODE = '...';

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
    trigger: {
      name: 'trigger',
      hint: 'DRIVER.totalTripMade is a stored count of TRIP rows. A trigger keeps it honest. Cover insert, delete and update — a trip can move between drivers. Rows that already exist never fire a trigger, so backfill them once.',
      sql: `-- a trigger: one function that returns trigger, one CREATE TRIGGER
CREATE OR REPLACE FUNCTION trg_total_trip_made() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- which driver's counter moved?
    --   INSERT, UPDATE: NEW.lnum     DELETE: OLD.lnum
    -- an UPDATE that changes lnum moves the count between two drivers

    RETURN NULL;   -- AFTER triggers ignore the return value
END;
$$;

CREATE OR REPLACE TRIGGER trip_total_trip_made
    AFTER INSERT OR UPDATE OR DELETE ON trip
    FOR EACH ROW
    EXECUTE FUNCTION trg_total_trip_made();
`,
    },
    function: {
      name: 'function',
      hint: 'A function answers a question without changing anything: the most legs on any one trip of a driver. A driver with no trips answers 0, not null.',
      sql: `-- a function: returns a value, used in SELECT
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
    query: {
      name: 'try it',
      hint: 'CALL runs a procedure and changes rows. SELECT runs a function and only reads. The UPDATE is the one backfill the seed rows need after the trigger exists.',
      sql: `-- Try what you built. Rows come back in the result tab.
CALL add_employee(101, 'New Driver', DATE '1990-01-01', '1 Test St',
                  CURRENT_DATE, 91000, 'AVAILABLE', NULL, 'DRIVER');

SELECT longtrip(10001) AS longest;

-- Rows written before the trigger never fired it: repair them once.
UPDATE driver d
   SET totalTripMade = (SELECT count(*) FROM trip t WHERE t.lnum = d.lnum);
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
          <button class="btn quiet tiny" id="w-help">how to play</button>
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

          <div class="panel-head slim"><span>steps</span><span id="w-progress"></span></div>
          <div class="steps" id="w-steps"></div>

          <div class="panel-head slim"><span>drivers</span><span id="w-dcount"></span></div>
          <div class="dhead"><span>driver</span><span>trips</span><span>counter</span><span>off by</span></div>
          <div class="dtable" id="w-drivers"></div>

          <details class="legend-wrap">
            <summary>what you are looking at</summary>
            <div class="legend" id="w-legend">
            ${LEGEND.map(
              (l) => `<div class="legend-row"><code>${l.table}</code><span id="w-n-${l.table}">—</span><em>${l.what}</em></div>`,
            ).join('')}
            <div class="legend-note">Every tick is one statement against a clone of the seed: an insert, a cancel, a move between drivers, or a hire. Each one states what it expects and reads back what happened.</div>
            </div>
          </details>
        </aside>

        <section class="ticker" id="w-ticker">
          <div class="ticker-head"><span>what just happened</span><span class="mono" id="w-count"></span></div>
          <div class="ticker-list" id="w-list"></div>
        </section>

        <div class="howto" id="w-howto" hidden>
          <div class="howto-card">
            <h2>How to play</h2>
            <ol>
              <li><strong>This depot is a Postgres database.</strong> Every tick is one real SQL statement run against a copy of the seed. The map and the numbers are that database, read back.</li>
              <li><strong>Pick a speed and watch.</strong> With no trigger, <code>driver.totalTripMade</code> stops matching the trips on file. The red number on the right is that gap, and it grows.</li>
              <li><strong>Write your own.</strong> The workbench at the bottom takes any SQL: <code>CREATE OR REPLACE</code>, a trigger, a function, a plain <code>SELECT</code>, a <code>CALL</code>. The four buttons only insert a marked-up shape at the cursor; the body is yours to write, ignore, or replace entirely.</li>
              <li><strong>Run it in the world.</strong> The running clone takes your script at once, so the depot that was rotting stops rotting while it is still moving. The result tab shows rows, notices and errors with a line and column.</li>
              <li><strong>Read the objects tab.</strong> Every routine and trigger you have written is there, with the definition Postgres stored. Load one back into the editor to see what <code>CREATE OR REPLACE</code> actually left behind, or start again from a blank page.</li>
              <li><strong>Click any row below</strong> under "what just happened" to see the exact statement that ran and what it was meant to do.</li>
            </ol>
            <p class="howto-foot">Scroll to zoom the map, drag to pan, space pauses. A new world always starts paused.</p>
            <button class="btn primary" id="w-gotit">Got it</button>
          </div>
        </div>

        <section class="desk" id="w-desk">
          <div class="desk-head">
            <span class="desk-title">sql workbench</span>
            <div class="desk-tabs">
              ${Object.entries(SNIPPETS)
                .map(([k, s]) => `<button class="tab" data-snip="${k}">${s.name}</button>`)
                .join('')}
            </div>
            <span class="spacer"></span>
            <span class="mono" id="w-desk-note"></span>
            <button class="btn quiet tiny" id="w-clear">clear</button>
            <button class="btn primary" id="w-apply">run in the world</button>
          </div>
          <div class="desk-body">
            <div class="desk-guide" id="w-guide">
              <p class="guide-lead">Write anything. It runs against your own copy of the seed, not the board behind the console.</p>
              <p class="guide-head">the depot calls three names</p>
              <ul class="guide-list">
                <li><code>add_employee(...)</code> when it hires</li>
                <li>a trigger on <code>trip</code> on arrival, cancel, move</li>
                <li><code>longtrip(lnum)</code> when it asks</li>
              </ul>
              <p class="guide-note">Anything else you create is yours. The steps only measure the outcome, never the text.</p>
              <p class="guide-snip" id="w-snip-hint"></p>
              <p class="guide-foot">Ctrl/⌘+Enter runs the file. Ctrl/⌘+Shift+Enter runs the selection.</p>
            </div>
            <div class="desk-editor" id="w-editor"></div>
            <div class="desk-out">
              <div class="out-tabs" id="w-out-tabs">
                <button class="on" data-out="result">result</button>
                <button data-out="objects">objects <span id="w-objs-n"></span></button>
                <button data-out="syntax">syntax</button>
              </div>
              <div class="out-body" id="w-out-body"></div>
            </div>
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

  // Five steps, each one checked against the database. Open a step to get the
  // nudge; the point is to make "stuck" a place with an exit.
  function stepsFor(snap) {
    const drift = snap.integrity.drift;
    const o = snap.objects || {};
    return [
      {
        key: 'break',
        title: 'Watch it break',
        done: drift > 0 || o.trigger,
        body: 'Set the speed to 8× or 16× and leave it. Every tick that inserts or cancels a TRIP is supposed to move DRIVER.totalTripMade; nothing does, so the panel starts disagreeing.',
        hint: 'You do not have to do anything here. Read a few rows in “what just happened” and open one to see the statement.',
      },
      {
        key: 'trigger',
        title: 'Keep the counter',
        done: !!o.trigger,
        body: 'Write a trigger function and a CREATE TRIGGER in the workbench: AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW.',
        hint: 'Inside the function: INSERT and UPDATE use NEW.lnum, DELETE uses OLD.lnum. An UPDATE that changes lnum moves the count between two drivers, so update both.',
      },
      {
        key: 'backfill',
        title: 'Repair the old rows',
        done: !!o.trigger && drift === 0,
        body: 'Rows that existed before the trigger never fired it. Bring them into line once, by hand.',
        hint: 'UPDATE driver d SET totalTripMade = (SELECT count(*) FROM trip t WHERE t.lnum = d.lnum);',
      },
      {
        key: 'procedure',
        title: 'Hire someone',
        done: !!o.procedure,
        body: 'The depot keeps trying to hire and has nothing to run. Write add_employee in the workbench: one TRKEMPLOYEE row, then a DRIVER or MECHANIC row, and refuse what cannot exist.',
        hint: 'Refuse: a role that is not DRIVER or MECHANIC; a licence the other kind already holds; a MECHANIC with no experience; a DRIVER with one. RAISE EXCEPTION does the refusing.',
      },
      {
        key: 'function',
        title: 'Answer about trips',
        done: !!o.function,
        body: 'Write longtrip(lnum): the most legs on any one trip that driver has made, and 0 when they have none.',
        hint: 'Count legs per trip with LEFT JOIN tripleg, take max(), and coalesce to 0. The LEFT JOIN is what keeps a trip with no legs visible.',
      },
    ];
  }

  let stepSig = '';
  function paintSteps(snap) {
    const steps = stepsFor(snap);
    const done = steps.filter((s) => s.done).length;
    document.getElementById('w-progress').textContent = `${done}/${steps.length}`;

    const sig = steps.map((s) => `${s.key}:${s.done ? 1 : 0}`).join('|');
    if (sig === stepSig) return;
    stepSig = sig;

    document.getElementById('w-steps').innerHTML = steps
      .map(
        (s) => `<details class="wstep ${s.done ? 'done' : ''}">
          <summary><span class="wstep-mark">${s.done ? '✓' : '·'}</span><span class="wstep-t">${escapeHtml(s.title)}</span></summary>
          <div class="wstep-body">
            <p>${escapeHtml(s.body)}</p>
            <pre>${escapeHtml(s.hint)}</pre>
          </div>
        </details>`,
      )
      .join('');
  }

  function paintSide(snap) {
    const drift = snap.integrity.drift;
    const box = document.getElementById('w-damage');
    box.querySelector('.num').textContent = String(drift);
    box.classList.toggle('bad', drift > 0);
    box.classList.toggle('good', drift === 0);

    const hint = document.getElementById('w-hint');
    if (!snap.objects.trigger) {
      hint.innerHTML = snap.objects.triggerObjects
        ? 'A trigger on <code>trip</code> exists, but an insert did not move <code>driver.totalTripMade</code>. Open it in the objects tab: check <code>TG_OP</code> and <code>NEW.lnum</code>.'
        : drift
          ? 'Nothing is keeping <code>driver.totalTripMade</code>. Write a trigger on trip in the workbench and run it, then backfill the rows that already drifted.'
          : 'Nothing is keeping <code>driver.totalTripMade</code> yet. Write a trigger on trip in the workbench.';
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

    paintSteps(snap);

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
      // Each row opens onto the statement that produced it. A tick is a query;
      // hiding it would make the world look like an animation instead of a
      // database being written to.
      const row = document.createElement('details');
      row.className = `tick-row ${ev.ok ? 'ok' : ev.soft ? 'soft' : 'bad'}`;
      const said = ev.soft ? 'nothing to run it yet' : ev.error || ev.detail || 'done';
      row.innerHTML = `<summary>
          <span class="when">d${c.day} ${c.hour}</span>
          <span class="what">${escapeHtml(ev.label)}</span>
          <span class="said">${escapeHtml(said)}</span>
        </summary>
        <div class="tick-body">
          <pre>${escapeHtml(ev.sql || '—')}</pre>
          ${ev.why ? `<p>${escapeHtml(ev.why)}</p>` : ''}
          ${
            ev.expectation
              ? `<div class="expect ${ev.expectation.pass ? 'pass' : 'fail'}">
                   <span><em>expected</em>${escapeHtml(ev.expectation.expected)}</span>
                   <span><em>actual</em>${escapeHtml(ev.expectation.actual)}</span>
                 </div>`
              : ''
          }
        </div>`;
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
    lastRun = null;
    setOut('result');
    paint(out);
    await loadLibrary();
    setNote('world ready — pick a speed');
  }

  // -------------------------------------------------------------------- desk
  //
  // The workbench is deliberately a plain SQL file, not three forms. You can
  // write one object, five, a SELECT, a CALL, or DROP what you built. The only
  // contract is the three names the depot calls; everything else is yours.

  let cm = null;
  let outTab = 'result';
  let lastRun = null;
  let library = { routines: [], triggers: [] };

  function mountEditor(host) {
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    // A file that was loaded from another world carries that clone's schema
    // prefix. Strip it on the way in, so an old file still runs here.
    const saved = (localStorage.getItem('trk.world.sql') || '').replace(/\bplay_[a-z0-9]{6,24}\./g, '');
    ta.value = saved;
    if (saved !== (localStorage.getItem('trk.world.sql') || '')) localStorage.setItem('trk.world.sql', saved);
    host.appendChild(ta);
    if (window.CodeMirror) {
      cm = window.CodeMirror.fromTextArea(ta, {
        mode: 'text/x-pgsql',
        lineNumbers: true,
        indentUnit: 4,
        tabSize: 4,
        matchBrackets: true,
        extraKeys: {
          'Cmd-Enter': () => applyScript(false),
          'Ctrl-Enter': () => applyScript(false),
          'Shift-Cmd-Enter': () => applyScript(true),
          'Shift-Ctrl-Enter': () => applyScript(true),
          'Ctrl-Shift-Enter': () => applyScript(true),
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
    const save = (v) => localStorage.setItem('trk.world.sql', v);
    return {
      get: () => (cm ? cm.getValue() : ta.value),
      set: (v) => {
        if (cm) cm.setValue(v);
        else ta.value = v;
        save(v);
      },
      insert: (v) => {
        if (cm) {
          cm.replaceSelection(v);
          cm.focus();
          save(cm.getValue());
        } else {
          const start = ta.selectionStart ?? ta.value.length;
          ta.value = ta.value.slice(0, start) + v + ta.value.slice(ta.selectionEnd ?? start);
          ta.selectionStart = ta.selectionEnd = start + v.length;
          save(ta.value);
        }
      },
      selection: () => (cm ? cm.getSelection() : ta.value.slice(ta.selectionStart, ta.selectionEnd)),
    };
  }

  const esc = escapeHtml;

  function rowTable(columns, rows) {
    const head = columns.map((c) => `<th>${esc(c)}</th>`).join('');
    const shown = (rows || []).slice(0, 200);
    const body = shown
      .map(
        (row) =>
          `<tr>${columns
            .map((c) => {
              const v = row[c];
              return `<td>${v === null || v === undefined ? '<span class="null">null</span>' : esc(v)}</td>`;
            })
            .join('')}</tr>`,
      )
      .join('');
    const more =
      (rows || []).length > shown.length
        ? `<p class="out-placeholder">showing ${shown.length} of ${rows.length} rows</p>`
        : '';
    return `<div class="res-wrap"><table class="res-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
  }

  function renderResult(host) {
    if (!lastRun) {
      host.innerHTML =
        '<p class="out-placeholder">Run the file. Rows, notices and errors land here — including the line and column of a syntax or PL/pgSQL error.</p>';
      return;
    }
    const parts = [];
    for (const r of lastRun.results || []) {
      const title = r.error ? 'error' : r.command || 'statement';
      const rows = typeof r.rowCount === 'number' ? ` · ${r.rowCount} row${r.rowCount === 1 ? '' : 's'}` : '';
      parts.push(`<div class="run-step">
        <div class="run-head"><code>${esc(r.text)}</code><span>${esc(title)}${rows}</span></div>`);
      if (r.error) {
        const where = r.error.where ? `<span class="where">line ${r.error.where.line}, column ${r.error.where.column}${r.error.code ? ` · SQLSTATE ${esc(r.error.code)}` : ''}</span>` : '';
        parts.push(`<div class="alert bad"><strong>${esc(r.error.message)}</strong>${
          r.error.detail ? `<span>${esc(r.error.detail)}</span>` : ''
        }${r.error.hint ? `<span>${esc(r.error.hint)}</span>` : ''}${where}</div>`);
      } else if (r.columns && r.columns.length) {
        parts.push(rowTable(r.columns, r.rows));
      }
      parts.push('</div>');
    }
    if ((lastRun.notices || []).length) {
      parts.push(`<div class="notices">${lastRun.notices.map((n) => `<div class="notice">${esc(n)}</div>`).join('')}</div>`);
    }
    host.innerHTML = parts.join('') || '<p class="out-placeholder">Nothing ran.</p>';
  }

  function renderObjects(host) {
    const procs = library.routines.filter((r) => r.kind === 'p');
    const fns = library.routines.filter((r) => r.kind !== 'p');
    const parts = [];
    const routines = (label, items) => {
      parts.push(`<div class="lib-group"><p class="lib-head">${label}</p>`);
      if (!items.length) parts.push('<p class="out-placeholder">none yet — write one and run it</p>');
      for (const r of items) {
        const i = library.routines.indexOf(r);
        const isTriggerFn = r.result === 'trigger';
        const kind = r.kind === 'p' ? 'procedure' : isTriggerFn ? 'trigger fn' : 'function';
        parts.push(`<div class="lib-item">
          <div class="lib-top"><code>${esc(r.name)}(${esc(r.args)})</code><span class="kind">${kind}</span></div>
          <div class="lib-sub"><span>${esc(r.result || 'no return value')}</span><button class="btn quiet tiny" data-def="r:${i}">load</button></div>
        </div>`);
      }
      parts.push('</div>');
    };
    routines('procedures', procs);
    routines('functions', fns);
    parts.push('<div class="lib-group"><p class="lib-head">triggers</p>');
    if (!library.triggers.length) parts.push('<p class="out-placeholder">none yet — a trigger needs a function and a CREATE TRIGGER</p>');
    library.triggers.forEach((t, i) => {
      parts.push(`<div class="lib-item">
        <div class="lib-top"><code>${esc(t.name)}</code><span class="kind">on ${esc(t.table_name)}</span></div>
        <div class="lib-sub"><span>${esc(t.when_clause || 'for each row, after')}</span><button class="btn quiet tiny" data-def="t:${i}">load</button></div>
      </div>`);
    });
    // Existence is not the same as working: the clone is probed with one real
    // insert, and the tab says so plainly when the trigger does nothing.
    if (library.built && library.built.trigger === false && library.triggers.length) {
      parts.push(
        '<p class="lib-warn">A trigger on <code>trip</code> exists, but an insert did not move <code>driver.totalTripMade</code>. It is not keeping the counter yet.</p>',
      );
    }
    parts.push('</div>');
    host.innerHTML = parts.join('');
  }

  function renderSyntax(host) {
    host.innerHTML = `<div class="syntax">
      <p class="syntax-h">procedure — called with CALL, may write rows</p>
      <pre>CREATE OR REPLACE PROCEDURE add_employee(
    p_enum NUMERIC, p_name VARCHAR, p_role VARCHAR DEFAULT 'DRIVER')
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_role NOT IN ('DRIVER', 'MECHANIC') THEN
        RAISE EXCEPTION 'unknown role: %', p_role;
    END IF;
    -- INSERT ...
END;
$$;

CALL add_employee(101, 'New Driver', 'DRIVER');</pre>

      <p class="syntax-h">function — returns a value, used in a query</p>
      <pre>CREATE OR REPLACE FUNCTION longtrip(p_lnum NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE v_max NUMERIC;
BEGIN
    RETURN coalesce(v_max, 0);
END;
$$;

SELECT longtrip(10001);</pre>

      <p class="syntax-h">trigger — a function returning trigger, plus CREATE TRIGGER</p>
      <pre>CREATE OR REPLACE FUNCTION trg_example() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- INSERT/UPDATE: NEW is the row being written
    -- DELETE: OLD is the row being removed
    RETURN NULL;  -- AFTER triggers ignore this
END;
$$;

CREATE OR REPLACE TRIGGER trip_example
    AFTER INSERT OR UPDATE OR DELETE ON trip
    FOR EACH ROW
    EXECUTE FUNCTION trg_example();</pre>

      <p class="syntax-h">replace or remove</p>
      <pre>CREATE OR REPLACE changes the body in place.
DROP TRIGGER trip_example ON trip;
DROP FUNCTION trg_example();
DROP PROCEDURE add_employee(numeric, varchar, date, varchar, date,
                            numeric, varchar, varchar, varchar);</pre>

      <p class="syntax-note">RAISE EXCEPTION aborts the statement (and the CALL); RAISE NOTICE only prints, and appears under the result. Every statement runs on its own, like <code>psql</code>: a failure later in the file does not undo the objects created before it. This is your clone, so DROP and broken tables are safe — <strong>new world</strong> rebuilds from the seed.</p>
    </div>`;
  }

  function setOut(tab) {
    outTab = tab;
    document.querySelectorAll('#w-out-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.out === tab));
    renderOut();
  }

  function renderOut() {
    const host = document.getElementById('w-out-body');
    if (!host) return;
    if (outTab === 'objects') renderObjects(host);
    else if (outTab === 'syntax') renderSyntax(host);
    else renderResult(host);
  }

  async function loadLibrary() {
    const out = await call('/api/world/objects', { session: state.session });
    if (!out.ok) return;
    library = {
      routines: out.routines || [],
      triggers: out.triggers || [],
      built: out.built || {},
    };
    const n = document.getElementById('w-objs-n');
    if (n) n.textContent = String(library.routines.length + library.triggers.length);
    if (outTab === 'objects') renderOut();
  }

  async function applyScript(selectionOnly) {
    if (!state.editor) return;
    const script = selectionOnly ? state.editor.selection() : state.editor.get();
    if (!String(script || '').trim()) {
      setNote(selectionOnly ? 'select something to run' : 'the editor is empty');
      return;
    }
    setNote('running…');
    const out = await call('/api/world/apply', { session: state.session, script });
    lastRun = out;
    setOut('result');
    if (out.integrity) paint(out);
    await loadLibrary();
    if (out.error) {
      const where = out.error.where ? ` at line ${out.error.where.line}, column ${out.error.where.column}` : '';
      setNote(`ERROR${where}: ${out.error.message}`);
    } else {
      setNote(
        `${out.statements} statement${out.statements === 1 ? '' : 's'} ran — the world is running your SQL`,
      );
    }
  }

  // -------------------------------------------------------------------- mount

  async function mount(host) {
    host.className = 'view world-mode';
    host.innerHTML = worldHTML();
    state.session = sessionId();
    state.rate = 0;
    state.busy = false;
    lastGraphKey = '';
    stepSig = '';
    truckEls = new Map();

    state.editor = mountEditor(document.getElementById('w-editor'));

    document.querySelectorAll('#w-speed button').forEach((b) => {
      b.onclick = () => setRate(Number(b.dataset.rate));
    });
    document.getElementById('w-reset').onclick = reset;
    document.getElementById('w-console').onclick = () => window.TRK.show('console');

    const howto = document.getElementById('w-howto');
    const showHowto = (on) => {
      howto.hidden = !on;
    };
    document.getElementById('w-help').onclick = () => showHowto(true);
    document.getElementById('w-gotit').onclick = () => {
      showHowto(false);
      localStorage.setItem('trk.world.seen', '1');
    };
    if (!localStorage.getItem('trk.world.seen')) showHowto(true);
    document.getElementById('w-apply').onclick = () => applyScript(false);
    document.getElementById('w-clear').onclick = () => {
      state.editor.set('');
      setNote('editor cleared — the world still has what you already ran');
    };

    document.querySelectorAll('[data-snip]').forEach((b) => {
      b.onclick = () => {
        const s = SNIPPETS[b.dataset.snip];
        state.editor.insert(s.sql);
        document.getElementById('w-snip-hint').textContent = s.hint;
        setNote(`${s.name} shape inserted at the cursor`);
      };
    });

    document.querySelectorAll('#w-out-tabs button').forEach((b) => {
      b.onclick = () => setOut(b.dataset.out);
    });

    // A definition in the objects tab can be loaded straight back into the
    // editor: the fastest way to see what CREATE OR REPLACE actually stored.
    document.getElementById('w-out-body').addEventListener('click', (e) => {
      const b = e.target.closest('[data-def]');
      if (!b) return;
      const [kind, idx] = b.dataset.def.split(':');
      const item = kind === 'r' ? library.routines[Number(idx)] : library.triggers[Number(idx)];
      if (!item) return;
      // pg_get_functiondef qualifies the name with the clone's schema. Strip
      // it: the editor should hold SQL that runs in whichever world is open.
      const definition = String(item.definition || '').replace(/\bplay_[a-z0-9]{6,24}\./g, '');
      state.editor.set(definition);
      document.getElementById('w-snip-hint').textContent = `loaded ${item.name} — the schema name is stripped, so it runs in the current world`;
      setNote(`loaded ${item.name} into the editor`);
    });

    document.getElementById('w-snip-hint').textContent =
      'Pick a shape above to insert it at the cursor, or just start typing.';
    renderOut();

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
