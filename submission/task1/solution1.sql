\set ECHO all

CREATE OR REPLACE PROCEDURE add_employee(
    p_enum       NUMERIC,
    p_name       VARCHAR,
    p_dob        DATE,
    p_address    VARCHAR,
    p_hiredate   DATE,
    p_lnum       NUMERIC,
    p_status     VARCHAR,
    p_experience VARCHAR DEFAULT NULL,
    p_role       VARCHAR DEFAULT 'DRIVER'
)
LANGUAGE plpgsql
AS $$
BEGIN

    IF p_role NOT IN ('DRIVER', 'MECHANIC') THEN
        RAISE EXCEPTION 'unknown role %, expected DRIVER or MECHANIC', p_role;
    END IF;

    IF p_role = 'MECHANIC' AND p_experience IS NULL THEN
        RAISE EXCEPTION 'a MECHANIC needs an experience level (BEGINNER, STANDARD, EXPERT)';
    END IF;

    IF p_role = 'DRIVER' AND p_experience IS NOT NULL THEN
        RAISE EXCEPTION 'a DRIVER cannot have an experience level, got %', p_experience;
    END IF;

    IF p_role = 'MECHANIC' AND EXISTS (
           SELECT 1 FROM DRIVER
            WHERE ENUM = p_enum OR LNUM = p_lnum)
    THEN
        RAISE EXCEPTION
            'employee % / licence % already exists as a DRIVER; drivers and mechanics must be disjoint',
            p_enum, p_lnum
            USING ERRCODE = 'P0001';
    END IF;

    IF p_role = 'DRIVER' AND EXISTS (
           SELECT 1 FROM MECHANIC
            WHERE ENUM = p_enum OR LNUM = p_lnum)
    THEN
        RAISE EXCEPTION
            'employee % / licence % already exists as a MECHANIC; drivers and mechanics must be disjoint',
            p_enum, p_lnum
            USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO TRKEMPLOYEE (ENUM, NAME, DOB, ADDRESS, HIREDATE)
    VALUES (p_enum, p_name, p_dob, p_address, p_hiredate);

    IF p_role = 'DRIVER' THEN
        INSERT INTO DRIVER (ENUM, LNUM, STATUS)
        VALUES (p_enum, p_lnum, p_status);
    ELSE
        INSERT INTO MECHANIC (ENUM, LNUM, STATUS, EXPERIENCE)
        VALUES (p_enum, p_lnum, p_status, p_experience);
    END IF;
END;
$$;

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

SELECT * FROM TRKEMPLOYEE WHERE ENUM = 16;
SELECT * FROM DRIVER      WHERE ENUM = 16;
SELECT * FROM MECHANIC    WHERE ENUM = 16;

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

SELECT * FROM TRKEMPLOYEE WHERE ENUM = 17;
SELECT * FROM MECHANIC    WHERE LNUM = 40002;
