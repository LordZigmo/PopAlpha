DO $$
BEGIN
  IF to_regclass('public.holdings') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.holdings ADD COLUMN IF NOT EXISTS cert_number text NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS holdings_cert_number_idx ON public.holdings (cert_number)';
  END IF;
END $$;
