import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema.ts';
import { databaseEnvironment } from '../server/environment.ts';

function createDatabase() {
  const { url, timeoutMs } = databaseEnvironment();
  const sql = neon(url, { isolationLevel: 'ReadCommitted', fetchOptions: {
    // Neon combina estas opciones en cada fetch; no reutilizar señales vencidas.
    get signal() { return AbortSignal.timeout(timeoutMs); },
    cache: 'no-store',
  } });
  return drizzle(sql, { schema });
}

let instance: ReturnType<typeof createDatabase> | undefined;
export function getDb() { return instance ??= createDatabase(); }

// Conserva las consultas legacy sin leer configuración al importar o compilar.
export const db = new Proxy({} as ReturnType<typeof createDatabase>, {
  get(_target, property) {
    const database = getDb();
    const value = Reflect.get(database, property);
    return typeof value === 'function' ? value.bind(database) : value;
  },
});
