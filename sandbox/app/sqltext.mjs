// SQL text handling shared by the console and the audit engine.
//
// Nothing here talks to a pool: every function takes text or a client.

export function withoutSeedDrops(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*drop\s+table\b/i.test(line))
    .join('\n');
}

// psql meta-commands (\set ECHO all, \i, \d) are client syntax, not SQL. The
// database would answer them with a syntax error, so remove the lines.
export function withoutMetaCommands(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');
}

// Turn a character offset into something a human can find in the editor.
export function locate(sql, position) {
  if (!position) return null;
  const before = sql.slice(0, Math.max(0, position - 1));
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

export function describeError(err, sql) {
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
export function splitSql(input) {
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
export async function runScript(client, sql) {
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
          rowCount: typeof r.rowCount === 'number' ? r.rowCount : (r.rows || []).length,
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
