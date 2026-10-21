import { allowedOrigins } from './environment.ts';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const corsMethods = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
export function responseHeaders(request: Request, requestId: string) {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Request-Id': requestId, Vary: 'Origin' });
  const origin = request.headers.get('origin');
  if (origin && allowedOrigins().includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', corsMethods);
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
    headers.set('Access-Control-Expose-Headers', 'X-Request-Id');
  }
  return headers;
}

export function apiHandler(handler: (request: Request) => Promise<unknown> | unknown) {
  return async (request: Request) => {
    const requestId = crypto.randomUUID();
    const headers = responseHeaders(request, requestId);
    try {
      return Response.json(await handler(request), { headers });
    } catch (error) {
      const known = error instanceof HttpError;
      const status = known ? error.status : 500;
      if (status >= 500) {
        // Lista cerrada: nunca registrar mensajes, stacks ni datos de la solicitud.
        console.error(JSON.stringify({
          event: 'api_failure', requestId, status,
          category: known && error.code === 'DATABASE_UNAVAILABLE' ? 'database_unavailable' : 'internal_error',
        }));
      }
      return Response.json({ error: {
        code: known ? error.code : 'INTERNAL_ERROR',
        message: known ? error.message : 'No se pudo completar la solicitud.',
        requestId,
      } }, { status, headers });
    }
  };
}

export function preflight(request: Request) {
  return new Response(null, { status: 204, headers: responseHeaders(request, crypto.randomUUID()) });
}

export async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Timeout')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
