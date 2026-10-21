import { createPrayersHandler } from '../../../../../server/prayers.ts';
import { preflight } from '../../../../../server/http.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const PUT = createPrayersHandler('order');
export const OPTIONS = preflight;