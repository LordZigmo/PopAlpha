-- RLS policies for holdings table (already has user_id column).
-- RLS NOT enabled yet — enable after all routes are confirmed to use the correct client.

CREATE POLICY holdings_user_select ON public.holdings
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY holdings_user_insert ON public.holdings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY holdings_user_update ON public.holdings
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY holdings_user_delete ON public.holdings
  FOR DELETE USING (auth.uid() = user_id);
