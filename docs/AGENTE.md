# Agente de ventas IA (Code Repair Tech) dentro de whatsapp-broadcast

Documento de referencia de todo lo construido e implantado en noviembre de 2026.
**No contiene claves ni contraseñas**: viven en la base de datos del VPS (`agente_config`) y en `.env`.

## 1. Qué es

Un agente de ventas por WhatsApp que usa Claude (API de Anthropic). Antes era el proyecto
standalone `crt-agente`; ahora vive **dentro de este repo** (`agente/`) y comparte el webhook, la base
SQLite, las credenciales de Meta y el login multi-cliente del broadcast.

Flujo completo:

```
Google Maps (negocios) ─► leads_prospectos ─► plantilla "presentacion_crt" (Meta)
                                                      │
                          el cliente toca "Sí, cuéntame" o escribe
                                                      │
        presentación corta con enlace ─► Claude conversa, califica, guarda ficha
                                                      │
        cuotas / cotización / "quiero empezar" / llamada ─► 🔥 alerta Telegram
                                                      │
                                   el agente se calla (modo humano); cierra Nicolás
```

Solo actúa para la cuenta dueña del agente (`AGENTE_EMAIL`, por defecto
`nicolasperdomoliz@gmail.com`) y solo en el número elegido en el panel. Cualquier otro número/cliente
del broadcast no se toca.

## 2. Código

| Archivo | Qué hace |
|---|---|
| `agente/index.js` | BD (tablas `agente_*`), hook del webhook, cola por teléfono, comandos del dueño (`#leads #ficha #tomar #devolver #cerrado #perdido #r`), envíos programados, reenvío, vigilante, alertas, resumen diario, router `/api/agente/*` |
| `agente/claude.js` | Llamada a Anthropic por `fetch` con bucle de herramientas (`guardar_datos`, `pasar_a_nicolas`, `marcar_no_interesado`) |
| `agente/knowledge.js` | Prompt/conocimiento por defecto (precios, tono, 11 reglas estrictas, cuotas, regla "ya tiene web"); editable desde el panel |
| `public/agente.js` + pestaña en `public/index.html` | Pestaña **Agente** del panel (solo visible para el dueño) |
| `server.js` | Monta `/api/agente`, llama a `alRecibirMensaje` en `procesarWebhookWhatsApp`, expone `agente` en `/api/auth/yo` |
| `leads.js` | Se añadieron `resenas`/`calificacion` y filtro de negocios operativos (Google Places) |
| `scripts/vps/` | Vigilante y backup que corren en el VPS (cron) |
| `scripts/maps-scrape.browser.js` | Extracción de teléfonos desde Google Maps con el navegador (ver §7) |

### Tablas (se crean solas al arrancar)
`agente_config` (una fila por cliente: activo, número, modelo, claves, prompt, plantilla, límite diario,
Telegram, dueño…), `agente_contactos` (ficha: estado `nuevo|contactado|conversando|caliente|cerrado|perdido|baja`,
modo `agente|humano`, nicho, `sitio_web`, `reenviado`…), `agente_chat` (historial para Claude),
`agente_programados` (envíos programados: `tipo` `primer|reenvio`, `ciudad`, `nicho`).
Además se añadieron columnas `resenas`, `calificacion` a `leads_prospectos`.
Los mensajes también se registran en `mensajes` para verlos en la pestaña Webhook.

### API del panel (`/api/agente/*`, solo dueño; el resto recibe 403)
`GET/PUT /config`, `GET /numeros`, `GET /estadisticas`, `GET /contactos`, `GET /conversacion/:tel`,
`POST /contactos/:tel/{tomar|devolver|cerrado|perdido|responder}`, `POST /prospectar`, `GET /prospectos`,
`POST /contactar` (con `prueba:true` no envía), `POST /programar`, `GET /programados`,
`DELETE /programados/:id`, `POST /probar-alertas`.

## 3. Comportamiento del agente (reglas importantes)

- **"Sí, cuéntame"** (primer toque del botón): mensaje fijo corto con el enlace de `crt_url` y una pregunta;
  después sigue Claude.
