-- ===========================================================================
-- CSCI235 Assignment 2 - Task 2
-- Stored PL/pgSQL trigger: keep DRIVER.totalTripMade in sync with TRIP
--
-- DRIVER.totalTripMade starts empty (all NULL). This script installs a
-- row-level trigger that recomputes it whenever a trip is inserted.
-- INSERT only - the brief explicitly excludes UPDATE and DELETE handling.
--
-- Target: database `tpchr`, role `tpchr`.
-- ===========================================================================

\set ECHO all

-- ---------------------------------------------------------------------------
-- Trigger function
--
-- Recomputes from TRIP rather than incrementing by one:
--   * the column starts NULL, and NULL + 1 is still NULL, so an increment
--     would never escape NULL for the first trip;
--   * the seeded 108 trips were never counted, so only a recompute gives the
--     true total on the first insert for a driver;
--   * it is idempotent - inserting twice or replaying a script cannot drift.
--
-- WHERE d.LNUM = NEW.LNUM is what restricts the update to the one driver who
-- made the trip. Without it every row in DRIVER gets the same count.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_total_trip_made() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE DRIVER d
       SET totalTripMade = (SELECT count(*)
                              FROM TRIP t
                             WHERE t.LNUM = NEW.LNUM)
     WHERE d.LNUM = NEW.LNUM;

    RETURN NEW;   -- ignored for AFTER triggers, kept by convention
END;
$$;

-- ---------------------------------------------------------------------------
-- Trigger
--
-- AFTER, not BEFORE: the FK on TRIP.LNUM has already been validated, so
-- exactly one DRIVER row exists to update, and NEW.LNUM is final.
-- FOR EACH ROW: the trigger needs the particular trip that arrived, which a
-- statement-level trigger would not expose.
-- DROP IF EXISTS first, so re-running this script replaces the trigger
-- instead of failing or stacking a second one.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trip_total_trip_made ON TRIP;

CREATE TRIGGER trip_total_trip_made
    AFTER INSERT ON TRIP
    FOR EACH ROW
    EXECUTE FUNCTION trg_total_trip_made();

-- ---------------------------------------------------------------------------
-- Demonstration inserts
--
-- TRIP.TNUM is seeded up to 108. Licence 10001 already has 27 trips in the
-- seed, so its counter must become 28. Licence 10008 has no trips at all,
-- so its NULL counter must become 1.
-- ---------------------------------------------------------------------------
INSERT INTO TRIP VALUES (109, 10001, 'PKR768', current_date);
INSERT INTO TRIP VALUES (110, 10008, 'SST005', current_date);

-- Stored counters next to the real counts they must equal.
SELECT d.ENUM,
       d.LNUM,
       d.totalTripMade AS stored,
       (SELECT count(*) FROM TRIP t WHERE t.LNUM = d.LNUM) AS actual
  FROM DRIVER d
 ORDER BY d.ENUM;

-- Reconciliation: must return zero rows.
SELECT d.ENUM, d.LNUM, d.totalTripMade, count(t.TNUM) AS actual
  FROM DRIVER d
  LEFT JOIN TRIP t ON t.LNUM = d.LNUM
 GROUP BY d.ENUM, d.LNUM, d.totalTripMade
HAVING d.totalTripMade IS DISTINCT FROM count(t.TNUM);
