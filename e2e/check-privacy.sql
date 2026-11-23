DO $privacy$
DECLARE
  relation record;
  leaked boolean;
BEGIN
  FOR relation IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname IN ('gateway', 'indexer', 'auditor', 'consortium', 'demo')
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I.%I AS row WHERE to_jsonb(row)::text LIKE $1 OR to_jsonb(row)::text LIKE $2)',
      relation.schemaname, relation.tablename
    ) INTO leaked USING '%監査試験%', '%シナリオ識別%';
    IF leaked THEN
      RAISE EXCEPTION 'Unexpected customer name in %.%', relation.schemaname, relation.tablename;
    END IF;
  END LOOP;
END
$privacy$;
