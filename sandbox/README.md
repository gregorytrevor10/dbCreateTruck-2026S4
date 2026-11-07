# TRUCK practice playground

Three labs over the TRUCK database: stored procedures, row-level triggers, stored
functions. Postgres runs in a container, a small page serves the labs, and the
seed file is the fixture.

Nothing here is a deliverable. The assignment output still comes from `psql`.

## Start

```bash
cd sandbox
cp .env.example .env
make up
```

Open <http://127.0.0.1:8099>. The first boot loads `dbCreateTruck-2026S4.sql`.

```bash
make reset     # wipe the volume and reload the seed
make psql      # the real psql, inside the container
make down      # stop, keep the data
```

## The screens

**Fleet** — the seed as cards: every driver, every truck, the six newest trips.
A driver card shows trips, the stored `totalTripMade`, and the longest trip. Under
the cards sits a SQL editor. Run a statement there and the cards re-read
themselves, so an insert, an update or a new procedure shows up immediately.

Before you write the trigger, most drivers say `counter stale`. That is the problem
the trigger lab solves.

**Procedures** — write `add_employee(...)`. Five checks: the routine exists, it
hires a driver, it hires a mechanic, it rejects an unknown role, and it rejects a
licence that already belongs to the other kind.

**Triggers** — write the row-level trigger that keeps `DRIVER.totalTripMade`
correct. Four checks: the trigger exists, the counter follows an insert, it
follows a delete, and the rows that were already there agree with `TRIP`.

**Functions** — write `longtrip(lnum)`. Three checks: the function exists, it
returns the right number for a driver with trips, and it returns 0 for a driver
with none.

**Console** — free SQL, plus the three solution files if you want to see what
yours does.

Every lab keeps your worksheet in the browser, so switching screens does not lose
work. `⌘/Ctrl + Enter` runs the file.

## How checks work

Each check is a query. Most of them open a transaction, do something, read the
result, then roll back — so running checks never leaves rows behind.

Two checks catch the failures people usually miss:

- deleting a trip leaves the counter too high if the trigger only fires on INSERT;
- the rows loaded by the seed never fire a trigger, so the counter stays null
  until you backfill it once.

## How it is wired

```
browser  ──HTTP──>  app container (node, port 8099)  ──pg──>  db container (postgres 17)
```

The app has no schema of its own. It forwards the text you wrote and returns what
the server said.

Three details explain the code:

- A script runs statement by statement, like `psql`. A failure in the middle does
  not roll back the statements before it, so a `CREATE PROCEDURE` survives a later
  `CALL` that raises.
- The seed opens with seven `drop table ... cascade;` statements. They fail on an
  empty database, so the server strips those lines before replaying the file and
  drops schema `public` instead. The seed on disk stays exactly as it is.
- `\set ECHO all` and other backslash commands are `psql` syntax, not SQL. They
  are removed before a solution file is applied.

## Pointing at another database

The console reads `.env`. Set `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and
`PGDATABASE` to aim it somewhere else. To run the app on the host:

```bash
cd sandbox/app
npm install
DATABASE_URL=postgres://user:pass@host:5432/db \
SEED_FILE=../../dbCreateTruck-2026S4.sql \
SUBMISSION_DIR=../../submission \
npm start
```
