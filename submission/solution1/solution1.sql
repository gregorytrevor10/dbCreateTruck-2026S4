-- ===========================================================================
-- CSCI235 Assignment 2 - Task 1
-- Stored procedure: add_employee
--
-- SCAFFOLD ONLY. Blocks marked TODO are yours to write.
-- Target: database `tpchr`, role `tpchr`.
-- This file compiles as-is (empty guard = current DDL behaviour).
-- ===========================================================================

-- Echo every statement so the terminal transcript doubles as the report.
\set ECHO all

CREATE OR REPLACE PROCEDURE add_employee(
    p_enum       NUMERIC,                  -- E#        -> TRKEMPLOYEE.ENUM  (12,0)
    p_name       VARCHAR,                  -- NAME      NOT NULL, max 50
    p_dob        DATE,                     -- DOB       nullable
    p_address    VARCHAR,                  -- ADDRESS   NOT NULL, max 300
    p_hiredate   DATE,                     -- HIREDATE  NOT NULL
    p_lnum       NUMERIC,                  -- L#        -> DRIVER/MECHANIC.LNUM (8,0)
    p_status     VARCHAR,                  -- STATUS    vocabulary differs per sub-type
    p_experience VARCHAR DEFAULT NULL,     -- EXPERIENCE: mechanics only
    p_role       VARCHAR DEFAULT 'DRIVER'  -- 'DRIVER' | 'MECHANIC'
)
LANGUAGE plpgsql
AS $$
BEGIN
    -- -------------------------------------------------------------------
    -- 1. Role sanity: only the two sub-types exist.
    -- -------------------------------------------------------------------
    IF p_role NOT IN ('DRIVER', 'MECHANIC') THEN
        RAISE EXCEPTION 'unknown role %, expected DRIVER or MECHANIC', p_role;
    END IF;

    -- -------------------------------------------------------------------
    -- 2. Role/attribute coupling.
    --    MECHANIC.EXPERIENCE is NOT NULL  -> mechanic must supply a value
    --    TRKEMPLOYEE has no EXPERIENCE     -> driver must not supply one
    -- TODO: two IF ... RAISE EXCEPTION blocks, mirrored, one per role.
    -- -------------------------------------------------------------------


    -- -------------------------------------------------------------------
    -- 3. DISJOINTNESS GUARD  <-- the marked part of Task 1.
    --    Must run BEFORE any INSERT so a rejection leaves no rows behind.
    --    Two keys can collide:
    --      ENUM  - the shared primary key
    --      LNUM  - alternate key; UNIQUE(LNUM) is per-table only, so the
    --              same licence can legally sit in both sub-tables
    --    Shape:
    --      IF p_role = 'MECHANIC' AND EXISTS ( ... FROM DRIVER ... )
    --          THEN RAISE EXCEPTION ... USING ERRCODE = ...;
    --      IF p_role = 'DRIVER'   AND EXISTS ( ... FROM MECHANIC ... )
    --          THEN RAISE EXCEPTION ... USING ERRCODE = ...;
    --    Inside the EXISTS: WHERE ENUM = p_enum OR LNUM = p_lnum
    -- TODO: write both blocks.
    -- -------------------------------------------------------------------


    -- -------------------------------------------------------------------
    -- 4. Super-type row first: the child FK needs this row to already exist.
    --    COMMENT is omitted on purpose - nullable, and not one of the
    --    employee attributes listed in the specification.
    -- -------------------------------------------------------------------
    INSERT INTO TRKEMPLOYEE (ENUM, NAME, DOB, ADDRESS, HIREDATE)
    VALUES (p_enum, p_name, p_dob, p_address, p_hiredate);

    -- -------------------------------------------------------------------
    -- 5. Exactly one sub-type row. IF/ELSE, never both - inserting both
    --    would create the very violation step 3 is meant to prevent.
    --    Note the vocabulary split:
    --      DRIVER.STATUS   allows 'ON LEAVE'   (space)
    --      MECHANIC.STATUS allows 'ON_LEAVE'   (underscore)
    -- -------------------------------------------------------------------
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
-- EXECUTIONS
-- ===========================================================================
-- First execution: a brand-new DRIVER. E# 16 and L# 40002 are unused on a
-- fresh seed, so nothing can collide. Already executed successfully.
--
-- WARNING: re-running this file re-runs this CALL. On an already-populated
-- database it fails with 23505 (trkemployee_pkey). Comment it out before
-- re-running the script; leave it live for the report run.

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

-- Second execution: MUST FAIL - E# 16 is now a DRIVER, so the guard has to
-- reject the same employee being added as a MECHANIC. Enable once TODO 3
-- (the disjointness guard) is written, otherwise it will slip through.
--
-- CALL add_employee(
--     p_enum       => 16,
--     p_name       => 'Impostor',
--     p_dob        => DATE '1990-01-01',
--     p_address    => '9 Fake St, Sydney NSW 2000',
--     p_hiredate   => CURRENT_DATE,
--     p_lnum       => 49999,
--     p_status     => 'AVAILABLE',
--     p_experience => 'EXPERT',
--     p_role       => 'MECHANIC' );
