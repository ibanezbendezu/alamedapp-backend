# Alamedapp API

Node 24, Next.js 16.4.2, Clerk, Drizzle y Neon HTTP. No Docker ni migraciones al arrancar. El corte de Neon y la rotación de credenciales se completaron el 22 de octubre de 2026; evidencia en `../docs/corte-operativo-neon.md`. La validación en teléfono y el despliegue público siguen pendientes.

Desde la raíz del workspace, `.\dev.cmd` inicia ambos proyectos; `.\dev.cmd --phone IP_LAN` prepara Expo Go. Ctrl+C detiene ambos. Consulta `../README.md`.

## Arranque

Ejecutar `npm ci` en ambos proyectos. Crear backend `.env.local` desde `.env.example`; los secretos y DATABASE_URL sólo pertenecen al servidor. La URL acepta Neon con sslmode=require/verify-full. Ambos proyectos usan la misma instancia Clerk. CLERK_SECRET_KEY sirve para sincronizar metadata; CLERK_JWT_KEY opcional es la clave pública PEM de verificación, nunca una clave privada. CLERK_AUTHORIZED_PARTIES y API_ALLOWED_ORIGINS son listas de orígenes exactos; agregar el origen Expo web LAN al probar desde otro computador.

Backend: `npm run dev -- --hostname 0.0.0.0`. Expo web usa EXPO_PUBLIC_API_URL=http://localhost:3000. Expo Go físico usa http://IP_LAN_DEL_COMPUTADOR:3000; teléfono y computador comparten red y el puerto debe estar accesible. Reiniciar Metro tras cambiar variables. Producción requiere HTTPS. Si aparece NETWORK_ERROR, comprobar que Next esté escuchando y que la URL no apunte al propio teléfono.

DATABASE_TIMEOUT_MS limita cada petición Neon, 5000 ms por defecto; sync permite su presupuesto de Clerk más tres operaciones DB. El resto del cliente tiene timeout de 10 segundos y conserva intentos económicos inciertos.

## API

Authorization: Bearer con sesión Clerk válida antes de DB. Actor exclusivamente desde token. JSON con campos extra o identidades del actor en escrituras se rechaza. DTO explícito, no-store, OPTIONS/CORS e Idempotency-Key permitidos. Errores sólo incluyen código/mensaje seguro/requestId; logs no incluyen cuerpo, PIN ni datos económicos.

- GET /api/health: vida sin dependencias; GET /api/ready: disponibilidad DB.
- POST /api/v1/me/sync: cuerpo vacío, metadata verificada en Clerk, alta idempotente y preservación de datos existentes. GET/PATCH /me: perfil propio y edición whitelist de displayName/bio/favoriteVerse. GET /me/medals y /medals: medallas ganadas/catálogo, sin asignación.
- GET /api/v1/community/profile?target=ID: identidad/nombre/foto/bio/versículo/medallas/contadores, relación sólo con el actor. Nunca correo, saldo ni credencial.
- GET /community/search?q=TEXTO&cursor=ID: usuario/nombre, 50 filas por clerkId inmutable; nextCursor nullable. Nunca búsqueda por correo.
- POST /community/follow {target,enabled}: follow/unfollow idempotente; bloqueos de cuentas en orden; relación, contadores y aviso atómicos. Unfollow desactiva racha y solicitudes de pareja y revoca friends.
- GET /community/notifications?cursor=ID: avisos propios por ID descendente, páginas de 50, unreadCount total independiente de la ventana visible. Expo consulta automáticamente sólo los 50 avisos recientes como máximo cada 30 segundos; no descarga todas las páginas en cada polling. La paginación e historial permanecen disponibles en la API. POST /notification-read {maxId}: sólo propios hasta el máximo observado. POST /notification-dismiss {id}: descarte propio idempotente, sin borrado físico.
- GET /community/streaks, /streak-detail?id=ID: sólo miembros. GET /streak-requests: pendientes recibidas. POST /streak-action {action,target? ,id?}: request requiere target y follow mutuo; accept/reject sólo receptor e id; presence sólo miembro e id. Pareja y pendiente únicas; aceptación repetida no reinicia. Presencias se evalúan bajo locks, ventana de cinco segundos; un incremento por fecha America/Santiago, incluida DST. La lectura muestra count=0 después de finalizar el día siguiente al último avivamiento; activar conjuntamente reinicia en 1. No hay expiración global desde Expo.
- GET /community/wallet?cursor=ID: saldo/color/hasPin e historial propio paginado por ID descendente. Cada página se obtiene con una sola sentencia SQL: metadata de cuenta y movimientos pertenecen a la misma instantánea. Expo conserva esa metadata de la primera página y refresca sólo hasta 50 movimientos recientes cada 15 segundos; no recorre páginas históricas automáticamente. El historial y su paginación siguen disponibles en la API. Montos decimal string. POST /card-color {color}: #RRGGBB.
- POST /community/pin {pin,previousPin?}: seis dígitos; alta sólo sin hash vigente, cambio requiere PIN actual. scrypt con salt aleatorio, comparación constante, intentos persistentes y bloqueo de 15 minutos tras cinco fallos. No existe reset sin autenticación reforzada.
- POST /community/transfer {receiverId,amount,description,pin} con Idempotency-Key UUIDv4: decimal string positivo, máximo dos decimales y numeric(20,2). Descripción hasta 280. Hash canónico del payload económico sin PIN. Bajo locks ordenados revalida credencial/bloqueo/saldo; débito/crédito, dos asientos, aviso y recibo durable son una sola sentencia transaccional. Un fallo SQL revierte esa sentencia completa. Los rechazos de negocio INSUFFICIENT_FUNDS/BALANCE_LIMIT, en cambio, conservan un recibo terminal durable sin modificar dinero, asientos ni avisos. El replay devuelve el recibo exitoso original o el mismo error terminal, incluso si después cambia el saldo; payload diferente devuelve 409. Un borrador con resultado incierto sólo se libera para corrección y clave nueva al confirmar ese rechazo terminal: errores de PIN, red o servidor no lo desbloquean. Intentos PIN fallidos persisten en una operación separada anterior.

