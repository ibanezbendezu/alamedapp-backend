import { createCommunityHandler } from '../../../../../server/community';
import { preflight } from '../../../../../server/http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const OPTIONS=preflight;
async function handle(request:Request,context:{params:Promise<{operation:string}>}) {
 return createCommunityHandler((await context.params).operation)(request);
}
export const GET=handle;
export const POST=handle;
