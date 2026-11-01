-- ===========================================================================
-- CSCI235 Assignment 2 - solution3.sql
--
-- The brief is inconsistent about file naming:
--   * Task 1 steps 3-4 say to save the stored PROCEDURE implementation in
--     "solution3.sql" and capture its output in "solution3.lst".
--   * The submission list maps Task 1 -> solution1.sql, Task 3 -> solution3.sql.
--
-- This script satisfies both readings: it contains the Task 1 procedure and
-- its two executions, then the Task 3 function and report. solution1.sql
-- remains the focused Task 1 script; this is the combined one.
--
-- Target: database `tpchr`, role `tpchr`. Assumes a freshly seeded database
-- (dbCreateTruck-2026S4.sql) because the first execution inserts E# 16.
-- ===========================================================================

\set ECHO all

-- ===========================================================================
-- TASK 1 - stored procedure add_employee
-- ===========================================================================
CREATE OR REPLACE PROCEDURE add_employee(
    p_enum       NUMERIC,                  -- E#
    p_name       VARCHAR,                  -- NAME
    p_dob        DATE,                     -- DOB
    p_address    VARCHAR,                  -- ADDRESS
    p_hiredate   DATE,                     -- HIREDATE
    p_lnum       NUMERIC,                  -- L#
    p_status     VARCHAR,                  -- STATUS
    p_experience VARCHAR DEFAULT NULL,     -- EXPERIENCE (mechanic only)
    p_role       VARCHAR DEFAULT 'DRIVER'
)
LANGUAGE plpgsql
AS $$
BEGIN
    -- 1. role sanity: only the two sub-types exist
    IF p_role NOT IN ('DRIVER', 'MECHANIC') THEN
        RAISE EXCEPTION 'unknown role %, expected DRIVER or MECHANIC', p_role;
    END IF;

    -- 2. role/attribute coupling:
    --    MECHANIC.EXPERIENCE is NOT NULL, TRKEMPLOYEE has no such column
    IF p_role = 'MECHANIC' AND p_experience IS NULL THEN
        RAISE EXCEPTION 'a MECHANIC needs an experience level (BEGINNER, STANDARD, EXPERT)';
    END IF;
    IF p_role = 'DRIVER' AND p_experience IS NOT NULL THEN
        RAISE EXCEPTION 'a DRIVER cannot have an experience level, got %', p_experience;
    END IF;

    -- 3. DISJOINTNESS GUARD - before any INSERT, both keys, opposite table.
    --    ENUM is the shared primary key; LNUM is an alternate key whose
    --    UNIQUE constraint is scoped per table, so it must be checked here.
    IF p_role = 'MECHANIC' AND EXISTS (
           SELECT 1 FROM DRIVER
            WHERE ENUM = p_enum OR LNUM = p_lnum)
    THEN
        RAISE EXCEPTION
            'employee % / licence % already exists as a DRIVER; drivers and mechanics must be disjoint',
            p_enum, p_lnum USING ERRCODE = 'P0001';
    END IF;

    IF p_role = 'DRIVER' AND EXISTS (
           SELECT 1 FROM MECHANIC
            WHERE ENUM = p_enum OR LNUM = p_lnum)
    THEN
        RAISE EXCEPTION
            'employee % / licence % already exists as a MECHANIC; drivers and mechanics must be disjoint',
            p_enum, p_lnum USING ERRCODE = 'P0001';
    END IF;

    -- 4. super-type row first: the child FK needs this row to exist
    INSERT INTO TRKEMPLOYEE (ENUM, NAME, DOB, ADDRESS, HIREDATE)
    VALUES (p_enum, p_name, p_dob, p_address, p_hiredate);

    -- 5. exactly one sub-type row
    IF p_role = 'DRIVER' THEN
        INSERT INTO DRIVER (ENUM, LNUM, STATUS)
        VALUES (p_enum, p_lnum, p_status);
    ELSE
        INSERT INTO MECHANIC (ENUM, LNUM, STATUS, EXPERIENCE)
        VALUES (p_enum, p_lnum, p_status, p_experience);
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- TASK 1 - first execution: a brand-new DRIVER, nothing can collide
-- ---------------------------------------------------------------------------
CALL add_employee(
    p_enum       => 16,
    p_name       => 'Cristiano Ronaldo',
    p_dob        => DATE '1990-11-12',
    p_address    => '7 Sim St, Wollongong NSW 2500',
    p_hiredate   => CURRENT_DATE,
    p_lnum       => 40002,
    p_status     => 'AVAILABLE',
    p_experience => NULL,
    p_role       => 'DRIVER' );

-- Proof it landed in exactly two tables.
SELECT * FROM TRKEMPLOYEE WHERE ENUM = 16;
SELECT * FROM DRIVER      WHERE ENUM = 16;
SELECT * FROM MECHANIC    WHERE ENUM = 16;

-- ---------------------------------------------------------------------------
-- TASK 1 - second execution: MUST FAIL
--
-- Lionel Messi signs on as a MECHANIC quoting L# 40002, which already belongs
-- to a DRIVER. E# 17 is free, so the primary key cannot catch it, and
-- MECHANIC_UNIQUE(LNUM) cannot catch it either because 40002 is absent from
-- MECHANIC. Only the disjointness guard can reject this call.
-- ---------------------------------------------------------------------------
CALL add_employee(
    p_enum       => 17,
    p_name       => 'Lionel Messi',
    p_dob        => DATE '1987-06-24',
    p_address    => '10 Fake St, Wollongong NSW 2500',
    p_hiredate   => CURRENT_DATE,
    p_lnum       => 40002,
    p_status     => 'AVAILABLE',
    p_experience => 'EXPERT',
    p_role       => 'MECHANIC' );

-- After a rejected CALL nothing may be written.
SELECT * FROM TRKEMPLOYEE WHERE ENUM = 17;      -- expect 0 rows
SELECT * FROM MECHANIC    WHERE LNUM = 40002;   -- expect 0 rows

-- ===========================================================================
-- TASK 3 - stored function longtrip(DLNUM)
--
-- Legs in the driver's longest trip, 0 when the driver has no trips.
--   * LEFT JOIN keeps trips that have no TRIPLEG rows in the candidate set.
--   * count(l.LEGNUM) not count(*): a null-extended legless trip would count
--     as 1 with count(*), and as 0 when counting a non-null column.
--   * max() over an empty set is NULL, so COALESCE supplies the required 0.
-- STABLE: reads tables, modifies nothing.
-- ===========================================================================
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
-- TASK 3 - report: every driver's name and the length of their longest trip.
-- NAME lives on TRKEMPLOYEE while longtrip() takes DRIVER.LNUM, so the tables
-- are joined on ENUM and the function is fed the licence.
-- ---------------------------------------------------------------------------
SELECT e.NAME,
       d.LNUM,
       longtrip(d.LNUM) AS LongestTrip
  FROM DRIVER d
  JOIN TRKEMPLOYEE e ON e.ENUM = d.ENUM
 ORDER BY LongestTrip DESC, e.NAME;
