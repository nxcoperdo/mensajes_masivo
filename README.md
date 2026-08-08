# Envío masivo de WhatsApp

![Code Repair Tech](public/assets/code-repair-tech-header.png)

Proyecto standalone (separado de GigantYA) para mandar una plantilla de
WhatsApp Business aprobada en Meta a una lista propia de contactos.

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

## Login

Toda la app (API y frontend) pide usuario y contraseña por HTTP Basic
Auth, definidos en `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` del `.env`.
Si esas variables están vacías, no pide login (solo para dev local).

Si la contraseña incluye `#`, ponela entre comillas en el `.env`
(`BASIC_AUTH_PASS="algo#raro"`), porque `dotenv` interpreta `#` como
inicio de comentario en valores sin comillas.

Esto alcanza para uso interno con pocos usuarios, pero no reemplaza
HTTPS: en el VPS, servite detrás de Nginx con Let's Encrypt para que
las credenciales no viajen en texto plano.
