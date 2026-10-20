import { createReadyHandler } from '../../../server/handlers.ts';
import { preflight } from '../../../server/http.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createReadyHandler();
export const OPTIONS = preflight;
