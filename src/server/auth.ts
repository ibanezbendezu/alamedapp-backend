import { createRequire } from 'node:module';
import { authEnvironment } from './environment.ts';
import { HttpError, withTimeout } from './http.ts';

export const authenticationTimeoutMs = 5000;
const loadClerk = createRequire(import.meta.url);

type Claims = { sub?: string; sid?: string; azp?: string; sts?: string };
export type TokenVerifier = (token: string, options: ReturnType<typeof authEnvironment>) => Promise<Claims | undefined>;
const verifySession: TokenVerifier = async (token, options) => {
  // La misma entrada CJS de Node se usa en producción y en las pruebas locales.
  const { verifyToken } = loadClerk('@clerk/nextjs/server') as typeof import('@clerk/nextjs/server');
  const result = await verifyToken(token, options);
  return result as Claims;
};

export async function requireSubject(request: Request, verify: TokenVerifier = verifySession) {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match) throw new HttpError(401, 'UNAUTHORIZED', 'Se requiere una sesión válida.');
  const options = authEnvironment();
  try {
    const claims = await withTimeout(() => verify(match[1], options), authenticationTimeoutMs);
    if (!claims?.sub || !claims.sid || claims.sts === 'pending'
      || (claims.azp && !options.authorizedParties.includes(claims.azp))) throw new Error();
    return claims.sub;
  } catch {
    throw new HttpError(401, 'UNAUTHORIZED', 'Se requiere una sesión válida.');
  }
}
