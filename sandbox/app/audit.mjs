// The world engine.
//
// One idea: the depot is a clone of the seed, and every tick is one generated
// statement committed against it. After each tick the invariants are read back,
// so the panel on screen is the database, not a model of it.
//
// The map is built the same way. Cities are the ends of the routes in TRIPLEG,
// placed on a ring by angle. Trucks are TRIP rows. Nothing is hand-drawn.
//
// Clones are schemas, not databases. Dropping a schema is cheap, they can run
// side by side, and the pool never has to reconnect. Every request sets
// search_path explicitly, because pooled connections are reused across schemas.
//
// Determinism: every stream is generated from a seed. The same seed and the
// same starting rows produce the same statements in the same order, so a
// failure at tick 231 can be replayed exactly.

import { randomUUID } from 'node:crypto';
import { runScript } from './sqltext.mjs';

// ------------------------------------------------------------------ randomness

// mulberry32. Small, fast, and the same on every platform. Math.random is not
// allowed anywhere in this file: a learner who cannot reproduce a failure
// cannot learn from it.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One stream per tick, derived from the run seed and the tick number. Ticks are
// therefore independent: replaying from tick 0 or from tick 200 agrees.
export function tickSeed(seed, index) {
  return ((seed * 2654435761) ^ (index * 40503)) >>> 0;
}

const pickOne = (r, list) => list[Math.floor(r() * list.length) % list.length];

// ------------------------------------------------------------------- the rules
//
// These are the invariants the whole thing grades against. Each is a count that
// must stay at zero. `IS DISTINCT FROM` everywhere: totalTripMade is nullable,
// so a null counter must count as drift, not slip past a `<>`.

const SAMPLE_SQL = `
SELECT
  (SELECT count(*)::int FROM driver d
    WHERE d.totalTripMade IS DISTINCT FROM
          (SELECT count(*) FROM trip t WHERE t.lnum = d.lnum)
      -- A driver who has never driven has nothing to count: a null counter is
      -- not a disagreement, it is an empty history.
      AND NOT (d.totalTripMade IS NULL
               AND NOT EXISTS (SELECT 1 FROM trip t WHERE t.lnum = d.lnum)))  AS drift,
  (SELECT count(*)::int FROM driver d
     JOIN mechanic m ON m.enum = d.enum)                                      AS overlap_enum,
  (SELECT count(*)::int FROM driver d
     JOIN mechanic m ON m.lnum = d.lnum)                                      AS overlap_lnum,
  (SELECT count(*)::int FROM trkemployee e
    WHERE NOT EXISTS (SELECT 1 FROM driver   d WHERE d.enum = e.enum)
      AND NOT EXISTS (SELECT 1 FROM mechanic m WHERE m.enum = e.enum))        AS orphans,
  (SELECT count(*)::int FROM driver d
    WHERE d.totalTripMade IS NULL
      AND EXISTS (SELECT 1 FROM trip t WHERE t.lnum = d.lnum))                AS nulls,
  (SELECT count(*)::int FROM trip)                                            AS trips,
  (SELECT count(*)::int FROM trkemployee)                                     AS employees
`;

export async function sampleInvariants(client, keys = ['drift', 'overlap', 'orphans', 'nulls']) {
  const { rows } = await client.query(SAMPLE_SQL);
  const row = rows[0] || {};
  const values = {
    drift: Number(row.drift) || 0,
    overlap: (Number(row.overlap_enum) || 0) + (Number(row.overlap_lnum) || 0),
    orphans: Number(row.orphans) || 0,
    nulls: Number(row.nulls) || 0,
  };
  return {
    ...values,
    // A mission only grades the invariants it is about. A procedure run must
    // not be failed for counter drift: the counter is another mission's job.
    clean: keys.every((k) => (values[k] || 0) === 0),
    trips: Number(row.trips) || 0,
    employees: Number(row.employees) || 0,
  };
}

// The seed already contains one employee row that is neither a driver nor a
// mechanic. That is the fixture's business, not the learner's, so orphans and
// null counters are graded as a change from the clone's own baseline.
function adjust(sample, offset) {
  return {
    ...sample,
    orphans: Math.max(0, sample.orphans - (offset?.orphans || 0)),
    nulls: Math.max(0, sample.nulls - (offset?.nulls || 0)),
  };
}

