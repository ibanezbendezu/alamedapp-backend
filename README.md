# Alamedapp API — perfil propio y sincronización

Requiere Node 24 y npm. Usa Next.js, Clerk servidor, Drizzle y Neon HTTP. No requiere Docker. Las dos migraciones de oraciones están preparadas para aplicación manual antes de activar esa API.

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

## Oraciones: activación pendiente

La API `/api/v1/prayers` requiere Clerk; GET pagina de 100 en 100 (`cursor`, `nextCursor`, ID inmutable creciente), POST usa sólo amigos por defecto y admite pública si el autor la elige. PATCH/DELETE `/prayers/:id` exigen autor y PUT `/prayers/order` recibe `{ids: number[]}` con el conjunto propio completo, sin límite de cantidad de oraciones. Público significa lectores autenticados; amigos exige ambos follows actuales en SQL. Límites: contenido 10000 caracteres, título 200, cuerpo 32768 bytes salvo orden, cuyo límite de transporte es 65536 bytes. Cada página observa su propia instantánea SQL; no se garantiza una instantánea global entre páginas. El cliente reúne todas las páginas y ordena por position/id. Error de esquema/Neon: 503 recuperable.

**PRAYERS_API_ENABLED=false por defecto y permanece apagado.** Tras autenticar, todas las rutas devuelven 503 PRAYERS_NOT_ACTIVE sin consultar DB mientras el flag no sea exactamente true. La idempotencia de creación está implementada localmente; antes de activar siguen pendientes la aplicación de ambas migraciones, las verificaciones reales y el corte legacy con revocación de credenciales. Sólo después de revisar esas condiciones establecer PRAYERS_API_ENABLED=true en el servidor.

**No publicar hasta cortar el acceso PostgreSQL directo del bundle móvil y revocar/rotar sus credenciales.** Esta entrega no migra relaciones legacy ni garantiza privacidad integral mientras esas credenciales sigan vigentes.

En una ventana revisada, respaldar `prayers`, detener escritores legacy, revisar y aplicar manualmente `migrations/20261020_prayers_audience.sql` y después `migrations/20261020_prayer_creation_requests.sql` al destino correcto. No se ejecutan al arrancar y no se han ejecutado en Neon. La segunda agrega una tabla de recibos sin modificar oraciones existentes. Verificar `SELECT audience, count(*) FROM prayers GROUP BY audience` (todas friends inicialmente), constraint y default en catálogo; comparar contenido, colores, fechas y posiciones con respaldo. Verificar PK `(user_id,key)` del recibo y ausencia de FK desde `prayer_id` a `prayers`. Probar con dos cuentas: propias completas, extraños sólo públicas, mutuos públicas+friends, revocación de follow inmediata; CRUD ajeno 404 y orden inválido sin cambios. Antes de activar, completar el retiro de credenciales directas y validar reintentos/concurrencia contra Neon; sólo después habilitar los clientes API. Expo real y aplicación de migraciones quedan pendientes.

Rollback: detener clientes API; exportar `id,audience` para preservar decisiones de visibilidad, volver al release previo sólo si no se reabre lectura legacy que exponga datos, y ejecutar manualmente `ALTER TABLE prayers DROP CONSTRAINT prayers_audience_check; ALTER TABLE prayers DROP COLUMN audience;`. No restaurar acceso directo ni publicar el cliente previo sin evaluar privacidad. La columna es aditiva: preferir rollback de código conservándola.


Las pruebas PGlite ejecutan ambas migraciones y SQL de política/orden/creación reales sólo sobre PostgreSQL embebido en memoria. El transporte Neon simulado ejecuta el batch real en una transacción, incluyendo rollback tras claim e insert/vínculo, replays y solicitudes competidoras. PGlite serializa transacciones: estas pruebas no verifican contención MVCC multiconexión ni el destino Neon real; ambas comprobaciones continúan pendientes de activación.

### Creación y reintentos

`POST /api/v1/prayers` exige `Idempotency-Key: UUIDv4`, además de sesión y payload válidos. La clave es independiente para cada autor. Sin clave o con clave inválida: 400 `INVALID_IDEMPOTENCY_KEY`; payload inválido: 400/413 sin recibo ni oración. CORS permite el header. Ejemplo de cuerpo: `{"content":"Por mi familia"}`; equivale a título null, color `default`, audiencia `friends` e `isAnswered:false`. El hash SHA-256 se calcula con estos defaults en orden fijo; el servidor conserva el texto exacto validado y no duplica contenido privado en el registro.

Un batch Neon HTTP con aislamiento `ReadCommitted` reclama/bloquea `(autor,clave)`, crea y vincula sólo si falta, y lee el estado actual. El claim nunca cambia el hash ni el vínculo ganador. El mismo autor, clave y payload devuelve el mismo ID y no modifica fechas/posición; otro payload devuelve 409 `IDEMPOTENCY_CONFLICT`. Tras edición devuelve la fila propia actual; tras borrado devuelve 410 `PRAYER_DELETED` conservando el vínculo, sin recrear. Otra cuenta puede usar la misma clave sin compartir recibo ni datos. Fallos parciales revierten el batch completo; fallos o respuesta perdida se recuperan reenviando la misma clave/payload. Los metadatos del recibo no aparecen en el DTO.

El editor genera UUIDv4 mediante Expo, una clave por intención; tras timeout/red/5xx o resultado incierto conserva payload y clave, bloquea los campos y permite «Reintentar creación». Un rechazo definitivo antes de escribir permite corregir. Cambiar cuenta, salir o cerrar cancela/descarta respuestas antiguas antes de caché/navegación; un editor nuevo tiene otra intención. El borrador y su clave viven en memoria: no se promete recuperación tras cerrar/reiniciar la app. No hay reintento automático con clave nueva.

Rollback de la segunda migración: mantener el flag apagado, detener clientes de creación y revertir código conservando `prayer_creation_requests`, sus hashes y vínculos. No vaciar ni eliminar recibos: perderlos permite duplicar un intento cuyo cliente aún conserva la clave. No reactivar una versión anterior de POST que ignore la clave. La tabla aditiva puede quedar sin uso durante el rollback; cualquier retirada futura necesita una decisión explícita sobre la vida de los reintentos y respaldo. El rollback de audience descrito arriba es independiente y tampoco autoriza reabrir acceso legacy.
