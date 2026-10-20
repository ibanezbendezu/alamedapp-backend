import { createMeHandler } from '../../../../server/handlers.ts';
import { preflight } from '../../../../server/http.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createMeHandler();
export const OPTIONS = preflight;
