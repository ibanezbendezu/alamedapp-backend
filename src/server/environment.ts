type Environment = Record<string, string | undefined>;

export function databaseEnvironment(env: Environment = process.env) {
  try {
    const url = new URL(env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !url.hostname.endsWith('.neon.tech') || !url.username || !url.password
      || url.pathname.length < 2
      || !['require', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '')
      || url.searchParams.has('ssl') || url.searchParams.has('sslcert')
      || url.searchParams.has('sslkey') || url.searchParams.has('sslrootcert')) throw new Error();
    const timeoutMs = Number(env.DATABASE_TIMEOUT_MS ?? 5000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error();
    return { url: url.toString(), timeoutMs };
  } catch {
    throw new Error('Invalid private Neon database configuration');
  }
}

export function allowedOrigins(env: Environment = process.env) {
  return (env.API_ALLOWED_ORIGINS ?? '').split(',').map(v => v.trim()).filter(Boolean);
}

export function authEnvironment(env: Environment = process.env) {
  const authorizedParties = (env.CLERK_AUTHORIZED_PARTIES ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (!authorizedParties.length || (!env.CLERK_SECRET_KEY && !env.CLERK_JWT_KEY)) {
    throw new Error('Missing server authentication configuration');
  }
  return { authorizedParties, secretKey: env.CLERK_SECRET_KEY, jwtKey: env.CLERK_JWT_KEY };
}
