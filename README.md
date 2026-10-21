# Alamedapp API — perfil propio y sincronización

Requiere Node 24 y npm. Usa Next.js, Clerk servidor, Drizzle y Neon HTTP. No requiere Docker ni migraciones.

## Configuración

1. Ejecutar `npm ci` en backend y móvil.
2. Crear manualmente `.env.local` a partir de los ejemplos, sin copiar secretos entre proyectos.
3. Backend: `DATABASE_URL` privada debe apuntar al mismo destino Neon usado por `EXPO_PUBLIC_DATABASE_URL` de los módulos legacy. Sólo admite hosts `*.neon.tech` con `sslmode=require` o `verify-full`.
4. `CLERK_SECRET_KEY` es obligatoria para sincronizar metadata desde Clerk. `CLERK_JWT_KEY` (PEM pública opcional) permite verificar tokens localmente, pero no reemplaza secretKey para sync. Ambos proyectos deben usar la misma instancia Clerk.
5. `CLERK_AUTHORIZED_PARTIES` es obligatoria: lista separada por comas de valores `azp` permitidos. Clerk nativo puede omitir `azp`; si existe, debe coincidir. `API_ALLOWED_ORIGINS` contiene orígenes exactos para Expo web, sin comodines.
6. `DATABASE_TIMEOUT_MS` limita cada fetch Neon (5000 por defecto, máximo 30000). Clerk tiene timeout de 5000 ms; el presupuesto total de sync suma Clerk y hasta tres operaciones Neon (alta, eventual fallback y catálogo). El cliente espera hasta 30 segundos para sync y 10 para otras rutas; si se aumenta el presupuesto del servidor, ajustar también `timeoutMs` del cliente. Importar rutas o compilar no consulta Neon.
7. Ejecutar backend con `npm run dev -- --hostname 0.0.0.0`.
8. Expo requiere `EXPO_PUBLIC_API_URL`. En Expo Go de teléfono físico usar `http://IP_LAN_DEL_COMPUTADOR:3000`; localhost apunta al teléfono. El teléfono y computador deben compartir una red alcanzable, con el puerto permitido. Reiniciar Expo tras cambiar variables; producción requiere HTTPS.

## Contrato

Todas las rutas privadas exigen sesión Clerk válida mediante `Authorization: Bearer TOKEN` antes de leer Clerk o Neon. La identidad procede exclusivamente del token; query strings no cambian el sujeto.

- `GET /api/health`: liveness, independiente de dependencias.
- `GET /api/ready`: `select 1`, 200 o 503 seguro.
- `POST /api/v1/me/sync`: cuerpo vacío o `{}`. Obtiene metadata en Clerk servidor y exige correo primario verificado. Alta idempotente por clerkId; colisión de username intenta sufijo determinista. En cuentas existentes actualiza sólo email y avatar, preservando username, nombre local, saldo, PIN, bio, favorito, fechas y contadores. Inicializa el catálogo legacy sin asignar medallas. Correo sin verificar o conflicto irresoluble: 409.
- `GET /api/v1/me`: perfil propio, 404 si falta.
- `PATCH /api/v1/me`: sólo `displayName` (50), `bio` (160), `favoriteVerse` (5000), todos admiten null. Favorito es string JSON BibleVerse con book/text no vacíos y chapter/verse enteros positivos. Cuerpo vacío, JSON inválido, campos extra, tipos o límites inválidos: 400. Sync y PATCH limitan la lectura del cuerpo a 32 KiB; exceso: 413. No admite identidad, saldo, PIN ni privilegios.
- `GET /api/v1/me/medals`: medallas propias con earnedAt ISO.
- `GET /api/v1/medals`: catálogo autenticado. No existen rutas de asignación.

Perfil devuelve `{data:{clerkId,username,email,displayName,avatarUrl,balance,followerCount,followingCount,favoriteVerse,bio,cardColor,createdAt}}`. Balance es decimal string, fecha ISO; selección y DTO excluyen PIN. Errores: `{error:{code,message,requestId}}`; fallos de dependencias devuelven 503 seguro. Respuestas no cacheables, correlación `X-Request-Id`, OPTIONS/CORS explícito. Logs de fallos incluyen sólo categoría, estado y correlación.

## Cuenta en Expo y transición legacy

El provider prepara la cuenta antes de montar navegación privada y notificaciones. Muestra estado pendiente, error recuperable, reintentar y salir. Cada sesión Clerk tiene QueryClient propio; al cambiar cuenta o cerrar sesión invalida la sesión anterior, cancela y descarta sus respuestas, vacía caché y desmonta notificaciones. Edición de nombre/bio/favorito y lectura de perfil/medallas usan API sin fallback SQL; callbacks y navegación ocurren sólo tras guardar con la sesión vigente.

Follow-back, rachas, notificaciones, búsqueda y perfiles ajenos, ALMC y oraciones siguen en PostgreSQL legacy. La credencial pública actual continúa siendo necesaria para estos consumidores hasta su migración y rotación. No se cambian privacidad ajena, esquema ni política PIN/ALMC.

## Verificación local y prueba manual

Backend: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Móvil: `npm test`, `npm run typecheck`. Runner TypeScript nativo Node24 sin dependencias nuevas. Clerk SDK/token RSA y transporte Neon se simulan; se verifica SQL real generado, whitelist, conflictos, preservación local, lectura de medallas, timeout, cancelación y carreras A/B. Además de los controladores puros, las pruebas montan AccountProvider y los hooks reales con react-test-renderer ya instalado, Clerk y hosts nativos controlados: verifican gate, polling, retry, StrictMode, cambios de identidad e invalidación observada. Las pruebas no cargan archivos de entorno ni contactan Clerk/Neon reales.

Build descarga Geist con `next/font/google` y requiere acceso a Google Fonts. La validación automática no sustituye prueba visual en Expo Go ni confirma escritura/lectura real del destino Neon.

Prueba manual posterior, sólo cuando se autorice usar servicios reales: abrir Expo Go físico, iniciar sesión y comprobar preparación antes de consultas privadas; editar nombre/bio/favorito, recargar y comprobar persistencia; reintentar con API caída; cambiar A→B o salir durante sync/guardado y comprobar ausencia de callbacks, datos o notificaciones anteriores. No ejecutar migraciones ni cambiar el destino Neon.
