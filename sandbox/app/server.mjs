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
//
// Every route is read-write. The container binds to 127.0.0.1 only, on purpose:
// this tool runs anything it is given.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import pg from 'pg';

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

// The seed opens with seven `drop table ... cascade;` lines. They only exist so
// the file can be replayed over a dirty database. Reseeding drops the whole
// schema first, so those lines would fail on an empty database and abort the
// load. Strip them at run time and leave Greg's file untouched on disk.
function withoutSeedDrops(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*drop\s+table\b/i.test(line))
    .join('\n');
}

// psql meta-commands (\set ECHO all, \i, \d) are client syntax, not SQL. The
// database would answer them with a syntax error, so remove the lines.
function withoutMetaCommands(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');
}

// Turn a character offset into something a human can find in the editor.
function locate(sql, position) {
  if (!position) return null;
  const before = sql.slice(0, Math.max(0, position - 1));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function describeError(err, sql) {
  return {
    message: err.message,
    code: err.code || null,
    detail: err.detail || null,
    hint: err.hint || null,
    position: err.position ? Number(err.position) : null,
    where: locate(sql, err.position ? Number(err.position) : null),
  };
}

// Split a script into statements the way psql does: one at a time, so a failure
// in the middle does not roll back the statements before it. Dollar quoting,
// strings, identifiers and comments are respected.
function splitSql(input) {
  const out = [];
  let buf = '';
  let i = 0;
  const n = input.length;
  let tag = null;

  while (i < n) {
    if (tag) {
      if (input.startsWith(tag, i)) {
        buf += tag;
        i += tag.length;
        tag = null;
        continue;
      }
      buf += input[i++];
      continue;
    }

    const ch = input[i];

    if (ch === "'" || ch === '"') {
      const quote = ch;
      buf += ch;
      i++;
      while (i < n) {
        if (input[i] === quote) {
          if (input[i + 1] === quote) {
            buf += quote + quote;
            i += 2;
            continue;
          }
          buf += quote;
          i++;
          break;
        }
        buf += input[i++];
      }
      continue;
    }

    if (ch === '-' && input[i + 1] === '-') {
      while (i < n && input[i] !== '\n') buf += input[i++];
      continue;
    }

    if (ch === '/' && input[i + 1] === '*') {
      buf += '/*';
      i += 2;
      while (i < n && !(input[i] === '*' && input[i + 1] === '/')) buf += input[i++];
      if (i < n) {
        buf += '*/';
        i += 2;
      }
      continue;
    }

    if (ch === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(input.slice(i));
      if (m) {
        tag = m[0];
        buf += tag;
        i += tag.length;
        continue;
      }
    }

    if (ch === ';') {
      out.push(buf.trim());
      buf = '';
      i++;
      continue;
    }

    buf += input[i++];
  }

  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.length > 0);
}

// Run a script statement by statement on one connection, collecting each result.
async function runScript(client, sql) {
  const notices = [];
  const onNotice = (n) => notices.push(`${n.severity.toLowerCase()}: ${n.message}`);
  client.on('notice', onNotice);

  const started = process.hrtime.bigint();
  const statements = splitSql(sql);
  const results = [];
  let firstError = null;
  let open = false;

  try {
    for (const stmt of statements) {
      const bare = stmt.replace(/--[^\n]*/g, '').trim().toLowerCase();
      if (/^(begin|start\s+transaction)\b/.test(bare)) open = true;
      if (/^(commit|rollback|end)\b/.test(bare)) open = false;

      try {
        const r = await client.query(stmt);
        results.push({
          text: stmt.length > 90 ? `${stmt.slice(0, 90)}…` : stmt,
          command: r.command || null,
          columns: (r.fields || []).map((f) => f.name),
          rows: r.rows || [],
          rowCount: (r.rows || []).length,
          error: null,
        });
      } catch (err) {
        const described = describeError(err, stmt);
        results.push({
          text: stmt.length > 90 ? `${stmt.slice(0, 90)}…` : stmt,
          command: null,
          columns: [],
          rows: [],
          rowCount: 0,
          error: described,
        });
        if (!firstError) firstError = described;
        // Inside a transaction every later statement will be rejected anyway.
        if (open) break;
      }
    }
  } finally {
    if (open) await client.query('ROLLBACK').catch(() => {});
    client.off('notice', onNotice);
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const withRows = results.filter((r) => r.columns.length);
  const last = withRows[withRows.length - 1];

  return {
    ok: !firstError,
    statements: results.length,
    command: last ? last.command : results[results.length - 1]?.command || null,
    columns: last ? last.columns : [],
    rows: last ? last.rows : [],
    rowCount: last ? last.rowCount : 0,
    results,
    error: firstError,
    notices,
    durationMs: Math.round(durationMs * 10) / 10,
  };
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

// ------------------------------------------------------------------- reseed

async function reseed() {
  const client = await pool.connect();
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
        return json(res, 200, await runScript(client, sql));
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
        return json(res, 200, await runScript(client, withoutMetaCommands(raw)));
      } finally {
        client.release();
      }
    }

    if (req.method === 'GET' && path === '/api/routine') {
      const name = url.searchParams.get('name') || '';
      const client = await pool.connect();
      try {
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