- **Cuotas / cierre:** si el cliente no puede pagar todo, pide cotización, quiere empezar, pide llamada…, el agente
  dice que sí se puede pagar en cuotas y pasa el cliente a Nicolás de inmediato (`pasar_a_nicolas`: ficha → `caliente`,
  modo `humano`, alerta Telegram).
- **Red de seguridad por código** (`SENAL_CIERRE`): si hay señal de compra y Claude no pasó al cliente, el sistema lo pasa.
- **Ya tiene web:** no ofrece web nueva; ofrece sistemas (citas, membresías, pedidos, inventario, mensajería…).
  Si solo tiene redes, sí ofrece web/landing. Se guarda `sitio_web` al enviar la presentación.
- **Nunca en silencio:** reintentos (3), mensaje de respaldo si todo falla + alerta ⚠️, y un **vigilante** cada minuto
  que reintenta clientes cuyo último mensaje lleva >2 min sin respuesta (20 h de ventana).
- **Respuestas automáticas de WhatsApp Business** ("Gracias por comunicarte…", "En este momento no podemos responder…"):
  `esRespuestaAutomatica()` las detecta, se guardan con `rol = 'auto'` y el agente NO contesta (un bot no habla con otro bot).
  El contacto sigue en `contactado`. Si después escribe una persona real, se atiende normal.
- **Notas de voz / archivos:** pide que lo escriban (no hay transcripción).
- **Modo humano (💬 en Telegram):** si el chat está en modo humano el agente no contesta y solo reenvía a Telegram.
  Se activa con "Tomar"/"Cerrado"/"Perdido" del panel o los comandos `#`.

## 4. Lecciones técnicas (errores ya resueltos)

1. Con el system prompt cambiando entre vueltas del bucle (la ficha se actualiza con `guardar_datos`), Anthropic rechaza
   los bloques `thinking`. Solución: fijar el `system` una vez por respuesta.
2. Con razonamiento activo por defecto, 600 `max_tokens` se gastaban "pensando" y no quedaba texto
   (`stop_reason: max_tokens`). Solución: `thinking: { type: 'between_tools' }` y `max_tokens: 2048`
   (este modelo no acepta `disabled`).
3. A veces la respuesta trae `tool_use` con `stop_reason: end_turn`: las herramientas se ejecutan siempre que existan.
4. Al editar JS desde scripts Python no usar `\b`/`\n` en cadenas normales (se convierten en caracteres de control).

## 5. VPS (producción)

- Servidor: Ubuntu, IP `2.25.80.190` (acceso SSH como `root`; **la contraseña no se guarda aquí**).
- Proyecto: `/root/whatsapp-broadcast`, proceso **pm2** `whatsapp-broadcast`, puerto `4100`,
  nginx `masivowa.duckdns.org → localhost:4100`, Node 22. `pm2` arranca con el sistema (`pm2 save` hecho).
- Otras apps en el mismo VPS (no tocar): `agro-valor`, `capc-sync`, `capc-sync-pilot`, `golazo`.
- Variable añadida a `.env`: `AGENTE_EMAIL`. El resto de la configuración del agente está en la tabla `agente_config`
  (clave de Anthropic, Telegram, número, plantilla, dueño, link…), editable desde la pestaña Agente.
- **Cron:** `* * * * * /root/agente-watchdog.sh` (reinicia si no responde y avisa por Telegram; avisa disco ≥90 %) y
  `30 3 * * * /root/agente-backup.sh` (copia diaria de `data.db` a `/root/backups-db`, 7 días).
  Los scripts versionados están en `scripts/vps/`.
- Backup previo a los cambios: `/root/backups-agente-2026-11-21-2238` (`data.db` y `.env`).

### Despliegue
Desde la carpeta del repo (se usó `tar` sobre SSH; también sirve `git pull` en el VPS):
```bash
tar cf - agente public/agente.js public/index.html server.js leads.js | ssh root@2.25.80.190 \
  'cd /root/whatsapp-broadcast && tar xf - && pm2 restart whatsapp-broadcast --update-env'
```

## 6. Configuración actual del agente (nov 2026)

