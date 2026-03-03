-- Add owner_id to private_sales for user-scoped access
ALTER TABLE public.private_sales ADD COLUMN IF NOT EXISTS owner_id uuid;

CREATE INDEX IF NOT EXISTS private_sales_owner_id_idx
  ON public.private_sales (owner_id);

CREATE INDEX IF NOT EXISTS private_sales_owner_cert_idx
  ON public.private_sales (owner_id, cert, sold_at DESC);

-- RLS policies (created now, but RLS NOT enabled yet — service-role client bypasses RLS.
-- Enable RLS after all routes are confirmed to use the correct client.)
CREATE POLICY private_sales_user_select ON public.private_sales
  FOR SELECT USING (auth.uid() = owner_id);

CREATE POLICY private_sales_user_insert ON public.private_sales
  FOR INSERT WITH CHECK (auth.uid() = owner_id);

CREATE POLICY private_sales_user_delete ON public.private_sales
  FOR DELETE USING (auth.uid() = owner_id);
