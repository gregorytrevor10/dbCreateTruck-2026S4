-- ===========================================================================
-- CSCI235 Assignment 2 - Task 3
-- Stored function: longtrip(DLNUM)
--
-- Task 3 step 1 asks for the function definition in solution3.sql, so this
-- file holds the function plus the report query whose output goes into
-- solution3.pdf. The Task 1 procedure lives in task1/solution1.sql.
--
-- Target: database `tpchr`, role `tpchr`.
-- ===========================================================================

\set ECHO all

-- ---------------------------------------------------------------------------
-- longtrip(DLNUM)
--
-- Legs in the driver's longest trip, 0 when the driver has no trips.
--   * LEFT JOIN keeps trips that have no TRIPLEG rows in the candidate set.
--   * count(l.LEGNUM) not count(*): a null-extended legless trip would count
--     as 1 with count(*), and as 0 when counting a non-null column.
--   * max() over an empty set is NULL, so COALESCE supplies the required 0.
-- STABLE: reads tables, modifies nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION longtrip(p_lnum NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_max NUMERIC;
BEGIN
    SELECT max(s.legs)
      INTO v_max
      FROM (SELECT t.TNUM,
                   count(l.LEGNUM) AS legs
              FROM TRIP t
              LEFT JOIN TRIPLEG l ON l.TNUM = t.TNUM
             WHERE t.LNUM = p_lnum
             GROUP BY t.TNUM) s;

    RETURN COALESCE(v_max, 0);
END;
$$;

-- ---------------------------------------------------------------------------
-- Task 3 report: every driver's name and the length of their longest trip.
-- NAME lives on TRKEMPLOYEE while longtrip() takes DRIVER.LNUM, so the tables
-- are joined on ENUM and the function is fed the licence. The brief's example
-- (SELECT NAME, LONGTRIP(L#) FROM DRIVER) cannot run as printed because
-- DRIVER has no NAME column.
-- ---------------------------------------------------------------------------
SELECT e.NAME,
       d.LNUM,
       longtrip(d.LNUM) AS LongestTrip
  FROM DRIVER d
  JOIN TRKEMPLOYEE e ON e.ENUM = d.ENUM
 ORDER BY LongestTrip DESC, e.NAME;
