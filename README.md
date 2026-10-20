# Alamedapp API — base Expo, Clerk y Neon

Requiere Node 24 y npm. Mantiene Next.js, Drizzle y el driver HTTP de Neon instalados.

## Instalación y configuración

1. Ejecutar `npm ci` en este repositorio.
2. Crear manualmente `.env.local` usando `.env.example` como guía. No copiar archivos `.env` del móvil ni de otros proyectos.
3. Configurar `DATABASE_URL` privada con el destino Neon actual y `sslmode=require` o `verify-full`. Sólo se admiten hosts `*.neon.tech`. No definir esta conexión como variable pública ni mediante `next.config`.
4. Configurar `CLERK_SECRET_KEY` o `CLERK_JWT_KEY` (PEM pública para verificación sin consulta JWKS) de la misma instancia Clerk del móvil. `CLERK_AUTHORIZED_PARTIES` es una lista separada por comas con los valores `azp` legítimos de la app. Es obligatoria. En sesiones nativas Clerk puede omitir `azp`; si está presente debe coincidir con esa lista.
5. `API_ALLOWED_ORIGINS` contiene orígenes exactos separados por comas para Expo web. No usar comodines. CORS permite Authorization, expone X-Request-Id y declara GET, HEAD, POST, PUT, PATCH, DELETE y OPTIONS; sólo los handlers documentados existen.
6. `DATABASE_TIMEOUT_MS` limita cada fetch Neon (por defecto 5000, máximo 30000). La conexión se inicializa al usarla; importar rutas o compilar no consulta PostgreSQL.
7. Ejecutar `npm run dev -- --hostname 0.0.0.0`.

En Expo configurar `EXPO_PUBLIC_API_URL=http://IP_LAN_DEL_EQUIPO:3000` para un teléfono físico: localhost apunta al teléfono. Permitir el puerto local en la red de desarrollo. Para producción usar HTTPS. La URL pública de la API no contiene credenciales. El hook `useApiClient` obtiene un token Clerk actual en cada petición; `client.getMe({signal})` admite cancelación y timeout de token, red y lectura de cuerpo.

## Contrato de lectura

- `GET /api/health`: 200 `{status:"ok"}`, liveness independiente de DB y Clerk.
- `GET /api/ready`: ejecuta `select 1` con timeout; 200 `{status:"ready"}` o 503 con error genérico. No devuelve host ni detalles de conexión.
- `GET /api/v1/me`: exige `Authorization: Bearer TOKEN`. Verifica firma y vigencia Clerk antes de consultar DB; acepta sólo sesión de usuario (sub y sid), excluye sesión pendiente. Ignora identidades en query. Devuelve 200 `{data:{clerkId,username,email,displayName,avatarUrl,balance,followerCount,followingCount,favoriteVerse,bio,cardColor,createdAt}}`; createdAt es ISO y balance es decimal serializado como string. Selección y DTO explícitos excluyen securityPin.
- Sin sesión válida: 401. Sin fila local: 404; no crea ni modifica cuentas. Fallo de conexión o configuración DB: 503. Configuración de autenticación incompleta u otro fallo interno: 500 genérico.
- Errores JSON: `{error:{code,message,requestId}}`. Todas las respuestas de estos handlers usan `Cache-Control: no-store` y `X-Request-Id`; OPTIONS devuelve 204 con la misma política CORS.

## Transición pendiente

Esta entrega prepara la API y el cliente HTTP; **no completa la separación**. El móvil conserva su sync, polling, consultas y configuración de destino actuales. El nuevo hook no está montado en el árbol legacy y no se aprovisionan cuentas desde la API. Mantener `DATABASE_URL` del backend apuntando al mismo destino de datos cuando se configure para lectura.

Las consultas legacy del backend siguen disponibles como funciones internas, sin exponerse por RPC. El PIN legacy y la credencial pública del bundle móvil se resolverán al migrar todos sus consumidores y rotar credenciales durante el corte. No cambiar el destino de una parte de los usuarios ni habilitar transferencias mediante esta base. No se agregan Docker ni migraciones remotas.

## Verificación sin infraestructura

En backend: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. En móvil: `npm run typecheck` y `npm test`. Las pruebas usan el runner TypeScript nativo de Node 24, sin nuevas dependencias. Generan claves RSA de fixture, verifican Clerk localmente y reemplazan el transporte HTTP Neon; no cargan `.env`, no contactan Neon ni escriben datos. La prueba del driver observa SQL parametrizado, ausencia del PIN y cancelación del fetch con una señal nueva por consulta. Readiness se cubre con dobles disponibles, fallidos y bloqueados.

La página inicial existente descarga Geist durante build con `next/font/google`; requiere acceso de red a Google Fonts. Los handlers API son dinámicos y no requieren claves reales durante build.

Para un smoke manual posterior, configurar las variables en forma privada y consultar primero health y ready; luego enviar un token de sesión propio a `/api/v1/me`. Comparar el clerkId con el sujeto autenticado y comprobar que no exista securityPin; repetir sin Authorization (401), con un userId ajeno en query (sigue devolviendo el propio) y con sesión de fixture sin fila (404). No ejecutar migraciones ni operaciones de escritura. Estas instrucciones no implican que se haya verificado una conexión real.
