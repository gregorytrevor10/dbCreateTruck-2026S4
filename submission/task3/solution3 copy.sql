-- ===========================================================================
-- CSCI235 Assignment 2 - Task 3
-- Stored function: longtrip(DLNUM)
--
-- Naming note on the brief:
--   Task 1 step 3 says the stored PROCEDURE should be saved in "solution3.sql",
--   while Task 1's own submission list says "solution1.sql" and Task 3 says the
--   FUNCTION goes in "solution3.sql". The safest reading is that step 3 is a
--   copy-paste slip, but the procedure is re-declared here anyway so this file
--   also satisfies the literal wording. It is a CREATE OR REPLACE, so it is
--   idempotent and harmless if solution1.sql has already been run.
--
--   The two CALL examples for Task 1 deliberately do NOT live here: Task 3's
--   Report Guidelines require "no errors in the output shown in your report",
--   and the second Task 1 execution is meant to raise. Those calls are in
--   solution1.sql, whose step 4 asks for success AND error messages.
--
-- Target: database `tpchr`, role `tpchr`.
-- ===========================================================================

\set ECHO all

-- ---------------------------------------------------------------------------
-- Re-declared from Task 1 (definition only, no executions).
-- Inserts a TRKEMPLOYEE row plus exactly one sub-type row, and refuses to
-- let the same E# or L# exist in both DRIVER and MECHANIC.
-- ---------------------------------------------------------------------------
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
