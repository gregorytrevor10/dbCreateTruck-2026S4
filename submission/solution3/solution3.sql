-- ===========================================================================
-- CSCI235 Assignment 2 - Task 3
-- Stored function: longtrip(DLNUM)
--
-- Brief inconsistency being handled here:
--   Task 1's execution instructions say "save the stored procedure
--   implementation in a PL/pgSQL script named solution3.sql", while the
--   submission list maps Task 1 -> solution1.sql and Task 3 -> solution3.sql.
--   That sentence in Task 1 is a copy-paste slip. This script therefore
--   re-declares add_employee verbatim (CREATE OR REPLACE, harmless) so
--   solution3.sql is self-contained, and then defines longtrip().
--
-- Target: database `tpchr`, role `tpchr`.
-- ===========================================================================

\set ECHO all

-- ---------------------------------------------------------------------------
-- Part 0: add_employee - reused unchanged from Task 1 / solution1.sql
-- CREATE OR REPLACE means running this again just overwrites the same object.
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
    -- 1. role sanity
    IF p_role NOT IN ('DRIVER', 'MECHANIC') THEN
        RAISE EXCEPTION 'unknown role %, expected DRIVER or MECHANIC', p_role;
    END IF;

    -- 2. role/attribute coupling
    IF p_role = 'MECHANIC' AND p_experience IS NULL THEN
        RAISE EXCEPTION 'a MECHANIC needs an experience level (BEGINNER, STANDARD, EXPERT)';
    END IF;
    IF p_role = 'DRIVER' AND p_experience IS NOT NULL THEN
        RAISE EXCEPTION 'a DRIVER cannot have an experience level, got %', p_experience;
    END IF;

    -- 3. DISJOINTNESS GUARD - before any INSERT, both keys, opposite table
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

    -- 4. super-type row first (child FK needs it)
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
-- Part 1: longtrip(DLNUM)
--
-- Returns the number of legs in the driver's longest trip, or 0 when the
-- driver has no trips at all. A trip with no TRIPLEG rows counts as 0 legs.
--
-- Two details that decide correctness:
--   * LEFT JOIN, not INNER JOIN - a trip with zero legs must stay in the set,
--     otherwise "longest trip" is computed over a filtered view.
--   * count(l.LEGNUM), not count(*) - count(*) would return 1 for a
--     null-extended legless trip; counting a non-null column returns 0.
--
-- max() over an empty set is NULL, so COALESCE supplies the specified 0 for a
-- driver who made no trips (seed data: licence 10008).
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
-- Part 2: report
--
-- NAME lives on TRKEMPLOYEE, LONGTRIP takes DRIVER.LNUM, so the two tables
-- are joined on ENUM while the function is fed the licence. The brief's
-- example (SELECT NAME, LONGTRIP(L#) FROM DRIVER) cannot run as printed.
-- ---------------------------------------------------------------------------
SELECT e.NAME,
       d.LNUM,
       longtrip(d.LNUM) AS LongestTrip
  FROM DRIVER d
  JOIN TRKEMPLOYEE e ON e.ENUM = d.ENUM
 ORDER BY LongestTrip DESC, e.NAME;

-- Independent cross-check: per-driver maximum leg count without the function.
SELECT d.LNUM,
       COALESCE(max(s.legs), 0) AS expected
  FROM DRIVER d
  LEFT JOIN (SELECT t.LNUM AS dl,
                    t.TNUM,
                    count(l.LEGNUM) AS legs
               FROM TRIP t
               LEFT JOIN TRIPLEG l ON l.TNUM = t.TNUM
              GROUP BY t.LNUM, t.TNUM) s ON s.dl = d.LNUM
 GROUP BY d.LNUM
 ORDER BY d.LNUM;