function judge(sample, offset, keys) {
  const adjusted = adjust(sample, offset);
  adjusted.clean = keys.every((k) => (adjusted[k] || 0) === 0);
  return adjusted;
}

// --------------------------------------------------------------------- events
//
// An event is one statement plus what the engine expects of it:
//   expect 'ok'      it must run clean
//   expect 'reject'  it must raise; succeeding is the bug
//   expect 'value'   it must return got = want
//
// Every event carries `why`: the sentence shown to the learner when it fails.
// A failure without a reason is a bug report nobody can act on.

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function context(client) {
  const list = async (sql) => (await client.query(sql)).rows.map((r) => String(r.v));
  return {
    client,
    drivers: () => list('SELECT lnum::text AS v FROM driver ORDER BY lnum'),
    trucks: () => list('SELECT regnum::text AS v FROM truck ORDER BY regnum'),
    trips: () => list('SELECT tnum::text AS v FROM trip ORDER BY tnum'),
    maxTrip: async () => Number((await client.query('SELECT coalesce(max(tnum),0)::int AS v FROM trip')).rows[0].v),
    lonely: () =>
      list(`SELECT lnum::text AS v FROM driver d
             WHERE NOT EXISTS (SELECT 1 FROM trip t WHERE t.lnum = d.lnum)
             ORDER BY lnum`),
    anyDriverLnum: () => list('SELECT lnum::text AS v FROM driver ORDER BY lnum'),
  };
}

function hireSql(enumId, lnum, role, experience, status = 'AVAILABLE', name = 'Audit Hire') {
  const exp = experience === null ? 'NULL' : quote(experience);
  return `CALL add_employee(${enumId}, ${quote(name)}, DATE '1991-02-03', '9 Audit St, Sydney NSW 2000',
        CURRENT_DATE, ${lnum}, ${quote(status)}, ${exp}, ${quote(role)})`;
}

