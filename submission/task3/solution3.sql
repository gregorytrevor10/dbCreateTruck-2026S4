\set ECHO all

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

SELECT e.NAME,
       d.LNUM,
       longtrip(d.LNUM) AS LongestTrip
  FROM DRIVER d
  JOIN TRKEMPLOYEE e ON e.ENUM = d.ENUM
 ORDER BY LongestTrip DESC, e.NAME;
