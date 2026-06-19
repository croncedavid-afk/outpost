import { createClient } from '@supabase/supabase-js';
export const sb = createClient(
  import.meta.env.VITE_SUPABASE_URL || 'https://jvtbogrwutcmurvzymcw.supabase.co',
  import.meta.env.VITE_SUPABASE_KEY || 'sb_publishable_O8wL7rVpMA0Rkh86wQumDw_6bHG-kGS'
);