const EVENTS = {
  async arrival(ctx, r) {
    const [d] = [pickOne(r, await ctx.drivers())];
    const truck = pickOne(r, await ctx.trucks());
    const tnum = (await ctx.maxTrip()) + 1;
    return {
      label: 'arrival',
      sql: `INSERT INTO trip (tnum, lnum, regnum, trip_date) VALUES (${tnum}, ${d}, ${quote(truck)}, CURRENT_DATE)`,
      expect: 'ok',
      watch: [d],
      why: 'a trip lands for a driver; totalTripMade must equal the number of trips that driver has',
    };
  },

  async cancellation(ctx, r) {
    const trips = await ctx.trips();
    if (!trips.length) return { label: 'cancellation', sql: 'SELECT 1', expect: 'ok', why: 'nothing to cancel' };
    const tnum = pickOne(r, trips);
    return {
      label: 'cancellation',
      // TRIPLEG holds an FK to TRIP, so a cancelled trip takes its legs with
      // it. Two statements, one transaction: the legs go first.
      sql: `DELETE FROM tripleg WHERE tnum = ${tnum};
            DELETE FROM trip    WHERE tnum = ${tnum};`,
      expect: 'ok',
      watch: [String((await ctx.client.query('SELECT lnum::text AS v FROM trip WHERE tnum = $1', [tnum])).rows[0]?.v ?? '')].filter(Boolean),
      why: 'a trip is cancelled; the counter must drop by one. A trigger that only fires on INSERT fails here',
    };
  },

  async reassignment(ctx, r) {
    const trips = await ctx.trips();
    const drivers = await ctx.drivers();
    if (!trips.length || drivers.length < 2) return { label: 'reassignment', sql: 'SELECT 1', expect: 'ok', why: 'nothing to move' };
    const tnum = pickOne(r, trips);
    const lnum = pickOne(r, drivers);
    return {
      label: 'reassignment',
      sql: `UPDATE trip SET lnum = ${lnum} WHERE tnum = ${tnum} AND lnum <> ${lnum}`,
      expect: 'ok',
      watch: [
        lnum,
        ...(await ctx.client.query('SELECT lnum::text AS v FROM trip WHERE tnum = $1', [tnum])).rows.map((x) => x.v),
      ],
      why: 'a trip moves to another driver; both counters must move. A trigger without an UPDATE branch fails here',
    };
  },

  async bulk_cancel(ctx, r) {
    const trips = await ctx.trips();
    if (!trips.length) return { label: 'bulk cancellation', sql: 'SELECT 1', expect: 'ok', why: 'nothing to cancel' };
    const tnum = pickOne(r, trips);
    return {
      label: 'bulk cancellation',
      sql: `DELETE FROM tripleg WHERE tnum IN (SELECT tnum FROM trip
                WHERE lnum = (SELECT lnum FROM trip WHERE tnum = ${tnum}));
            DELETE FROM trip WHERE lnum = (SELECT lnum FROM trip WHERE tnum = ${tnum});`,
      expect: 'ok',
      watch: (await ctx.client.query('SELECT lnum::text AS v FROM trip WHERE tnum = $1', [tnum])).rows.map((x) => x.v),
      why: 'every trip of one driver is cancelled at once; the counter must follow each row',
    };
  },

  async hire(ctx, r, i) {
    const role = r() < 0.7 ? 'DRIVER' : 'MECHANIC';
    return {
      label: `hire (${role.toLowerCase()})`,
      sql: hireSql(80000 + i, 8000000 + i, role, role === 'MECHANIC' ? 'STANDARD' : null),
      expect: 'ok',
      employee: { enum: 80000 + i, role },
      why: 'a valid hire must land one TRKEMPLOYEE row and one matching DRIVER or MECHANIC row',
    };
  },

  async licence_collision(ctx, r) {
    const lnum = pickOne(r, await ctx.anyDriverLnum());
    return {
      label: 'licence collision',
      sql: hireSql(86000 + Math.floor(r() * 900), lnum, 'MECHANIC', 'STANDARD', 'AVAILABLE', 'Collision Hire'),
      expect: 'reject',
      why: 'a licence that already belongs to a driver cannot be given to a mechanic; the call must raise',
    };
  },

  async duplicate_enum(ctx, r) {
    const lnum = 8100000 + Math.floor(r() * 900);
    return {
      label: 'duplicate employee id',
      sql: `CALL add_employee(1, 'Second John', NULL, '1 Audit St', CURRENT_DATE, ${lnum}, 'AVAILABLE', NULL, 'DRIVER')`,
      expect: 'reject',
      why: 'employee 1 already exists; the call must raise rather than violate the primary key',
    };
  },

  async bad_role(ctx, r) {
    return {
      label: 'unknown role',
      sql: `CALL add_employee(${82000 + Math.floor(r() * 900)}, 'Pilot Hire', NULL, '1 Audit St', CURRENT_DATE, ${8200000 + Math.floor(r() * 900)}, 'AVAILABLE', NULL, 'PILOT')`,
      expect: 'reject',
      why: 'PILOT is neither DRIVER nor MECHANIC; the call must raise',
    };
  },

  async driver_with_experience(ctx, r) {
    return {
      label: 'driver with experience',
      sql: `CALL add_employee(${83000 + Math.floor(r() * 900)}, 'Exp Driver', NULL, '1 Audit St', CURRENT_DATE, ${8300000 + Math.floor(r() * 900)}, 'AVAILABLE', 'EXPERT', 'DRIVER')`,
      expect: 'reject',
      why: 'MECHANIC has an experience level and DRIVER does not; a driver carrying one is a row that cannot exist',
    };
  },

  async mechanic_without_experience(ctx, r) {
    return {
      label: 'mechanic without experience',
      sql: `CALL add_employee(${84000 + Math.floor(r() * 900)}, 'No Exp Mech', NULL, '1 Audit St', CURRENT_DATE, ${8400000 + Math.floor(r() * 900)}, 'AVAILABLE', NULL, 'MECHANIC')`,
      expect: 'reject',
      why: 'a mechanic needs an experience level; the call must raise rather than fail the NOT NULL check',
    };
  },

  async longtrip(ctx, r) {
    const lonely = await ctx.lonely();
    const drivers = await ctx.drivers();
    // Half the calls hit a driver with no trips, because that is the case the
    // brief calls out and the case an empty max() returns null for.
    const lnum = lonely.length && r() < 0.5 ? pickOne(r, lonely) : pickOne(r, drivers);
    return {
      label: `longtrip(${lnum})`,
      sql: `SELECT longtrip(${lnum}) AS got,
                   coalesce((SELECT max(legs) FROM (
                     SELECT count(l.legnum) AS legs
                       FROM trip t LEFT JOIN tripleg l ON l.tnum = t.tnum
                      WHERE t.lnum = ${lnum}
                      GROUP BY t.tnum) s), 0) AS want`,
      expect: 'value',
      why: 'longtrip returns the most legs on any one trip of that driver, and 0 when the driver has none',
    };
  },
};

