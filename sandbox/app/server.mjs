// Sandbox server for the TRUCK database.
//
// Two containers: Postgres holds the data, this process serves the page and
// forwards SQL to it. There is no ORM and no schema layer on purpose: what you
// type in the editor is exactly what the database receives.
//
// Routes
//   GET  /                 the revision console (static)
//   GET  /api/state        server version, seeded flag, tables, routines, triggers
//   POST /api/query        { sql }  -> columns, rows, notices, duration
//   POST /api/reseed       drop schema public and replay the seed file
//   POST /api/apply        { task } -> run submission/taskN/solutionN.sql
//   GET  /api/routine?name=play the stored definition of a routine or trigger function
//   POST /api/world/reset  { session }             build the session's clone
//   POST /api/world/state  { session }             read it
//   POST /api/world/advance { session, n }         run n ticks, return what changed
//   POST /api/world/apply  { session, script }     change the SQL the clone runs on
//
// Every route is read-write. The container binds to 127.0.0.1 only, on purpose:
// this tool runs anything it is given.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import pg from 'pg';
import { withoutSeedDrops, withoutMetaCommands, describeError, runScript } from './sqltext.mjs';
import { worldReset, worldState, worldAdvance, worldApply } from './audit.mjs';

const { Pool } = pg;

// Keep these as text, not JavaScript objects. A DATE should read 2026-08-01 in
// the grid, and NUMERIC should keep every digit Postgres sent.
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(1114, (v) => v); // timestamp
pg.types.setTypeParser(1184, (v) => v); // timestamptz
pg.types.setTypeParser(1700, (v) => v); // numeric

const PORT = Number(process.env.PORT || 8099);
const SEED_FILE = process.env.SEED_FILE || '/repo/dbCreateTruck-2026S4.sql';
const SUBMISSION_DIR = process.env.SUBMISSION_DIR || '/repo/submission';
const WEB_DIR = process.env.WEB_DIR || join(process.cwd(), 'web');

// Only these files may be applied. A path from the browser is never trusted.
const APPLYABLE = {
  task1: 'task1/solution1.sql',
  task2: 'task2/solution2.sql',
  task3: 'task3/solution3.sql',
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  // Local sandbox: a stuck query should not hold the console forever.
  statement_timeout: Number(process.env.STATEMENT_TIMEOUT_MS || 30000),
});

// ---------------------------------------------------------------- SQL helpers
//
// Splitting, stripping and running scripts lives in sqltext.mjs, because the
// console and the audit engine must treat a script the same way.


// ---------------------------------------------------------------- snapshots
//
// A run is bracketed by two snapshots of the schema. The difference is what the
// console shows: which rows appeared, which changed field by field, and which
// routines or triggers were created or replaced.

