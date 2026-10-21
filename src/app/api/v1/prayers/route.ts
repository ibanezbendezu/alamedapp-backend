import { createPrayersHandler } from '../../../../server/prayers.ts';
import { preflight } from '../../../../server/http.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createPrayersHandler('list');
export const POST = createPrayersHandler('create');
export const OPTIONS = preflight;