// A scenario is a weighted list of event names. Order matters only in that the
// seed replays identically; the mix is what distinguishes a friendly stream
// from a hostile one.
export const SCENARIOS = {
  arrivals: { label: 'arrivals', mix: ['arrival', 'arrival', 'arrival', 'arrival'] },
  hires: { label: 'hires', mix: ['hire', 'hire', 'hire', 'hire'] },
  hire_hostile: {
    label: 'hostile hiring',
    mix: ['hire', 'licence_collision', 'duplicate_enum', 'bad_role', 'driver_with_experience', 'mechanic_without_experience'],
  },
  traffic: {
    label: 'traffic',
    mix: ['arrival', 'arrival', 'arrival', 'arrival', 'cancellation', 'cancellation', 'reassignment', 'hire'],
  },
  hostile: {
    label: 'hostile traffic',
    mix: ['arrival', 'arrival', 'cancellation', 'cancellation', 'reassignment', 'reassignment', 'bulk_cancel'],
  },
  calls: { label: 'calls', mix: ['longtrip', 'longtrip', 'longtrip'] },
};

// -------------------------------------------------------------------- schemas

const SCHEMA_RE = /^(play|audit|burst)_[a-z0-9]{6,24}$/;

function newSchema(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

async function seedSchema(client, schema, seedText) {
  await client.query('ROLLBACK').catch(() => {});
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}", public`);
  await client.query('BEGIN');
  try {
    // One round trip: the simple query protocol runs the whole seed in order.
    await client.query(seedText);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// A trigger on trip can still be a no-op. Probe the behaviour, not the name:
// sync the counters, insert one trip inside a transaction, read the counter
// back, roll everything back. This is what makes the "keep the counter" step
// mean something.
async function counterFollowsInsert(client, schema) {
  const s = `"${schema}"`;
  await client.query('BEGIN');
  try {
    const driver = await client.query(`SELECT lnum FROM ${s}.driver ORDER BY lnum LIMIT 1`);
    const truck = await client.query(`SELECT regnum FROM ${s}.truck ORDER BY regnum LIMIT 1`);
    if (!driver.rows.length || !truck.rows.length) return false;
    const lnum = driver.rows[0].lnum;
    const regnum = truck.rows[0].regnum;
    const tnum = Number(
      (await client.query(`SELECT coalesce(max(tnum), 0) + 1 AS n FROM ${s}.trip`)).rows[0].n,
    );
    // The backfill is a different step: give the trigger a clean starting row.
    await client.query(
      `UPDATE ${s}.driver d
          SET totalTripMade = (SELECT count(*) FROM ${s}.trip t WHERE t.lnum = d.lnum)`,
    );
    await client.query(
      `INSERT INTO ${s}.trip (tnum, lnum, regnum, trip_date) VALUES ($1, $2, $3, CURRENT_DATE)`,
      [tnum, lnum, regnum],
    );
    const after = await client.query(
      `SELECT d.totalTripMade AS counter,
              (SELECT count(*)::int FROM ${s}.trip t WHERE t.lnum = d.lnum) AS trips
         FROM ${s}.driver d WHERE d.lnum = $1`,
      [lnum],
    );
    const row = after.rows[0];
    return row && Number(row.counter) === Number(row.trips);
  } catch {
    return false;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

// that exists is the object you were asked for.
export async function objects(client, schema) {
  const { rows } = await client.query(
    `SELECT p.proname AS name,
            p.prokind AS kind,
            pg_get_function_identity_arguments(p.oid) AS args,
            pg_get_function_result(p.oid) AS result,
            pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1
      ORDER BY p.proname`,
    [schema],
  );
  const trig = await client.query(
    `SELECT t.tgname AS name,
            c.relname AS table_name,
            pg_get_triggerdef(t.oid) AS definition,
            pg_get_expr(t.tgqual, t.tgrelid) AS when_clause
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = $1
      ORDER BY t.tgname`,
    [schema],
  );
  const onTrip = trig.rows.some((t) => t.table_name === 'trip');
  return {
    routines: rows,
    triggers: trig.rows,
    hasProcedure: rows.some((r) => r.kind === 'p' && r.name === 'add_employee'),
    hasFunction: rows.some((r) => r.kind === 'f' && r.name === 'longtrip'),
    hasTrigger: onTrip ? await counterFollowsInsert(client, schema) : false,
  };
}

// ----------------------------------------------------------------------- play

async function buildEvent(client, scenario, r, index) {
  const mix = SCENARIOS[scenario].mix;
  const name = mix[Math.floor(r() * mix.length) % mix.length];
  const ctx = await context(client);
  return EVENTS[name](ctx, r, index);
}

function isMissingObject(err) {
  // 42883 undefined function: a CALL to a procedure that was never created.
  // Counting that as "refused, as it should be" would pass an empty script.
  return err && (err.code === '42883' || err.code === '3F000' || /does not exist/i.test(err.message || ''));
}

// The world is the test. After each tick, read back the thing the tick was
// about and compare it with what the rule says it should be. No separate quiz:
// if the depot's own rows disagree, the tick fails and says why.
async function assertEvent(client, ev) {
  if (ev.watch && ev.watch.length) {
    const { rows } = await client.query(
      `SELECT d.lnum::text AS lnum, d.totalTripMade AS counter,
              (SELECT count(*)::int FROM trip t WHERE t.lnum = d.lnum) AS trips
         FROM driver d WHERE d.lnum = ANY($1::numeric[])`,
      [ev.watch],
    );
    if (!rows.length) return null;
    const bad = rows.filter((r) => {
      const counter = r.counter === null ? null : Number(r.counter);
      const trips = Number(r.trips);
      return counter === null ? trips > 0 : counter !== trips;
    });
    return {
      pass: bad.length === 0,
      expected: rows.map((r) => `${r.lnum} counts ${r.trips}`).join(', '),
      actual: rows.map((r) => `${r.lnum} counter ${r.counter === null ? 'null' : r.counter}`).join(', '),
    };
  }

  if (ev.employee) {
    const { enum: id, role } = ev.employee;
    const { rows } = await client.query(
      `SELECT (SELECT count(*)::int FROM trkemployee WHERE enum = $1) AS emp,
              (SELECT count(*)::int FROM driver      WHERE enum = $1) AS drv,
              (SELECT count(*)::int FROM mechanic    WHERE enum = $1) AS mec`,
      [id],
    );
    const r = rows[0];
    const pass = role === 'DRIVER' ? r.emp === 1 && r.drv === 1 && r.mec === 0 : r.emp === 1 && r.drv === 0 && r.mec === 1;
    return {
      pass,
      expected: role === 'DRIVER' ? '1 employee row, 1 driver row' : '1 employee row, 1 mechanic row',
      actual: `${r.emp} employee, ${r.drv} driver, ${r.mec} mechanic`,
    };
  }

  return null;
}

async function play(client, { schema, scenario, seed, from, to, keys, offset }) {
  // Every event in a tick is unqualified SQL (INSERT INTO trip, ...), so the
  // connection's search_path decides which clone it hits. Pooled connections
  // are reused across sessions, so say it out loud here: a tick must never
  // land in another learner's world.
  await client.query(`SET search_path TO "${schema}", public`);

  const events = [];
  const series = [];
  const findings = [];

  for (let i = from; i < to; i += 1) {
    const r = rng(tickSeed(seed, i));
    let ev;
    try {
      ev = await buildEvent(client, scenario, r, i);
    } catch (err) {
      // Generation reads the current rows. If a previous tick wrecked the
      // tables badly enough that generation fails, stop and report it.
      findings.push({ tick: i, label: 'engine', why: 'could not generate the next event', detail: err.message });
      break;
    }

    const record = {
      tick: i,
      label: ev.label,
      why: ev.why,
      sql: ev.sql,
      ok: true,
      detail: null,
      error: null,
      soft: false,
    };

    if (ev.expect === 'value') {
      try {
        const row = (await client.query(ev.sql)).rows[0] || {};
        const got = row.got === null || row.got === undefined ? null : Number(row.got);
        const want = row.want === null || row.want === undefined ? null : Number(row.want);
        record.ok = got !== null && want !== null && got === want;
        record.detail = `got ${got === null ? 'NULL' : got}, expected ${want === null ? 'NULL' : want}`;
      } catch (err) {
        record.ok = false;
        record.error = err.message;
      }
    } else {
      await client.query('BEGIN');
      try {
        await client.query(ev.sql);
        await client.query('COMMIT');
        if (ev.expect === 'reject') {
          record.ok = false;
          record.detail = 'it was accepted; it should have been refused';
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (ev.expect === 'ok') {
          record.ok = false;
          record.error = err.message;
          if (isMissingObject(err)) {
            record.soft = true;
            record.error = 'not built yet';
          }
        } else if (isMissingObject(err)) {
          record.ok = false;
          record.error = err.message;
        } else {
          record.detail = 'refused, as it should be';
        }
      }
    }

    // What the rule said should be true afterwards, and what is.
    if (!record.error) {
      const assertion = await assertEvent(client, ev);
      if (assertion) {
        record.expectation = assertion;
        if (!assertion.pass) {
          record.ok = false;
          record.detail = `expected ${assertion.expected}, got ${assertion.actual}`;
        } else {
          record.detail = assertion.actual;
        }
      }
    }

    const inv = adjust(await sampleInvariants(client, keys), offset);
    record.invariants = inv;
    series.push({ tick: i, ...inv });
    if (!record.ok) findings.push(record);
    events.push(record);
  }

  return { events, series, findings };
}

function withoutMeta(script) {
  return String(script || '')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');
}

// -------------------------------------------------------------------- engine
//
// `play_<session>` is the learner's board: it persists between requests, so the
// slider can walk it one event at a time. `burst_<id>` is a throwaway clone for
// high-speed runs, so 500 events never wreck the board in view.

const SESSIONS = new Map();

function checkSession(session) {
  if (!/^[a-z0-9]{8,32}$/.test(String(session || ''))) throw new Error('bad session id');
  return `play_${session}`;
}

// --------------------------------------------------------------- the world
//
// The world is the same play_<session> board the engine walks, read as a
// snapshot: who is driving, how many trips they have, what the counters say,
// and what just happened. The client paints it and asks for another slice.
//
// The map is not drawn by hand either. Cities are the distinct ends of the
// routes in TRIPLEG, placed by a force layout over the route graph, and trucks
// are the newest TRIP rows sitting somewhere on their own route. Add a city to
// the seed and it appears on the map.

// A city is a name that appears at the end of a route. Its position is an
// angle: the client turns that angle into pixels using the pane it actually
// has, so the diagram fits any window and redraws on resize without the server
// knowing anything about screens.
const TAU = Math.PI * 2;

function ringGraph(edges) {
  const names = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();
  const volume = new Map(names.map((s) => [s, 0]));
  for (const e of edges) {
    volume.set(e.from, (volume.get(e.from) || 0) + e.n);
    volume.set(e.to, (volume.get(e.to) || 0) + e.n);
  }
  return {
    nodes: names.map((name, i) => ({
      name,
      angle: (i / Math.max(1, names.length)) * TAU - Math.PI / 2,
      volume: volume.get(name) || 0,
    })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, n: e.n })),
    max: Math.max(1, ...edges.map((e) => e.n)),
  };
}

async function worldSnapshot(client, session) {
  // Pooled connections keep whatever search_path the last request left behind.
  // Every entry point out of this file sets it explicitly; forgetting once put
  // the depot's trips into public for a whole afternoon.
  await client.query(`SET search_path TO "${checkSession(session)}", public`);
  const st = SESSIONS.get(session);
  const drivers = await client.query(
    `SELECT d.enum, e.name, d.lnum, d.status, d.totalTripMade AS counter,
            (SELECT count(*)::int FROM trip t WHERE t.lnum = d.lnum) AS trips,
            (SELECT coalesce(max(legs),0)::int FROM (
               SELECT count(l.legnum) AS legs FROM trip t
                 LEFT JOIN tripleg l ON l.tnum = t.tnum
                WHERE t.lnum = d.lnum GROUP BY t.tnum) s) AS longest,
            (SELECT l.destination FROM trip t JOIN tripleg l ON l.tnum = t.tnum
              WHERE t.lnum = d.lnum ORDER BY t.tnum DESC, l.legnum DESC LIMIT 1) AS at_city
       FROM driver d JOIN trkemployee e ON e.enum = d.enum
      ORDER BY e.name`,
  );
  const mechanics = await client.query(
    `SELECT m.enum, e.name, m.lnum, m.experience
       FROM mechanic m JOIN trkemployee e ON e.enum = m.enum
      ORDER BY e.name`,
  );
  const totals = await client.query(
    `SELECT (SELECT count(*)::int FROM trip) AS trips,
            (SELECT count(*)::int FROM truck) AS trucks,
            (SELECT count(*)::int FROM trkemployee) AS employees,
            (SELECT count(*)::int FROM mechanic) AS mechanics,
            (SELECT count(*)::int FROM driver) AS drivers`,
  );
  const routes = await client.query(
    `SELECT departure AS from_city, destination AS to_city, count(*)::int AS n
       FROM tripleg WHERE departure <> destination
      GROUP BY departure, destination
      ORDER BY n DESC`,
  );
  const graph = ringGraph(routes.rows.map((r) => ({ from: r.from_city, to: r.to_city, n: r.n })));
  const onRing = new Set(graph.nodes.map((n2) => n2.name));

  // Trucks are trip rows. Their position is a function of the tick and their
  // own key, so they move as the world runs and hold still when it is paused.
  const trips = await client.query(
    `SELECT t.tnum, t.regnum, t.lnum,
            (SELECT departure   FROM tripleg l WHERE l.tnum = t.tnum ORDER BY legnum ASC  LIMIT 1) AS from_city,
            (SELECT destination FROM tripleg l WHERE l.tnum = t.tnum ORDER BY legnum DESC LIMIT 1) AS to_city
       FROM trip t ORDER BY t.tnum DESC LIMIT 16`,
  );
  const cursor = st ? st.cursor : 0;
  const trucks = [];
  for (const t of trips.rows) {
    if (!onRing.has(t.from_city) || !onRing.has(t.to_city)) continue;
    // Progress along the route is a function of the tick and the trip number:
    // it moves when the world moves, and it is the same on a replay.
    const phase = ((cursor * 3 + Number(t.tnum) * 7) % 200) / 200;
    trucks.push({
      tnum: t.tnum,
      regnum: t.regnum,
      lnum: t.lnum,
      from: t.from_city,
      to: t.to_city,
      p: Math.round((phase < 0.5 ? phase * 2 : (1 - phase) * 2) * 1000) / 1000,
    });
  }

  const recent = await client.query(
    `SELECT t.tnum, t.lnum, t.regnum
       FROM trip t ORDER BY t.tnum DESC LIMIT 8`,
  );

  const raw = await sampleInvariants(client);
  const built = await objects(client, checkSession(session));
  const offset = st ? st.offset : { orphans: raw.orphans, nulls: raw.nulls };
  return {
    session,
    cursor,
    drivers: drivers.rows,
    mechanics: mechanics.rows,
    totals: totals.rows[0],
    graph,
    trucks,
    recent: recent.rows,
    integrity: judge(raw, offset, ['drift', 'overlap', 'orphans']),
    objects: {
      trigger: built.hasTrigger,
      procedure: built.hasProcedure,
      function: built.hasFunction,
      // A trigger can exist and still do nothing. The panel needs both facts.
      triggerObjects: built.triggers.length,
    },
    events: (st ? st.events : []).slice(-14),
    series: (st ? st.series : []).slice(-160),
  };
}

async function inheritPublic(client, schema) {
  // Anything the learner created on the public board is part of the world
  // before they touch it: the world is the seed plus their objects.
  const routines = await client.query(
    `SELECT pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' ORDER BY p.oid`,
  );
  for (const r of routines.rows) await client.query(r.def).catch(() => {});

  const triggers = await client.query(
    `SELECT pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = 'public'`,
  );
  for (const t of triggers.rows) await client.query(t.def).catch(() => {});

  // A deployment that adds a counter backfills it once. So does this one.
  await client
    .query(`UPDATE driver d
               SET totalTripMade = (SELECT count(*) FROM trip t WHERE t.lnum = d.lnum)`)
    .catch(() => {});
}

// Every browser that ever loaded the page left a schema behind. Keep the live
// ones, drop the rest.
async function sweepSchemas(client, keep) {
  const { rows } = await client.query(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'play\_%'`,
  );
  const live = new Set([...SESSIONS.values()].map((s) => s.schema));
  for (const row of rows) {
    if (row.nspname === keep || live.has(row.nspname)) continue;
    await client.query(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`).catch(() => {});
  }
}

export async function worldReset(pool, seedText, { session, seed = 7001 }) {
  const schema = checkSession(session);
  const client = await pool.connect();
  try {
    await seedSchema(client, schema, seedText);
    await inheritPublic(client, schema);
    const raw = await sampleInvariants(client);
    const offset = { orphans: raw.orphans, nulls: raw.nulls };
    await sweepSchemas(client, schema);
    SESSIONS.set(session, {
      schema,
      scenario: 'traffic',
      seed,
      offset,
      cursor: 0,
      series: [{ tick: -1, ...judge(raw, offset, ['drift', 'overlap', 'orphans']) }],
      events: [],
    });
    return { ok: true, ...(await worldSnapshot(client, session)) };
  } finally {
    client.release();
  }
}

export async function worldState(pool, { session }) {
  const schema = checkSession(session);
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schema}", public`);
    return { ok: true, ...(await worldSnapshot(client, session)) };
  } finally {
    client.release();
  }
}