- Cuenta dueña: `nicolasperdomoliz@gmail.com` (cliente 1, admin).
- Número del agente: `phone_number_id 1297983446724874` (Code Repair Tech, +57 312 3736062).
- Plantilla de Meta: `presentacion_crt`, idioma `es_CO`, categoría Marketing, botones "Sí, cuéntame" / "No, gracias"
  (el botón quedó aprobado con el texto "Si,cuentame": corregir en Meta cuando se pueda).
- Modelo: `claude-sonnet-5-5`. Alertas: Telegram (bot `@crt_contable_bot`) y/o WhatsApp al número del dueño.
- Link de la empresa: `https://coderepair.site/`. Límite diario: 45 (subido desde 20).

### Campaña programada: 45 negocios de Neiva
- Lista armada desde Google Maps (6 rubros: peluquerías, restaurantes, odontólogos, gimnasios, tiendas de ropa, ferreterías),
  solo celulares, sin cadenas; 33 sin web, 10 solo redes, 2 con web. Marcados con rubro `cmaps-neiva <rubro>`.
- `agente_programados` #1: tipo `primer`, 2026-11-22 14:00 UTC (9:00 a. m. Colombia), 45, nicho `cmaps-neiva`, ciudad `Neiva`.
- `agente_programados` #2: tipo `reenvio`, 2026-11-23 14:00 UTC (9:00 a. m.), envía UNA vez un **seguimiento** a quienes
  siguen en estado `contactado`. Usa una plantilla DISTINTA (`agente_config.plantilla_reenvio`, p. ej. `seguimiento_crt`);
  si no está configurada no envía nada y avisa por Telegram. Excluye números con envío `fallido` y prioriza `leido` > `entregado` > `enviado`.
  Al terminar cada envío llega un resumen por Telegram.
- Resultado del 22-nov (primer envío 9:00 a. m., domingo): 45 enviados; a los ~45 min: 29 entregados, 7-10 leídos, 5 fallidos y 13 números
  devolvieron respuestas automáticas; ninguna persona respondió todavía (muchos negocios abren el lunes).
- Plantilla de seguimiento propuesta (`seguimiento_crt`, Marketing, es_CO, botones "Sí, cuéntame" / "No, gracias"): saludo con `{{1}}` = nombre del negocio,
  "Somos Code Repair Tech, de Neiva… ¿Cómo manejan eso hoy? Si quieres, te mostramos un ejemplo sin compromiso."

## 7. Prospección sin Google Places

Google Places quedó suspendido. Alternativa usada: abrir Google Maps en el navegador y leer cada ficha
(`scripts/maps-scrape.browser.js`): teléfono, reseñas y si tiene web. Luego se cargan a `leads_prospectos`
con `rubro = 'cmaps-neiva <rubro>'`, `direccion = 'Neiva, Huila'` y se programa con `POST /programar`
(`nicho: 'cmaps-neiva'`, `ciudad: 'Neiva'`). Puntaje de prioridad: sin web +60, solo redes +35, celular +25,
reseñas hasta +25. Solo se escribe a celulares colombianos (`573XXXXXXXXX`).

## 8. Monitoreo

Alertas por Telegram: cliente listo para cerrar (🔥), mensaje recibido con el chat en modo humano (💬), fallo del agente (⚠️),
servidor caído/reiniciado (🚨/⚠️/ℹ️/✅), fin de envío programado (📤) y **resumen diario a las 8:00 p. m.** hora Colombia.

## 9. Pendientes y seguridad

- Rotar credenciales que se pegaron en el chat durante el desarrollo: clave de Anthropic, token del bot de Telegram y
  contraseña SSH de root (idealmente pasar a llave SSH y deshabilitar contraseña).
- Corregir el texto del botón en Meta ("Sí, cuéntame") y crear/aprobar `seguimiento_crt`; luego ponerla en la pestaña Agente → "Plantilla de seguimiento".
- Monitor externo (p. ej. UptimeRobot sobre `masivowa.duckdns.org`) por si cae el VPS completo.
- Posible mejora: transcripción de notas de voz (Anthropic no procesa audio).
- Mucho envío en frío puede bajar la calidad del número en Meta: vigilar el WhatsApp Manager.