async function snapshot(client) {
  const out = { tables: {}, routines: {}, triggers: {} };

  const tables = await client.query(
    `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY 1`,
  );

  for (const { name } of tables.rows) {
    const pk = await client.query(
      `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [name],
    );
    const rows = await client.query(`SELECT * FROM "${name}"`);
    out.tables[name] = { key: pk.rows.map((r) => r.attname), rows: rows.rows };
  }

  const routines = await client.query(
    `SELECT p.proname AS name, p.prokind AS kind,
            pg_get_function_identity_arguments(p.oid) AS args,
            md5(pg_get_functiondef(p.oid)) AS body
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')`,
  );
  for (const row of routines.rows) out.routines[`${row.name}(${row.args})`] = row;

  const triggers = await client.query(
    `SELECT t.tgname AS name, c.relname AS tbl, pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = 'public'`,
  );
  for (const row of triggers.rows) out.triggers[row.name] = row;

  return out;
}

function rowKey(entry, row) {
  if (entry.key.length) return entry.key.map((k) => String(row[k])).join('|');
  return JSON.stringify(row);
}

function diffSnapshots(before, after) {
  const tables = [];

  for (const name of Object.keys(after.tables)) {
    const b = before.tables[name] || { key: [], rows: [] };
    const a = after.tables[name];
    const bMap = new Map(b.rows.map((r) => [rowKey(b, r), r]));
    const aMap = new Map(a.rows.map((r) => [rowKey(a, r), r]));

    const added = [];
    const removed = [];
    const updated = [];

    for (const [k, row] of aMap) if (!bMap.has(k)) added.push(row);
    for (const [k, row] of bMap) if (!aMap.has(k)) removed.push(row);
    for (const [k, row] of aMap) {
      const prev = bMap.get(k);
      if (!prev) continue;
      const fields = Object.keys(row)
        .filter((f) => JSON.stringify(prev[f]) !== JSON.stringify(row[f]))
        .map((f) => ({ field: f, before: prev[f], after: row[f] }));
      if (fields.length) updated.push({ key: k, fields });
    }

    if (added.length || removed.length || updated.length) {
      tables.push({ name, key: a.key, added, removed, updated });
    }
  }

  const routines = [];
  for (const [name, r] of Object.entries(after.routines)) {
    const prev = before.routines[name];
    if (!prev) routines.push({ name, kind: r.kind, action: 'created' });
    else if (prev.body !== r.body) routines.push({ name, kind: r.kind, action: 'replaced' });
  }
  for (const name of Object.keys(before.routines)) {
    if (!after.routines[name]) routines.push({ name, kind: before.routines[name].kind, action: 'dropped' });
  }

  const triggers = [];
  for (const [name, t] of Object.entries(after.triggers)) {
    const prev = before.triggers[name];
    if (!prev) triggers.push({ name, table: t.tbl, action: 'created' });
    else if (prev.def !== t.def) triggers.push({ name, table: t.tbl, action: 'replaced' });
  }
  for (const name of Object.keys(before.triggers)) {
    if (!after.triggers[name]) triggers.push({ name, table: before.triggers[name].tbl, action: 'dropped' });
  }

  return { tables, routines, triggers };
}

// Run a script and report what changed around it.
async function tracedRun(client, sql) {
  const before = await snapshot(client);
  const result = await runScript(client, sql);
  const after = await snapshot(client);
  result.changes = diffSnapshots(before, after);
  return result;
}

// ------------------------------------------------------------ database state

async function tableCounts(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const out = [];
  for (const { table_name } of rows) {
    // Identifiers come from the catalog, and are quoted for safety anyway.
    const c = await client.query(`SELECT count(*)::int AS n FROM "${table_name}"`);
    out.push({ name: table_name, rows: c.rows[0].n });
  }
  return out;
}

async function routines(client) {
  const { rows } = await client.query(
    `SELECT p.proname AS name,
            p.prokind AS kind,
            pg_get_function_identity_arguments(p.oid) AS args,
            pg_get_function_result(p.oid) AS result
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      ORDER BY p.prokind, p.proname`,
  );
  return rows;
}

async function triggers(client) {
  const { rows } = await client.query(
    `SELECT t.tgname AS name,
            c.relname AS table_name,
            pg_get_triggerdef(t.oid) AS definition
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = 'public'
      ORDER BY c.relname, t.tgname`,
  );
  return rows;
}

async function state() {
  const client = await pool.connect();
  await usePublic(client);
  try {
    const version = await client.query('SHOW server_version');
    const seeded = await client.query(`SELECT to_regclass('public.trkemployee') IS NOT NULL AS ok`);
    if (!seeded.rows[0].ok) {
      return {
        connected: true,
        serverVersion: version.rows[0].server_version,
        seeded: false,
        tables: [],
        routines: [],
        triggers: [],
      };
    }
    const [tables, procs, trigs] = await Promise.all([
      tableCounts(client),
      routines(client),
      triggers(client),
    ]);
    return {
      connected: true,
      serverVersion: version.rows[0].server_version,
      seeded: true,
      tables,
      routines: procs,
      triggers: trigs,
    };
  } finally {
    client.release();
  }
}

// Pooled connections remember their last search_path, and the world moves it
// into a clone schema. Anything that means to work on the visible board says so
// out loud.
async function usePublic(client) {
  await client.query('SET search_path TO public');
  return client;
}

// ------------------------------------------------------------------- reseed

// The seed, parsed once. Every clone and every audit replays this exact text,
// so two runs on the same day start from identical rows.
let SEED_TEXT = null;
async function seedText() {
  if (!SEED_TEXT) {
    const raw = await readFile(SEED_FILE, 'utf8');
    SEED_TEXT = withoutSeedDrops(withoutMetaCommands(raw));
  }
  return SEED_TEXT;
}

async function reseed() {
  const client = await pool.connect();
  await usePublic(client);
  const started = process.hrtime.bigint();
  try {
    const raw = await readFile(SEED_FILE, 'utf8');
    const seed = withoutSeedDrops(withoutMetaCommands(raw));

    // One transaction: either the whole fixture lands or nothing does.
    await client.query('BEGIN');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query(seed);
    await client.query('COMMIT');

    const tables = await tableCounts(client);
    return {
      ok: true,
      tables,
      durationMs: Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 10) / 10,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: describeError(err, '') };
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------------- routes

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(res, urlPath) {
  const root = resolve(WEB_DIR);
  const target = resolve(join(root, urlPath === '/' ? 'index.html' : urlPath));
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  try {
    if (req.method === 'GET' && path === '/api/state') {
      return json(res, 200, await state());
    }

    if (req.method === 'POST' && path === '/api/query') {
      const { sql } = await readBody(req);
      if (typeof sql !== 'string' || !sql.trim()) {
        return json(res, 400, { ok: false, error: { message: 'empty query' } });
      }
      const client = await pool.connect();
      try {
        await usePublic(client);
        return json(res, 200, await tracedRun(client, sql));
      } finally {
        client.release();
      }
    }

    if (req.method === 'POST' && path === '/api/reseed') {
      return json(res, 200, await reseed());
    }

    if (req.method === 'POST' && path === '/api/apply') {
      const { task } = await readBody(req);
      const relative = APPLYABLE[task];
      if (!relative) {
        return json(res, 400, { ok: false, error: { message: `unknown task: ${task}` } });
      }
      const raw = await readFile(join(SUBMISSION_DIR, relative), 'utf8');
      const client = await pool.connect();
      try {
        await usePublic(client);
        return json(res, 200, await tracedRun(client, withoutMetaCommands(raw)));
      } finally {
        client.release();
      }
    }

    // The world: one live clone per browser session. Reset builds it, advance
    // walks it, apply changes the SQL it runs on.
    if (req.method === 'POST' && path === '/api/world/reset') {
      const body = await readBody(req);
      return json(res, 200, await worldReset(pool, await seedText(), body));
    }

    if (req.method === 'POST' && path === '/api/world/state') {
      const body = await readBody(req);
      return json(res, 200, await worldState(pool, body));
    }

    if (req.method === 'POST' && path === '/api/world/advance') {
      const body = await readBody(req);
      return json(res, 200, await worldAdvance(pool, await seedText(), body));
    }

    if (req.method === 'POST' && path === '/api/world/apply') {
      const body = await readBody(req);
      return json(res, 200, await worldApply(pool, body));
    }

    if (req.method === 'GET' && path === '/api/routine') {
      const name = url.searchParams.get('name') || '';
      const client = await pool.connect();
      try {
        await usePublic(client);
        const found = await client.query(
          `SELECT pg_get_functiondef(p.oid) AS definition
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = $1
            ORDER BY (pg_get_function_result(p.oid) = 'trigger')
            LIMIT 1`,
          [name],
        );
        if (!found.rows.length) return json(res, 404, { ok: false, error: { message: 'routine not found' } });
        return json(res, 200, { ok: true, definition: found.rows[0].definition });
      } finally {
        client.release();
      }
    }

    if (req.method === 'GET') return serveStatic(res, path);

    json(res, 404, { ok: false, error: { message: 'not found' } });
  } catch (err) {
    json(res, 500, { ok: false, error: describeError(err, '') });
  }
});

// Seed on first boot so a fresh `make up` is immediately usable.
async function boot() {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT to_regclass('public.trkemployee') IS NOT NULL AS ok`);
    if (!r.rows[0].ok) {
      console.log('seed: empty database, loading', SEED_FILE);
      const out = await reseed();
      if (!out.ok) throw new Error(out.error.message);
      console.log('seed: loaded', out.tables.map((t) => `${t.name}=${t.rows}`).join(' '));
    }
  } finally {
    client.release();
  }
}

boot()
  .then(() => server.listen(PORT, '0.0.0.0', () => console.log(`console on http://localhost:${PORT}`)))
  .catch((err) => {
    console.error('boot failed:', err.message);
    process.exit(1);
  });