// Advance the world by n ticks and hand back what happened.
export async function worldAdvance(pool, seedText, { session, n = 1 }) {
  const schema = checkSession(session);
  const client = await pool.connect();
  try {
    let st = SESSIONS.get(session);
    if (!st) {
      await seedSchema(client, schema, seedText);
      await inheritPublic(client, schema);
      const raw = await sampleInvariants(client);
      const offset = { orphans: raw.orphans, nulls: raw.nulls };
      st = {
        schema, scenario: 'traffic', seed: 7001, offset, cursor: 0,
        series: [{ tick: -1, ...judge(raw, offset, ['drift', 'overlap', 'orphans']) }],
        events: [],
      };
      SESSIONS.set(session, st);
    }

    const count = Math.max(1, Math.min(64, Number(n) || 1));
    const played = await play(client, {
      schema,
      scenario: st.scenario,
      seed: st.seed,
      from: st.cursor,
      to: st.cursor + count,
      offset: st.offset,
    });
    for (const ev of played.events) st.events.push(ev);
    if (st.events.length > 200) st.events = st.events.slice(-200);
    st.series.push(...played.series);
    if (st.series.length > 400) st.series = st.series.slice(-400);
    st.cursor += played.events.length;

    return {
      ok: true,
      ...(await worldSnapshot(client, session)),
      events: played.events,
    };
  } finally {
    client.release();
  }
}

// Change the physics: apply a script to the world's own schema.
export async function worldApply(pool, { session, script }) {
  const schema = checkSession(session);
  const client = await pool.connect();
  try {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`SET search_path TO "${schema}", public`);
    const out = await runScript(client, withoutMeta(script));
    return {
      ok: out.ok,
      statements: out.statements,
      // The statements, their rows and their errors. The workbench prints them
      // itself; "apply" is only one half of the loop.
      results: out.results,
      error: out.error,
      notices: out.notices,
      ...(await worldSnapshot(client, session)),
    };
  } finally {
    client.release();
  }
}

// What the learner has built in their own clone: every routine and trigger,
// with the definition Postgres stored. CREATE OR REPLACE is easier to trust
// when you can read back the body you just replaced.
export async function worldLibrary(pool, { session }) {
  const schema = checkSession(session);
  const client = await pool.connect();
  try {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`SET search_path TO "${schema}", public`);
    const lib = await objects(client, schema);
    return {
      ok: true,
      routines: lib.routines,
      triggers: lib.triggers,
      built: {
        procedure: lib.hasProcedure,
        function: lib.hasFunction,
        trigger: lib.hasTrigger,
      },
    };
  } finally {
    client.release();
  }
}