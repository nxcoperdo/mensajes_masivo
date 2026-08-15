# Envío masivo de WhatsApp

![Code Repair Tech](public/assets/code-repair-tech-header.png)

Proyecto standalone (separado de GigantYA) para mandar una plantilla de
WhatsApp Business aprobada en Meta a una lista propia de contactos.
Es **multi-cliente**: cada negocio se registra, conecta su propia
cuenta de WhatsApp Business con el flujo "Embedded Signup" de Meta, y
ve únicamente sus propios contactos/campañas/conversaciones.

Desarrollado y mantenido por **Code Repair Tech Inc.**, el mismo equipo
detrás de GigantYA.

## Qué hace

1. Subís un CSV con `telefono` y `nombre` (o los agregás a mano) — se
   guardan en una base SQLite local (`data.db`, un solo archivo, sin
   servidor de BD que instalar).
2. Elegís a quién de esa lista mandarle el mensaje.
3. Escribís el nombre exacto de una plantilla ya aprobada en tu cuenta
   de Meta Business, y definís sus parámetros `{{1}}`, `{{2}}`... —
   cada uno puede ser el nombre del contacto (personalizado por
   persona) o un texto fijo igual para todos.
4. Le das a "Enviar campaña" y se manda a todos los seleccionados, con
   una pausa chica entre cada uno para no saturar la API de Meta.
5. Podés ver el progreso en vivo y el historial de campañas con el
   detalle de quién recibió el mensaje y quién falló (y por qué).

## Instalación

```bash
npm install
cp .env.example .env
# Editar .env con tus credenciales de WhatsApp Business Cloud API
# (pueden ser las mismas que usa GigantYA, o las de otro número)
npm start
```

Abrir `http://localhost:4100` (o el puerto que hayas puesto en `.env`).

## Notas

- Las plantillas se crean y aprueban en Meta Business Manager, esta
  app NO las crea — solo las usa (tenés que escribir el nombre EXACTO
  tal cual está registrado en Meta).
- El límite de mensajes que podés iniciar por día lo define el "tier"
  de tu número de WhatsApp Business en Meta (250 → 1,000 → 10,000...),
  no esta app.
- Para desplegar esto en un servidor (VPS), correr con PM2 igual que
  cualquier app Node: `pm2 start server.js --name whatsapp-broadcast`.

## Login y cuentas de cliente

Cada cliente se registra con email/contraseña (`/registro.html`) y
entra con `/login.html` — sesión por cookie firmada (`SESSION_SECRET`
en `.env`). Los datos de cada tabla (`contactos`, `campanas`, `envios`,
`mensajes`, `leads_prospectos`) están aislados por `cliente_id`; ningún
cliente puede ver los datos de otro.

Al arrancar con la base de datos vacía, se siembra un primer cliente
("Code Repair Tech") con las credenciales de `BASIC_AUTH_USER`/
`BASIC_AUTH_PASS` (o una contraseña generada si no están definidas —
queda impresa una sola vez en el log) y, si `WHATSAPP_PHONE_NUMBER_ID`/
`WHATSAPP_API_TOKEN` ya están en el `.env`, con WhatsApp ya conectado.
Ese Basic Auth viejo ya no protege nada por sí mismo — es solo el
origen de esas credenciales sembradas.

No reemplaza HTTPS: en el VPS, servite detrás de Nginx con Let's
Encrypt para que las contraseñas y cookies no viajen en texto plano.

### Conectar WhatsApp Business (Embedded Signup)

Un cliente nuevo entra con `estado: 'pendiente_whatsapp'` y ve la
pantalla "Conectar WhatsApp Business" en vez de las pestañas normales.
Ese botón abre el popup de Meta (SDK de JS) para que autorice su propia
cuenta — el `code` que devuelve se cambia por un access token en
`POST /api/clientes/whatsapp/conectar`, que además suscribe la app a
esa WABA para empezar a recibir su webhook.

Para que este flujo funcione hace falta, del lado de Meta App
Dashboard:

1. Verificación de Negocio de Code Repair Tech (Meta Business Suite).
2. App Review pidiendo Advanced Access a `whatsapp_business_management`
   y `whatsapp_business_messaging` (incluye un video mostrando el flujo
   funcionando — se puede grabar primero en modo Development con una
   WABA de test).
3. Una configuración de Embedded Signup (WhatsApp → Configuration →
   Embedded Signup) que da el `config_id`.
4. Una "Valid OAuth Redirect URI" cargada en Facebook Login for
   Business — usá `https://tu-dominio/oauth/callback` (ya existe esa
   ruta en el server, es solo una página de cortesía).

Variables nuevas en `.env`: `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`,
`FACEBOOK_EMBEDDED_CONFIG_ID`, `WHATSAPP_WABA_ID`, `SESSION_SECRET`
(ver `.env.example` para el detalle de cada una).

## Prospección de leads (B2B)

Módulo independiente para conseguir prospectos: busca negocios por
rubro y ciudad (ej. "restaurantes" en "Neiva Huila") y guarda los que
tengan teléfono, con su link de WhatsApp ya armado, para que los
contactes manualmente y les ofrezcas el servicio. **Estos leads son
100% independientes de la tabla de `contactos`/`campanas` — nunca se
usan para enviar mensajes automáticamente ni se mezclan con esa lista.**

### Endpoints

- `POST /api/leads/buscar` — body `{ "query": "restaurantes", "ciudad": "Neiva Huila" }`.
  Busca negocios, descarta los que no tienen teléfono, y guarda los
  nuevos (evita duplicados por teléfono). Responde:
  ```json
  { "proveedor": "osm", "total_encontrados": 12, "nuevos": 9, "duplicados": 3 }
  ```
- `GET /api/leads` — lista los leads guardados. Filtro opcional
  `?estado=nuevo` (o `contactado`, `cliente`, o el valor que uses).
- `PATCH /api/leads/:id` — body `{ "estado": "contactado" }` para
  actualizar el estado a mano a medida que los vas gestionando (ej:
  `nuevo` → `contactado` → `cliente`).

### Qué proveedor de búsqueda queda activo

- **Con `GOOGLE_PLACES_API_KEY` configurada en `.env`** (recomendado):
  usa Google Places (Text Search + Place Details) — resultados más
  completos y confiables. Requiere una cuenta de Google Cloud con
  facturación habilitada (tiene free tier mensual, pero la key no
  funciona sin tarjeta asociada) y tener la "Places API" habilitada en
  el proyecto de Google Cloud.
- **Sin key configurada** (comportamiento por defecto de este repo
  ahora mismo): cae automáticamente a **Nominatim + Overpass**
  (OpenStreetMap), gratis y sin necesidad de registrarte. La cobertura
  de negocios depende de qué tan completo esté el mapeo de OSM en esa
  zona — puede traer menos resultados que Google en ciudades chicas.

Para pasar de uno a otro no hay que tocar código: solo completar (o
vaciar) `GOOGLE_PLACES_API_KEY` en `.env` y reiniciar la app.

Variables relevantes en `.env.example`: `GOOGLE_PLACES_API_KEY`,
`NOMINATIM_USER_AGENT` (identifica tu app ante Nominatim, requerido
por su política de uso), `LEADS_RADIO_METROS` (radio de búsqueda
alrededor del centro de la ciudad, default 5km) y
`LEADS_MAX_RESULTADOS` (tope de resultados por búsqueda, default 20 —
también limita cuántos Place Details se piden a Google por búsqueda).