Las rutas anteriores llevan prefijo /api/v1; community se conserva en cada operación listada. No hay emisión, canje, asignación de medallas, transferencia de otra cuenta ni acceso DB desde Expo.

Oraciones mantienen GET /users/:id/prayers, POST /prayers con UUIDv4, PATCH/DELETE /prayers/:id y PUT /prayers/order. Autor en escrituras, lectores autenticados; friends exige follows mutuos vigentes. GET pagina por ID y el cliente ordena position/id; público significa autenticados. Recibo de creación conserva ID incluso tras borrado (410), payload distinto 409. PRAYERS_API_ENABLED sigue false hasta el corte revisado; auth ocurre antes del gate y no hay consultas con flag apagado.

## Procedimiento de migraciones y corte

Orden manual exacto, después de respaldo y detención de escritores antiguos:

1. migrations/20261020_prayers_audience.sql
2. migrations/20261020_prayer_creation_requests.sql
3. migrations/20261021_complete_api.sql

La tercera corre en BEGIN/COMMIT y falla sin cambios ante saldos/importes incompatibles o parejas/pendientes duplicadas o propias. No normaliza ni elimina historial. Conserva saldos, movimientos, oraciones y medallas; retira los PIN planos y su default sin importarlos como credenciales válidas. Agrega hash/intentos/bloqueo, recibos y constraints. No ejecutar el servidor nuevo contra esquema pendiente para uso real.

Antes de aplicar: respaldo verificable con restauración ensayada, recuentos/huellas de todas las tablas, auditoría de datos incompatibles y revisión de SQL. Después: comparar saldos y registros exactamente, validar constraints/índices/funciones y crear PIN nuevos con cuentas de prueba aisladas. Publicar cliente HTTP inspeccionado, impedir acceso de clientes SQL antiguos y rotar/revocar credenciales expuestas. Verificar que el servidor use la nueva credencial privada y que la antigua ya no conecte. Sólo después habilitar PRAYERS_API_ENABLED=true. No existe un flag de transferencias: el corte de acceso y el despliegue controlado son obligatorios. Esta implementación no ejecuta ese procedimiento.

Rollback antes de COMMIT: ROLLBACK conserva datos originales. Tras aplicación: detener clientes API/escritores, revertir sólo a un backend compatible manteniendo columnas, constraints y todos los recibos; no vaciar recibos ni restaurar PIN planos/defaults/acceso SQL móvil. Si no hay backend compatible, mantener servicio detenido mientras se corrige. Restaurar un backup completo sólo bajo plan explícito que reconcilie todas las operaciones posteriores; nunca revertir saldos desde una copia obsoleta.

## Verificación

`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Los tests no leen .env ni acceden a servicios reales. PGlite ejecuta migraciones y SQL de producción: preflight, preservación, ownership, exactitud, lockout, replay/conflicto y fallos después de débito/crédito/asientos/aviso/recibo con rollback completo. PGlite serializa conexiones y no certifica contención MVCC real.

Opt-in EXCLUSIVAMENTE contra una base Neon desechable VACÍA: configurar NEON_ISOLATED_TEST_URL distinta de DATABASE_URL y NEON_ISOLATED_TEST_CONFIRM=EMPTY_DISPOSABLE_DATABASE, luego `npm run test:neon:isolated`. El script rehúsa bases con tablas, crea un esquema aleatorio, ejecuta fixtures/migración y pruebas multiconexión de replay/sobregiro/follows/PIN y presencia que espera un lock más de cinco segundos; elimina sólo el esquema generado. Nunca forma parte de npm test, nunca usar la base de la aplicación. No se ejecutó automáticamente.

Móvil: npm test, npm run typecheck, npm run guard:http; export web con variables ficticias y guardia --bundle. Las pruebas React montan consumidores reales, transporte HTTP controlado y cambios de cuenta/sesión, abortos, target rápido y recuperación. No sustituyen Expo Go/dispositivo ni la verificación remota posterior. Los builds no consultan Neon.
