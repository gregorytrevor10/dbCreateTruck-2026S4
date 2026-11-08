# TRUCK practice playground

Three labs over the TRUCK database: stored procedures, row-level triggers, stored
functions. Postgres runs in a container and a page serves one live depot. The
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

## The screen

One page: **the world**. Nothing on it is drawn by hand.

- **Cities** are the ends of the routes in `TRIPLEG`, placed on a ring by angle.
- **Routes** are the route rows; a line is as thick as the trips on it.
- **Trucks** are `TRIP` rows, sitting somewhere along their own route.
- **Drivers** stand where their latest trip ended. **Mechanics** stand at the
  depot. Both are rows.
- **The panel on the right** is `DRIVER`: trips on file next to the stored
  counter, and the difference. `totalTripMade` is supposed to equal the number
  of trips; when it does not, that row is the bug.

Scroll to zoom, drag to pan, `fit` to reset.

### The clock

The depot lives at the speed you pick: pause, ¼×, ½×, 1×, 4×, 16×, 64×.
Each tick is one statement against a clone of the seed — an arrival, a
cancellation, a trip moving between drivers — and the panel is read after each
one. A new world is always born paused.

Watch it at 64× with no trigger: the counters stop matching within a minute.
That is the lesson, and it is visible without reading a word.

### The world is the test

Every tick states what it expects and then reads back what happened. Open a row
under "what just happened":

```
d2 12:00   cancellation   expected 10003 counts 18, got 10003 counter 19
  DELETE FROM tripleg WHERE tnum = 37; DELETE FROM trip WHERE tnum = 37;
  A trip is cancelled; the counter must drop by one.
    expected   10003 counts 18
    actual     10003 counter 19
```

No separate quiz. The pass/fail is the depot's own rows agreeing or not.

Five steps on the right are checked against the database, not against what you
typed: watch it break, keep the counter, repair the old rows, hire someone,
answer about trips. Open a step when stuck and it says what the rule is and
where to look. You can skip any of them and write something else entirely; the
steps only measure the outcome.

### Changing the physics

The strip at the bottom is the only input. Three buttons load the shape of the
three objects; fill in the body and press **Apply to the world**. The running
clone takes your SQL immediately, so the same world that was rotting stops
rotting. The last few hundred ticks are in the ticker.

### The older screens

`Fleet` and the three labs still exist behind the `Console` link and the URL,
with the original static checks. They are not the front door any more.

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
