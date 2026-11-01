
\set ECHO all

SELECT enum, lnum, totalTripMade FROM driver ORDER BY enum;

CREATE OR REPLACE FUNCTION trg_total_trip_made() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE DRIVER d
       SET totalTripMade = (SELECT count(*)
                              FROM TRIP t
                             WHERE t.LNUM = NEW.LNUM)
     WHERE d.LNUM = NEW.LNUM;

    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trip_total_trip_made ON TRIP;

CREATE TRIGGER trip_total_trip_made
    AFTER INSERT ON TRIP
    FOR EACH ROW
    EXECUTE FUNCTION trg_total_trip_made();
INSERT INTO TRIP VALUES (109, 10001, 'PKR768', current_date);
INSERT INTO TRIP VALUES (110, 10008, 'SST005', current_date);

SELECT d.ENUM,
       d.LNUM,
       d.totalTripMade AS stored,
       (SELECT count(*) FROM TRIP t WHERE t.LNUM = d.LNUM) AS actual
  FROM DRIVER d
 ORDER BY d.ENUM;

SELECT d.ENUM, d.LNUM, d.totalTripMade, count(t.TNUM) AS actual
  FROM DRIVER d
  LEFT JOIN TRIP t ON t.LNUM = d.LNUM
 WHERE d.totalTripMade IS NOT NULL
 GROUP BY d.ENUM, d.LNUM, d.totalTripMade
HAVING d.totalTripMade IS DISTINCT FROM count(t.TNUM);
