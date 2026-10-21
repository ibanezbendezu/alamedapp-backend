import { createPrayersHandler } from '../../../../../../server/prayers.ts';
import { preflight } from '../../../../../../server/http.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{id: string}> }) { return createPrayersHandler('list', (await context.params).id)(request); }
export const OPTIONS = preflight;