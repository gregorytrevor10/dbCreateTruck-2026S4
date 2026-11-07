// TRUCK practice playground.
//
// Three labs over the same fleet data: procedures, row-level triggers, stored
// functions. Each lab is a worksheet, a set of checks, and the business rows the
// change actually affects. The console stays for free play.

const $ = (s) => document.querySelector(s);

// ------------------------------------------------------------------- helpers

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const isNull = (v) => v === null || v === undefined;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(value) {
  if (isNull(value)) return '—';
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(value);
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function fmtNumber(value) {
  if (isNull(value)) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('en-AU');
}

const STATUS_CLASS = {
  AVAILABLE: 'ok',
  BUSY: 'warn',
  USED: 'warn',
  MAINTAINED: 'bad',
  'ON LEAVE': 'idle',
  ON_LEAVE: 'idle',
};

function badge(value) {
  if (isNull(value)) return '<span class="badge idle">unknown</span>';
  const cls = STATUS_CLASS[String(value).trim().toUpperCase()] || 'idle';
  return `<span class="badge ${cls}">${esc(String(value).toLowerCase().replace(/_/g, ' '))}</span>`;
}

const AVATAR_TONES = ['#e8f0fb', '#eaf3ec', '#fdf2e4', '#f3edfb', '#eaf4f8', '#fbeeef'];

function avatar(name) {
  const clean = String(name || '?').trim();
  const parts = clean.split(/\s+/);
  const initials = (parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '');
  let hash = 0;
  for (const ch of clean) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  const tone = AVATAR_TONES[hash % AVATAR_TONES.length];
  return `<span class="avatar" style="background:${tone}">${esc(initials.toUpperCase())}</span>`;
}

function ribbon(route) {
  if (isNull(route)) return '<span class="route-empty">no legs recorded</span>';
  const places = String(route).split('→').map((p) => p.trim()).filter(Boolean);
  if (!places.length) return '<span class="route-empty">no legs recorded</span>';
  return `<span class="ribbon">${places
    .map((p, i) => `${i ? '<span class="tick"></span>' : ''}<span class="stop">${esc(p)}</span>`)
    .join('')}</span>`;
}

function cell(value, cls = '') {
  if (isNull(value)) return `<td class="null ${cls}">—</td>`;
  return `<td class="${cls}">${esc(value)}</td>`;
}

function tableHTML(defs, rows, opts = {}) {
  const head = defs.map((d) => `<th class="${d.align === 'right' ? 'num' : ''}">${esc(d.label)}</th>`).join('');
  if (!rows.length) {
    return `<table class="grid"><thead><tr>${head}</tr></thead>
      <tbody><tr><td class="null" colspan="${defs.length}">${esc(opts.empty || 'No rows.')}</td></tr></tbody></table>`;
  }
  const body = rows
    .map((row) => {
      const tds = defs
        .map((d) => {
          if (d.html) return `<td class="${d.cls || ''} ${d.align === 'right' ? 'num' : ''}">${d.html(row)}</td>`;
          const raw = row[d.key];
          const cls = [d.cls || '', d.align === 'right' ? 'num' : ''].join(' ').trim();
          if (d.format) return `<td class="${cls}">${d.format(raw, row)}</td>`;
          return cell(raw, cls);
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  return `<table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function panel(title, note, body) {
  return `<div class="panel">
    <div class="panel-head"><span class="panel-title">${esc(title)}</span><span class="panel-note">${esc(note || '')}</span></div>
    ${body}
  </div>`;
}

function peek(sql) {
  return `<details class="peek">
    <summary>show the query behind this view</summary>
    <div class="peek-body">
      <pre>${esc(sql.trim())}</pre>
      <div class="peek-actions"><button class="btn on-dark" data-open-console="1">Open in console</button></div>
    </div>
  </details>`;
}

// ---------------------------------------------------------------------- api

async function q(sql) {
  const res = await fetch('/api/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  return res.json();
}

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  return res.json();
}

async function run(sql) {
  const out = await q(sql);
  $('#timing').textContent = out.ok ? `${out.durationMs} ms · ${out.rowCount} rows` : `${out.durationMs} ms · error`;
  return out;
}

function toast(message, bad = false) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.toggle('bad', bad);
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2400);
}

// ---------------------------------------------------------------------- labs

const one = (payload) => payload.results?.[0]?.rows?.[0] || {};
const num = (v) => Number(v);
// Find the first result row that carries a given column, whatever the
// statement order was. Safer than counting positions.
const rowWith = (payload, key) =>
  (payload.results || []).map((r) => r.rows?.[0]).find((r) => r && key in r) || {};

const LABS = {

  // ---------------------------------------------------------------- procedures
  procedures: {
    label: 'Procedures',
    icon: 'wrench',
    headline: 'Hire a person',
    question:
      'Write add_employee(...) as a stored procedure. It hires someone as a driver or a mechanic, and refuses anyone who breaks the rules.',
    facts: [
      'A driver is a TRKEMPLOYEE row plus a DRIVER row. A mechanic is a TRKEMPLOYEE row plus a MECHANIC row.',
      'DRIVER and MECHANIC are disjoint: no person and no licence may appear in both.',
      'RAISE EXCEPTION aborts the call. RAISE NOTICE only prints.',
      'CREATE OR REPLACE PROCEDURE lets you refine the body without dropping it.',
    ],
    starter: `-- Task 1. Fill in the body.
CREATE OR REPLACE PROCEDURE add_employee(
    p_enum       NUMERIC,
    p_name       VARCHAR,
    p_dob        DATE,
    p_address    VARCHAR,
    p_hiredate   DATE,
    p_lnum       NUMERIC,
    p_status     VARCHAR,
    p_experience VARCHAR DEFAULT NULL,
    p_role       VARCHAR DEFAULT 'DRIVER'
)
LANGUAGE plpgsql
AS $$
BEGIN
    -- 1. reject a role that is neither DRIVER nor MECHANIC
    -- 2. a MECHANIC needs an experience level, a DRIVER must not have one
    -- 3. reject a licence or employee that is already the other kind
    -- 4. insert the employee, then the matching row

END;
$$;

-- Try it:
CALL add_employee(
    p_enum     => 18,
    p_name     => 'Test Driver',
    p_dob      => DATE '1994-06-02',
    p_address  => '1 George St, Sydney NSW 2000',
    p_hiredate => CURRENT_DATE,
    p_lnum     => 41000,
    p_status   => 'AVAILABLE',
    p_role     => 'DRIVER' );`,
    checks: [
      {
        label: 'add_employee is defined',
        sql: `SELECT count(*)::int AS n FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'add_employee'`,
        verdict: (p) => ({ pass: num(one(p).n) > 0, detail: num(one(p).n) > 0 ? 'found in public' : 'no routine with that name' }),
      },
      {
        label: 'hires a driver',
        sql: `BEGIN;
CALL add_employee(901, 'Check Driver', DATE '1990-01-01', '1 Test St', CURRENT_DATE, 900001, 'AVAILABLE', NULL, 'DRIVER');
SELECT (SELECT count(*)::int FROM trkemployee WHERE enum = 901) AS emp,
       (SELECT count(*)::int FROM driver      WHERE enum = 901) AS drv,
       (SELECT count(*)::int FROM mechanic    WHERE enum = 901) AS mec;
ROLLBACK;`,
        verdict: (p) => {
          const r = rowWith(p, 'emp');
          const pass = num(r.emp) === 1 && num(r.drv) === 1 && num(r.mec) === 0;
          return { pass, detail: `employee ${r.emp}, driver ${r.drv}, mechanic ${r.mec}` };
        },
      },
      {
        label: 'hires a mechanic',
        sql: `BEGIN;
CALL add_employee(902, 'Check Mechanic', DATE '1990-01-01', '1 Test St', CURRENT_DATE, 900002, 'AVAILABLE', 'STANDARD', 'MECHANIC');
SELECT (SELECT count(*)::int FROM trkemployee WHERE enum = 902) AS emp,
       (SELECT count(*)::int FROM mechanic    WHERE enum = 902) AS mec,
       (SELECT count(*)::int FROM driver      WHERE enum = 902) AS drv;
ROLLBACK;`,
        verdict: (p) => {
          const r = rowWith(p, 'emp');
          const pass = num(r.emp) === 1 && num(r.mec) === 1 && num(r.drv) === 0;
          return { pass, detail: `employee ${r.emp}, mechanic ${r.mec}, driver ${r.drv}` };
        },
      },
      {
        label: 'rejects a role that does not exist',
        sql: `DO $$
BEGIN
  BEGIN
    CALL add_employee(903, 'Check Bad', NULL, '1 Test St', CURRENT_DATE, 900003, 'AVAILABLE', NULL, 'PILOT');
    RAISE NOTICE 'accepted a role that does not exist';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = '42883' THEN
      RAISE NOTICE 'procedure missing: %', SQLERRM;
    ELSE
      RAISE NOTICE 'rejected: %', SQLERRM;
    END IF;
  END;
END $$;`,
        verdict: (p) => {
          const said = (p.notices || []).join(' ');
          const pass = said.includes('rejected:') && !said.includes('accepted a role') && !said.includes('procedure missing');
          return { pass, detail: pass ? 'raised as expected' : 'the call succeeded' };
        },
      },
      {
        label: 'rejects a licence already used by the other kind',
        sql: `DO $$
BEGIN
  BEGIN
    CALL add_employee(904, 'Check Dup', NULL, '1 Test St', CURRENT_DATE, 10001, 'AVAILABLE', 'STANDARD', 'MECHANIC');
    RAISE NOTICE 'accepted a licence already held by a driver';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = '42883' THEN
      RAISE NOTICE 'procedure missing: %', SQLERRM;
    ELSE
      RAISE NOTICE 'rejected: %', SQLERRM;
    END IF;
  END;
END $$;`,
        verdict: (p) => {
          const said = (p.notices || []).join(' ');
          const pass = said.includes('rejected:') && !said.includes('accepted a licence') && !said.includes('procedure missing');
          return { pass, detail: pass ? 'raised as expected' : 'the call succeeded' };
        },
      },
    ],
  },

  // ------------------------------------------------------------------ triggers
  triggers: {
    label: 'Triggers',
    icon: 'route',
    headline: 'Keep the trip counter honest',
    question:
      'DRIVER.totalTripMade stores how many trips a driver has made. Write a row-level trigger that keeps it correct when trips are added and removed.',
    facts: [
      'A trigger function returns trigger and sees NEW and OLD. NEW is the row being written, OLD the row being replaced or removed. On INSERT, OLD is null; on DELETE, NEW is null.',
      'The trigger itself is a separate CREATE TRIGGER naming the function and the event.',
      'Recompute from TRIP, or keep a running total. Both are defensible; say which you chose and why.',
      'The seed rows already exist, so nothing fires for them. A stored counter starts stale unless you backfill it once.',
    ],
    starter: `-- Task 2.
CREATE OR REPLACE FUNCTION trg_total_trip_made() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- update DRIVER.totalTripMade for the driver this row belongs to
    -- NEW.LNUM on INSERT and UPDATE, OLD.LNUM on DELETE
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER trip_total_trip_made
    AFTER INSERT OR UPDATE OR DELETE ON trip
    FOR EACH ROW
    EXECUTE FUNCTION trg_total_trip_made();

-- Backfill the rows that existed before the trigger:
UPDATE driver d
   SET totalTripMade = (SELECT count(*) FROM trip t WHERE t.lnum = d.lnum);`,
    checks: [
      {
        label: 'a trigger exists on trip',
        sql: `SELECT count(*)::int AS n
                FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
               WHERE NOT t.tgisinternal AND c.relname = 'trip'`,
        verdict: (p) => ({ pass: num(one(p).n) > 0, detail: num(one(p).n) > 0 ? 'found' : 'trip has no trigger' }),
      },
      {
        label: 'counter follows an insert',
        sql: `BEGIN;
INSERT INTO trip (tnum, lnum, regnum, trip_date) VALUES (999, 10001, 'PKR768', CURRENT_DATE);
SELECT d.totalTripMade AS stored,
       (SELECT count(*) FROM trip t WHERE t.lnum = d.lnum) AS actual
  FROM driver d WHERE d.lnum = 10001;
ROLLBACK;`,
        verdict: (p) => {
          const r = rowWith(p, 'stored');
          const pass = !isNull(r.stored) && num(r.stored) === num(r.actual);
          return { pass, detail: `stored ${r.stored ?? 'null'}, actual ${r.actual}` };
        },
      },
      {
        label: 'counter follows a delete',
        sql: `BEGIN;
INSERT INTO trip (tnum, lnum, regnum, trip_date) VALUES (998, 10001, 'PKR768', CURRENT_DATE);
DELETE FROM trip WHERE tnum = 998;
SELECT d.totalTripMade AS stored,
       (SELECT count(*) FROM trip t WHERE t.lnum = d.lnum) AS actual
  FROM driver d WHERE d.lnum = 10001;
ROLLBACK;`,
        verdict: (p) => {
          const r = rowWith(p, 'stored');
          const pass = !isNull(r.stored) && num(r.stored) === num(r.actual);
          return { pass, detail: `stored ${r.stored ?? 'null'}, actual ${r.actual}` };
        },
      },
      {
        label: 'existing rows were backfilled',
        sql: `SELECT count(*)::int AS n
                FROM driver d
               WHERE d.totalTripMade IS DISTINCT FROM
                     (SELECT count(*) FROM trip t WHERE t.lnum = d.lnum)`,
        verdict: (p) => {
          const n = num(one(p).n);
          return { pass: n === 0, detail: n === 0 ? 'every driver agrees with TRIP' : `${n} driver(s) out of step` };
        },
      },
    ],
  },

  // ----------------------------------------------------------------- functions
  functions: {
    label: 'Functions',
    icon: 'grid',
    headline: 'The longest trip',
    question:
      'Write longtrip(lnum) as a stored function. It returns the largest number of legs any one trip of that driver has, and zero if the driver has no trips.',
    facts: [
      'A function returns a value, so it belongs in a SELECT list or WHERE clause. A procedure is called with CALL.',
      'A trip with no legs has no TRIPLEG rows. A LEFT JOIN keeps it visible; count(l.legnum) then counts 0.',
      'max() over an empty set is null. Decide what null should mean for the caller.',
      'STABLE is the right volatility for a function that only reads. It lets the planner call it once per statement.',
    ],
    starter: `-- Task 3.
CREATE OR REPLACE FUNCTION longtrip(p_lnum NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_max NUMERIC;
BEGIN
    -- count the legs of each trip for this driver, take the largest
    -- make sure a driver with no trips returns 0, not null

    RETURN v_max;
END;
$$;

-- Try it:
SELECT e.name, d.lnum, longtrip(d.lnum) AS longest_trip
  FROM driver d
  JOIN trkemployee e ON e.enum = d.enum
 ORDER BY longest_trip DESC;`,
    checks: [
      {
        label: 'longtrip is defined',
        sql: `SELECT count(*)::int AS n FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'longtrip'`,
        verdict: (p) => ({ pass: num(one(p).n) > 0, detail: num(one(p).n) > 0 ? 'found in public' : 'no function with that name' }),
      },
      {
        label: 'longest trip of John Smith (10001)',
        sql: `SELECT longtrip(10001) AS got,
       (SELECT max(legs) FROM (
          SELECT t.tnum, count(l.legnum) AS legs
            FROM trip t LEFT JOIN tripleg l ON l.tnum = t.tnum
           WHERE t.lnum = 10001
           GROUP BY t.tnum) s) AS want`,
        verdict: (p) => {
          const r = rowWith(p, 'got');
          const pass = !isNull(r.got) && num(r.got) === num(r.want);
          return { pass, detail: `got ${r.got ?? 'null'}, expected ${r.want}` };
        },
      },
      {
        label: 'a driver with no trips returns 0',
        sql: `SELECT longtrip(10008) AS got,
       (SELECT count(*) FROM trip t WHERE t.lnum = 10008) AS trips`,
        verdict: (p) => {
          const r = rowWith(p, 'got');
          const pass = num(r.got) === 0;
          return { pass, detail: `got ${r.got ?? 'null'}, that driver has ${r.trips} trip(s)` };
        },
      },
    ],
  },
};

// -------------------------------------------------------------------- editor

let labCm = null;

function labKey(name) {
  return `trk.lab.${name}`;
}

function mountLab(name) {
  const lab = LABS[name];
  labCm = null;
  const box = $('#editor');
  if (!box) return;

  const saved = localStorage.getItem(labKey(name)) || lab.starter;

  if (window.CodeMirror) {
    labCm = CodeMirror.fromTextArea(box, {
      mode: 'text/x-pgsql',
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      matchBrackets: true,
      extraKeys: {
        'Cmd-Enter': () => runWorksheet(name),
        'Ctrl-Enter': () => runWorksheet(name),
        Tab: (i) => i.replaceSelection('    '),
        'Ctrl-Space': 'autocomplete',
      },
      hintOptions: { completeSingle: false },
    });
    labCm.setValue(saved);
    labCm.on('blur', () => localStorage.setItem(labKey(name), labCm.getValue()));
  } else {
    box.value = saved;
    box.style.display = 'block';
  }

  $('#run').onclick = () => runWorksheet(name);
  $('#run-checks').onclick = () => runChecks(name);
  $('#load-starter').onclick = () => {
    setLabValue(name, lab.starter);
    toast('starter loaded');
  };

  if (labCm) setTimeout(() => labCm.refresh(), 0);
}

function labValue() {
  return labCm ? labCm.getValue() : ($('#editor')?.value || '');
}

function setLabValue(name, text) {
  if (labCm) labCm.setValue(text);
  else if ($('#editor')) $('#editor').value = text;
  localStorage.setItem(labKey(name), text);
}

function labOutput(kind, text) {
  const host = $('#lab-output');
  if (!host) return;
  if (host.querySelector('.placeholder')) host.innerHTML = '';
  const line = document.createElement('div');
  line.className = `line ${kind}`;
  line.textContent = text;
  host.appendChild(line);
}

function labOutputReset() {
  const host = $('#lab-output');
  if (host) host.innerHTML = '<p class="placeholder">Notices and errors appear here.</p>';
}

async function runWorksheet(name) {
  const sql = labValue();
  if (!sql.trim()) return;

  localStorage.setItem(labKey(name), sql);
  labOutputReset();
  $('#run').disabled = true;
  $('#run-checks').disabled = true;
  $('#status-left').textContent = 'running…';

  try {
    const payload = await q(sql);
    $('#timing').textContent = `${payload.durationMs} ms`;
    $('#status-left').textContent = payload.ok ? 'ready' : 'error';

    const host = $('#lab-result');
    host.innerHTML = '';

    if (!payload.ok) {
      host.innerHTML = '<p class="placeholder">Statement failed — see output.</p>';
      const e = payload.error;
      labOutput('error', `ERROR: ${e.message}`);
      if (e.detail) labOutput('error', `DETAIL: ${e.detail}`);
      if (e.hint) labOutput('error', `HINT: ${e.hint}`);
      if (e.where) labOutput('error', `at line ${e.where.line}, column ${e.where.column}${e.code ? ` · SQLSTATE ${e.code}` : ''}`);
      return;
    }

    for (const n of payload.notices || []) labOutput('notice', n);

    if (!payload.columns.length) {
      host.innerHTML = `<p class="placeholder">${esc(payload.command || 'OK')} · ${payload.statements} statement(s), no rows.</p>`;
      return;
    }

    const head = payload.columns.map((c) => `<th>${esc(c)}</th>`).join('');
    const body = payload.rows.slice(0, 200)
      .map((row) => `<tr>${payload.columns.map((c) => (isNull(row[c]) ? '<td class="null">NULL</td>' : `<td>${esc(row[c])}</td>`)).join('')}</tr>`)
      .join('');
    host.innerHTML = `<table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  } finally {
    $('#run').disabled = false;
    $('#run-checks').disabled = false;
  }
}

async function runChecks(name) {
  const lab = LABS[name];
  const host = $('#check-results');
  const btn = $('#run-checks');
  btn.disabled = true;
  btn.textContent = 'Running…';
  $('#status-left').textContent = 'checking…';
  host.innerHTML = lab.checks.map((c) => `<div class="check pending"><span class="mark">•</span><span class="label">${esc(c.label)}</span><span class="detail">waiting</span></div>`).join('');

  const out = [];
  for (const check of lab.checks) {
    let verdict;
    try {
      const payload = await q(check.sql);
      if (!payload.ok) verdict = { pass: false, detail: payload.error.message };
      else verdict = check.verdict(payload);
    } catch (err) {
      verdict = { pass: false, detail: String(err.message || err) };
    }
    out.push({ label: check.label, ...verdict });
    host.innerHTML = out
      .map((r) => `<div class="check ${r.pass ? 'pass' : 'fail'}"><span class="mark">${r.pass ? '✓' : '✕'}</span><span class="label">${esc(r.label)}</span><span class="detail">${esc(r.detail)}</span></div>`)
      .join('');
    $('#status-left').textContent = 'checking…';
  }

  const passed = out.filter((r) => r.pass).length;
  $('#status-left').textContent = `${passed}/${out.length} checks pass`;
  toast(`${passed} of ${out.length} checks pass`, passed !== out.length);
  btn.disabled = false;
  btn.textContent = 'Run checks';
}


// ----------------------------------------------------------------- cards+dock
//
// The fleet is shown as cards. Underneath, one SQL editor stays open: run a
// statement and the cards re-read themselves, so you see the effect immediately.

const DOCK_STARTER = `-- Change something and watch the cards move.
-- Try hiring a driver, then look at the Drivers row.
SELECT e.enum, e.name, d.lnum, d.status, d.totalTripMade
  FROM driver d
  JOIN trkemployee e ON e.enum = d.enum
 ORDER BY d.enum;`;

let dockCm = null;

function dockMarkup() {
  return `
    <section class="dock" id="dock">
      <div class="dock-head">
        <button id="dock-toggle" class="dock-toggle"><span class="dock-dot"></span>SQL</button>
        <span class="dock-hint">edit, run, the cards follow</span>
        <span class="spacer"></span>
        <span id="dock-status" class="mono"></span>
        <button id="dock-reset" class="btn quiet tiny">reset</button>
      </div>
      <div class="dock-body" id="dock-body">
        <div class="dock-editor"><textarea id="dock-editor" spellcheck="false"></textarea></div>
        <div class="dock-side">
          <button id="dock-run" class="btn primary">Run</button>
          <div id="dock-out" class="dock-out"><p class="placeholder">Rows and errors appear here.</p></div>
        </div>
      </div>
    </section>`;
}

function mountDock() {
  dockCm = null;
  const box = $('#dock-editor');
  if (!box) return;

  const saved = localStorage.getItem('trk.dock') || DOCK_STARTER;
  dockCm = CodeMirror.fromTextArea(box, {
    mode: 'text/x-pgsql',
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    extraKeys: {
      'Cmd-Enter': () => dockRun(),
      'Ctrl-Enter': () => dockRun(),
      Tab: (i) => i.replaceSelection('  '),
    },
  });
  dockCm.setValue(saved);
  dockCm.on('blur', () => localStorage.setItem('trk.dock', dockCm.getValue()));

  $('#dock-run').onclick = () => dockRun();
  $('#dock-reset').onclick = () => {
    dockCm.setValue(DOCK_STARTER);
    localStorage.setItem('trk.dock', DOCK_STARTER);
  };
  $('#dock-toggle').onclick = () => {
    const body = $('#dock-body');
    body.classList.toggle('closed');
    if (!body.classList.contains('closed')) setTimeout(() => dockCm.refresh(), 0);
  };

  setTimeout(() => dockCm.refresh(), 0);
}

function dockResult(message, kind = 'meta') {
  const host = $('#dock-out');
  if (!host) return;
  host.innerHTML = '';
  const line = document.createElement('div');
  line.className = `line ${kind}`;
  line.textContent = message;
  host.appendChild(line);
}

async function dockRun() {
  if (!dockCm) return;
  const sql = dockCm.getValue();
  if (!sql.trim()) return;
  localStorage.setItem('trk.dock', sql);

  const btn = $('#dock-run');
  btn.disabled = true;
  $('#dock-status').textContent = 'running…';

  try {
    const out = await q(sql);
    const host = $('#dock-out');
    host.innerHTML = '';

    if (!out.ok) {
      $('#dock-status').textContent = `${out.durationMs} ms · error`;
      const e = out.error;
      const line = document.createElement('div');
      line.className = 'line error';
      line.textContent = `ERROR: ${e.message}${e.where ? ` (line ${e.where.line}, column ${e.where.column})` : ''}`;
      host.appendChild(line);
      return;
    }

    for (const n of out.notices || []) {
      const line = document.createElement('div');
      line.className = 'line notice';
      line.textContent = n;
      host.appendChild(line);
    }

    if (out.columns.length) {
      const shown = out.rows.slice(0, 8);
      const head = out.columns.map((c) => `<th>${esc(c)}</th>`).join('');
      const body = shown
        .map((row) => `<tr>${out.columns.map((c) => (isNull(row[c]) ? '<td class="null">NULL</td>' : `<td>${esc(row[c])}</td>`)).join('')}</tr>`)
        .join('');
      host.insertAdjacentHTML('beforeend', `<table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
    } else {
      const line = document.createElement('div');
      line.className = 'line meta';
      line.textContent = `${out.command || 'OK'} · ${out.statements} statement(s)`;
      host.appendChild(line);
    }

    $('#dock-status').textContent = `${out.durationMs} ms · ${out.rowCount} rows`;
    await Promise.all([renderCards(), refreshState()]);
  } finally {
    btn.disabled = false;
  }
}

function driverCard(r, longest) {
  const stale = num(r.counter) !== num(r.trips);
  return `
    <article class="card person">
      <div class="card-top">
        ${avatar(r.name).replace('class="avatar"', 'class="avatar lg"')}
        <div class="card-id"><strong>${esc(r.name)}</strong><span class="mono">${esc(r.lnum)}</span></div>
        ${badge(r.status)}
      </div>
      <div class="card-stats">
        <div><span class="v">${fmtNumber(r.trips)}</span><span class="k">trips</span></div>
        <div><span class="v ${stale && !isNull(r.counter) ? 'warn' : ''} ${isNull(r.counter) ? 'unset' : ''}">${isNull(r.counter) ? '—' : fmtNumber(r.counter)}</span><span class="k">counter</span></div>
        <div><span class="v">${longest === null ? '—' : fmtNumber(longest)}</span><span class="k">longest</span></div>
      </div>
      <div class="card-foot">${stale ? '<span class="badge warn">counter stale</span>' : '<span class="badge ok">in step</span>'}</div>
    </article>`;
}

function truckCard(r) {
  return `
    <article class="card truck">
      <div class="card-top">
        <strong class="mono rego">${esc(r.regnum)}</strong>
        ${badge(r.status)}
      </div>
      <div class="card-stats">
        <div><span class="v">${fmtNumber(r.trips)}</span><span class="k">trips</span></div>
        <div><span class="v">${fmtNumber(r.services)}</span><span class="k">services</span></div>
        <div><span class="v">${fmtNumber(r.capacity)}</span><span class="k">capacity</span></div>
      </div>
      <div class="card-foot">last service ${esc(fmtDate(r.last_service))}</div>
    </article>`;
}

function tripCard(r) {
  return `
    <article class="card trip">
      <div class="card-top">
        <strong>Trip ${esc(r.tnum)}</strong>
        <span class="muted date">${esc(fmtDate(r.trip_date))}</span>
      </div>
      <div class="who">${avatar(r.driver)}${esc(r.driver)}<span class="mono truck-tag">${esc(r.regnum)}</span></div>
      <div class="card-route">${ribbon(r.route)}</div>
    </article>`;
}

async function renderCards() {
  const host = $('#cards');
  if (!host) return;

  const [d, t, trips, longest, totals] = await Promise.all([
    q(`SELECT e.enum, e.name, d.lnum, d.status, d.totalTripMade AS counter,
              (SELECT count(*) FROM trip x WHERE x.lnum = d.lnum) AS trips
         FROM driver d JOIN trkemployee e ON e.enum = d.enum
        ORDER BY e.name`),
    q(`SELECT t.regnum, t.status, t.capacity,
              (SELECT count(*) FROM trip x WHERE x.regnum = t.regnum) AS trips,
              (SELECT count(*) FROM maintenance m WHERE m.regnum = t.regnum) AS services,
              (SELECT max(m.maintenance_date) FROM maintenance m WHERE m.regnum = t.regnum) AS last_service
         FROM truck t ORDER BY t.status, t.regnum`),
    q(`SELECT t.tnum, t.trip_date, e.name AS driver, t.regnum,
              (SELECT string_agg(l.departure || ' → ' || l.destination, ' → ' ORDER BY l.legnum)
                 FROM tripleg l WHERE l.tnum = t.tnum) AS route
         FROM trip t
         JOIN driver d ON d.lnum = t.lnum
         JOIN trkemployee e ON e.enum = d.enum
        ORDER BY t.trip_date DESC, t.tnum DESC LIMIT 6`),
    q(`SELECT d.lnum, longtrip(d.lnum) AS longest FROM driver d`),
    q(`SELECT count(*)::int AS n FROM trip`),
  ]);

  if (!d.ok) {
    host.innerHTML = errorView(d);
    return;
  }

  const longestMap = new Map();
  if (longest.ok) for (const r of longest.rows) longestMap.set(r.lnum, r.longest);

  const drivers = d.rows || [];
  const stale = drivers.filter((r) => num(r.counter) !== num(r.trips)).length;

  host.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="value">${fmtNumber(drivers.length)}</div><div class="label">drivers</div><div class="note">${drivers.filter((r) => r.status === 'AVAILABLE').length} available</div></div>
      <div class="kpi"><div class="value">${fmtNumber((t.rows || []).length)}</div><div class="label">trucks</div></div>
      <div class="kpi"><div class="value">${totals.ok ? fmtNumber(totals.rows[0].n) : '—'}</div><div class="label">trips recorded</div><div class="note">six newest below</div></div>
      <div class="kpi"><div class="value ${stale ? 'warn' : ''}">${stale}</div><div class="label">counters out of step</div><div class="note">${stale ? 'the trigger lab fixes this' : 'every counter agrees with TRIP'}</div></div>
    </div>

    <h2 class="section">Drivers <span>${drivers.length}</span></h2>
    <div class="cards">${drivers.map((r) => driverCard(r, longest.ok ? longestMap.get(r.lnum) : null)).join('')}</div>

    <h2 class="section">Trucks <span>${(t.rows || []).length}</span></h2>
    <div class="cards">${(t.rows || []).map(truckCard).join('')}</div>

    <h2 class="section">Recent trips <span>${(trips.rows || []).length}</span></h2>
    <div class="cards trips">${(trips.rows || []).map(tripCard).join('')}</div>

    ${peek(`SELECT e.name, d.lnum, d.totalTripMade,
       (SELECT count(*) FROM trip t WHERE t.lnum = d.lnum) AS trips
  FROM driver d JOIN trkemployee e ON e.enum = d.enum
 ORDER BY e.name;`)}`;

  host.querySelectorAll('[data-open-console]').forEach((b) => {
    b.onclick = () => {
      const sql = b.closest('.peek').querySelector('pre').textContent;
      sessionStorage.setItem('trk.pending', sql);
      show('console');
    };
  });
}

// --------------------------------------------------------------------- views

const VIEWS = {

  fleet: {
    label: 'Fleet',
    icon: 'user',
    async render() {
      return `
        <div class="view-head">
          <div><h1>The fleet</h1><p class="sub">Real rows from the seed. Write SQL below and watch the cards change.</p></div>
        </div>
        <div id="cards"><p class="placeholder">Loading…</p></div>
        ${dockMarkup()}`;
    },
    mount() {
      mountDock();
      renderCards();
    },
  },

  procedures: { label: 'Procedures', icon: 'wrench', lab: 'procedures' },
  triggers: { label: 'Triggers', icon: 'route', lab: 'triggers' },
  functions: { label: 'Functions', icon: 'grid', lab: 'functions' },

  console: {
    label: 'Console',
    icon: 'terminal',
    async render() {
      return `
        <div class="view-head"><div><h1>Console</h1><p class="sub">Free SQL against the live schema.</p></div></div>
        <div class="console">
          <section class="pane editor">
            <div class="pane-head"><span class="pane-name">scratch.sql</span><span class="pane-hint">⌘↵ run · ⌘⇧↵ selection</span></div>
            <div class="editor-host"><textarea id="editor" spellcheck="false"></textarea></div>
            <div class="pane-foot">
              <button id="run" class="btn primary">Run</button>
              <button id="run-selection" class="btn quiet">Run selection</button>
              <span class="spacer"></span>
              <button class="btn quiet" data-apply="task1">solution1</button>
              <button class="btn quiet" data-apply="task2">solution2</button>
              <button class="btn quiet" data-apply="task3">solution3</button>
            </div>
          </section>
          <section class="pane results">
            <div class="pane-head"><span class="pane-name">result</span><span id="result-meta" class="pane-hint"></span></div>
            <div id="result" class="result"><p class="placeholder">No query yet.</p></div>
          </section>
          <section class="pane output">
            <div class="pane-head"><span class="pane-name">output</span><button id="clear-output" class="btn quiet tiny">clear</button></div>
            <div id="output" class="output"><p class="placeholder">Notices and errors.</p></div>
          </section>
        </div>`;
    },
    mount() {
      mountConsole();
    },
  },
};

// Render the shared lab layout.
function labView(name) {
  const lab = LABS[name];

  const brief = `
    <aside class="brief">
      <h2>${esc(lab.headline)}</h2>
      <p class="brief-q">${esc(lab.question)}</p>

      <h3>What you need to know</h3>
      <ul>${lab.facts.map((f) => `<li>${f}</li>`).join('')}</ul>

      <h3>How this is marked</h3>
      <p class="brief-q">Run checks when you think it works. Each check runs against your own database and rolls itself back.</p>

      <button class="btn" id="load-starter-2">Load the starter</button>
    </aside>`;

  return `
    <div class="view-head">
      <div><h1>${esc(lab.label)}</h1><p class="sub">${esc(lab.headline)} — write it, run it, check it.</p></div>
    </div>

    <div class="lab">
      ${brief}

      <div class="lab-main">
        <section class="pane worksheet">
          <div class="pane-head"><span class="pane-name">worksheet.sql</span><span class="pane-hint">⌘↵ runs the whole file</span></div>
          <div class="editor-host"><textarea id="editor" spellcheck="false"></textarea></div>
          <div class="pane-foot">
            <button id="run" class="btn primary">Run</button>
            <button id="run-checks" class="btn">Run checks</button>
            <span class="spacer"></span>
            <button id="load-starter" class="btn quiet">Reset to starter</button>
          </div>
        </section>

        <div class="panel checks">
          <div class="panel-head"><span class="panel-title">Checks</span><span class="panel-note">each runs in a transaction, then rolls back</span></div>
          <div id="check-results"><p class="placeholder">Run checks to see where you stand.</p></div>
        </div>

        <div class="panel lab-out">
          <div class="panel-head"><span class="panel-title">Output</span><span class="panel-note">result rows, notices, errors</span></div>
          <div id="lab-result" class="result"><p class="placeholder">Rows from the last run.</p></div>
          <div id="lab-output" class="output"><p class="placeholder">Notices and errors appear here.</p></div>
        </div>
      </div>
    </div>`;
}

// ------------------------------------------------------------------- console

const STARTER = `-- What does the fleet look like right now?
SELECT d.enum, e.name, d.lnum, d.status, d.totalTripMade
  FROM driver d
  JOIN trkemployee e ON e.enum = d.enum
 ORDER BY d.enum;`;

let cm = null;

function editorValue() {
  return cm ? cm.getValue() : ($('#editor')?.value || '');
}

function setEditorValue(text) {
  if (cm) cm.setValue(text);
  else if ($('#editor')) $('#editor').value = text;
  localStorage.setItem('trk.query', text);
}

function selectedText() {
  if (cm) return cm.getSelection();
  const box = $('#editor');
  if (!box) return '';
  return box.value.slice(box.selectionStart, box.selectionEnd);
}

function mountConsole() {
  cm = null;
  const box = $('#editor');
  if (!box) return;

  const saved = localStorage.getItem('trk.query') || STARTER;

  if (window.CodeMirror) {
    cm = CodeMirror.fromTextArea(box, {
      mode: 'text/x-pgsql',
      lineNumbers: true,
      indentUnit: 2,
      tabSize: 2,
      matchBrackets: true,
      autofocus: true,
      extraKeys: {
        'Cmd-Enter': () => runQuery(false),
        'Ctrl-Enter': () => runQuery(false),
        'Cmd-Shift-Enter': () => runQuery(true),
        'Ctrl-Shift-Enter': () => runQuery(true),
        Tab: (i) => i.replaceSelection('  '),
        'Ctrl-Space': 'autocomplete',
      },
      hintOptions: { completeSingle: false },
    });
    cm.setValue(saved);
    cm.on('blur', () => localStorage.setItem('trk.query', cm.getValue()));
  } else {
    box.value = saved;
    box.style.display = 'block';
  }

  $('#run').onclick = () => runQuery(false);
  $('#run-selection').onclick = () => runQuery(true);
  $('#clear-output').onclick = () => outputReset();
  document.querySelectorAll('[data-apply]').forEach((b) => {
    b.onclick = () => applyScript(b.dataset.apply);
  });

  const pending = sessionStorage.getItem('trk.pending');
  if (pending) {
    sessionStorage.removeItem('trk.pending');
    setEditorValue(pending);
  }

  if (cm) setTimeout(() => cm.refresh(), 0);
}

function outputReset() {
  const out = $('#output');
  if (out) out.innerHTML = '<p class="placeholder">Notices and errors.</p>';
}

function addOutput(kind, text) {
  const out = $('#output');
  if (!out) return;
  if (out.querySelector('.placeholder')) out.innerHTML = '';
  const line = document.createElement('div');
  line.className = `line ${kind}`;
  line.textContent = text;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

function renderRows(payload) {
  const host = $('#result');
  const meta = $('#result-meta');
  if (!host) return;
  host.innerHTML = '';
  meta.textContent = '';

  if (!payload.ok) {
    host.innerHTML = '<p class="placeholder">Query failed — see output.</p>';
    return;
  }
  if (!payload.columns.length) {
    host.innerHTML = `<p class="placeholder">${esc(payload.command || 'OK')} — ${payload.statements} statement(s), no rows returned.</p>`;
    meta.textContent = '0 rows';
    return;
  }

  const shown = payload.rows.slice(0, 500);
  const head = payload.columns.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = shown
    .map((row) => `<tr>${payload.columns.map((c) => (isNull(row[c]) ? '<td class="null">NULL</td>' : `<td>${esc(row[c])}</td>`)).join('')}</tr>`)
    .join('');

  host.innerHTML = `<table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  meta.textContent = payload.rows.length > shown.length
    ? `${payload.rowCount} rows · first ${shown.length}`
    : `${payload.rowCount} rows`;
}

async function runQuery(selectionOnly) {
  const text = selectionOnly ? selectedText() || editorValue() : editorValue();
  if (!text.trim()) return;

  $('#run').disabled = true;
  $('#run-selection').disabled = true;
  $('#status-left').textContent = 'running…';
  outputReset();

  try {
    const payload = await api('/api/query', { sql: text });
    $('#timing').textContent = `${payload.durationMs} ms`;
    $('#status-left').textContent = payload.ok ? 'ready' : 'error';
    renderRows(payload);

    for (const n of payload.notices || []) addOutput('notice', n);

    if (!payload.ok) {
      const e = payload.error;
      addOutput('error', `ERROR: ${e.message}`);
      if (e.detail) addOutput('error', `DETAIL: ${e.detail}`);
      if (e.hint) addOutput('error', `HINT: ${e.hint}`);
      if (e.where) addOutput('error', `at line ${e.where.line}, column ${e.where.column}${e.code ? ` · SQLSTATE ${e.code}` : ''}`);
      if (cm && e.position) cm.setCursor(cm.posFromIndex(e.position - 1));
    }

    localStorage.setItem('trk.query', editorValue());
  } finally {
    $('#run').disabled = false;
    $('#run-selection').disabled = false;
  }
}

async function applyScript(task) {
  $('#status-left').textContent = `applying ${task}…`;
  const out = await api('/api/apply', { task });
  outputReset();
  if (out.ok) {
    for (const n of out.notices || []) addOutput('notice', n);
    addOutput('meta', `${task} applied · ${out.statements} statement(s) · ${out.durationMs} ms`);
    toast(`${task} applied`);
    renderRows(out);
  } else {
    addOutput('error', `ERROR: ${out.error.message}`);
    if (out.error.where) addOutput('error', `at line ${out.error.where.line}, column ${out.error.where.column}`);
    toast(`${task} failed`, true);
  }
  $('#status-left').textContent = 'ready';
  await refreshState();
}

// ---------------------------------------------------------------------- shell

function errorView(payload) {
  return `<div class="empty-state">
    <h2>That query did not run</h2>
    <p>${esc(payload.error?.message || 'unknown error')}</p>
  </div>`;
}

function icon(name) {
  const paths = {
    grid: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="11" y="3" width="6" height="6" rx="1"/><rect x="3" y="11" width="6" height="6" rx="1"/><rect x="11" y="11" width="6" height="6" rx="1"/>',
    user: '<circle cx="10" cy="7" r="3"/><path d="M4 17c0-3 2.7-5 6-5s6 2 6 5"/>',
    route: '<circle cx="5" cy="15" r="2"/><circle cx="15" cy="5" r="2"/><path d="M7 15h4a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h4"/>',
    wrench: '<path d="M13.5 3a4 4 0 0 0-3.9 5.1L3 14.7 5.3 17l6.6-6.6A4 4 0 0 0 17 6.5L14.5 9 11 5.5z"/>',
    terminal: '<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M6 8l3 2-3 2"/><path d="M10.5 12h4"/>',
  };
  return `<svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.grid}</svg>`;
}

let current = 'fleet';

async function show(name) {
  current = name;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));

  const view = VIEWS[name];
  const host = $('#view');
  host.className = 'view' + (name === 'console' ? ' console-mode' : name === 'fleet' ? '' : ' lab-mode');
  host.innerHTML = '<p class="placeholder">Loading…</p>';

  try {
    host.innerHTML = view.lab ? labView(view.lab) : await view.render();
    if (view.lab) {
      mountLab(view.lab);
      const alt = document.getElementById('load-starter-2');
      if (alt) alt.onclick = () => {
        setLabValue(view.lab, LABS[view.lab].starter);
        toast('starter loaded');
      };
    }
    if (view.mount) view.mount();

    host.querySelectorAll('[data-open-console]').forEach((b) => {
      b.onclick = () => {
        const sql = b.closest('.peek').querySelector('pre').textContent;
        sessionStorage.setItem('trk.pending', sql);
        show('console');
      };
    });
  } catch (err) {
    host.innerHTML = `<div class="empty-state"><h2>Could not load</h2><p>${esc(err.message || err)}</p></div>`;
  }
  host.scrollTop = 0;
}

function renderNav() {
  $('#nav').innerHTML = Object.entries(VIEWS)
    .map(([key, v]) => `<button data-view="${key}">${icon(v.icon)}<span>${esc(v.label)}</span></button>`)
    .join('');
  document.querySelectorAll('#nav button').forEach((b) => {
    b.onclick = () => show(b.dataset.view);
  });
}

async function refreshState() {
  try {
    const state = await api('/api/state');
    $('#status-dot').className = 'dot ' + (state.seeded ? 'ok' : 'bad');
    $('#status-text').textContent = state.seeded ? `pg ${state.serverVersion}` : 'empty';
    $('#status-left').textContent = state.seeded ? 'ready' : 'no fixture loaded';

    const list = $('#list-tables');
    if (!state.seeded) {
      list.innerHTML = '<li class="empty">no tables</li>';
      return state;
    }
    list.innerHTML = state.tables
      .map((t) => `<li><button data-table="${esc(t.name)}">${esc(t.name)}<span class="n">${t.rows}</span></button></li>`)
      .join('');
    list.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        sessionStorage.setItem('trk.pending', `SELECT * FROM ${b.dataset.table} LIMIT 100;`);
        show('console');
      };
    });
    return state;
  } catch {
    $('#status-dot').className = 'dot bad';
    $('#status-text').textContent = 'offline';
    return null;
  }
}

async function reseed() {
  if (!confirm('Drop schema public and replay the seed file? Anything you created disappears.')) return;
  $('#reseed').disabled = true;
  $('#status-left').textContent = 'reseed…';
  try {
    const out = await api('/api/reseed', {});
    if (out.ok) {
      toast('Fixture reloaded');
      await refreshState();
      show(current);
    } else {
      toast('Reseed failed', true);
      $('#status-left').textContent = out.error?.message || 'reseed failed';
    }
  } finally {
    $('#reseed').disabled = false;
  }
}

// ---------------------------------------------------------------------- start

async function start() {
  const today = new Date();
  $('#today').textContent = today.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  renderNav();
  $('#reseed').onclick = reseed;
  $('#filter').oninput = () => {
    const term = $('#filter').value.trim().toLowerCase();
    document.querySelectorAll('#list-tables button').forEach((b) => {
      b.parentElement.style.display = !term || b.dataset.table.includes(term) ? '' : 'none';
    });
  };

  const state = await refreshState();
  if (state && !state.seeded) {
    $('#view').innerHTML = `<div class="empty-state">
      <h2>No fixture in this database</h2>
      <p>Press Reseed to load dbCreateTruck-2026S4.sql.</p>
    </div>`;
    return;
  }
  show('fleet');
}

start();
setInterval(refreshState, 20000);
