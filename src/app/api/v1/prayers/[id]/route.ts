import { createPrayersHandler } from '../../../../../server/prayers.ts';
import { preflight } from '../../../../../server/http.ts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{id: string}> }) { return createPrayersHandler('patch', (await context.params).id)(request); }
export async function DELETE(request: Request, context: { params: Promise<{id: string}> }) { return createPrayersHandler('delete', (await context.params).id)(request); }
export const OPTIONS = preflight;