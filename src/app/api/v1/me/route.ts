import { createMeHandler, createPatchMeHandler } from '../../../../server/handlers.ts';
import { preflight } from '../../../../server/http.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createMeHandler();
export const PATCH = createPatchMeHandler();
export const OPTIONS = preflight;
