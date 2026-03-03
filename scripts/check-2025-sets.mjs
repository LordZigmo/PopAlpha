import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Check what columns exist
const { data: sample } = await c.from('canonical_cards').select('*').eq('year', 2025).limit(1);
if (sample && sample[0]) {
  console.log('columns:', Object.keys(sample[0]).join(', '));
}

const { data, error } = await c
  .from('canonical_cards')
  .select('set_name')
  .eq('year', 2025)
  .limit(50);

if (error) {
  console.log('error:', error.message);
  process.exit(1);
}

if (!data || data.length === 0) {
  console.log('No 2025 rows found in canonical_cards');
  process.exit(0);
}

const uniq = [...new Set(data.map(r => r.set_name))].sort();
console.log(`Found ${uniq.length} distinct 2025 set names:`);
uniq.forEach(s => console.log(s));

// Check card_printings for 2025 set codes
const setNames2025 = ['Prismatic Evolutions', 'Journey Together', 'Destined Rivals', 'Black Bolt', 'White Flare', 'Mega Evolution', 'Phantasmal Flames'];
for (const sn of setNames2025) {
  const { data: p, count } = await c.from('card_printings').select('set_code', { count: 'exact' }).eq('set_name', sn).limit(1);
  const code = p?.[0]?.set_code ?? 'N/A';
  // Also check canonical_cards count
  const { count: ccCount } = await c.from('canonical_cards').select('slug', { count: 'exact', head: true }).eq('set_name', sn);
  console.log(`${sn}: set_code=${code}, printings=${count ?? 0}, canonical=${ccCount ?? 0}`);
}
