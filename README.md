# wppcrm — CRM multi-cliente conectado a WhatsApp

Plataforma donde **vos** (dueño) creás clientes, y **cada cliente** vincula su propio
WhatsApp con un QR y trabaja sus conversaciones desde un CRM, con difusiones masivas
que respetan las reglas anti-baneo del bot original (`fau.js`).

> Para desplegarlo en el VPS: **[DEPLOY.md](DEPLOY.md)**.

---

## Qué hace

**Panel del dueño** (`/admin`)
- Alta de clientes: crea su CRM, su usuario y su línea de WhatsApp de una vez
- Plan, cantidad de líneas y tope diario de mensajes por cliente
- Suspender / reactivar / eliminar clientes
- Estado en vivo de todas las líneas conectadas
- Entrar al CRM de cualquier cliente para dar soporte

**CRM del cliente** (`/app`)
- Botón **Conectar WhatsApp** → QR en pantalla, se actualiza solo por WebSocket
- Lista de chats con último mensaje, no leídos, fijados, etiquetas y estado
- **Responder desde el CRM**, con tipeo simulado antes de enviar
- **Enviar archivos**: imagen, video, audio, nota de voz y documentos
  (botón 📎, arrastrar y soltar, o pegar del portapapeles)
- Ver **cuándo escribió por última vez** cada contacto y quién habló último
- Ordenar por: recientes · última respuesta · más fríos · no leídos · zona · nombre
- **Separar chats por código de área**: `54` → Argentina, `54 223` → Mar del Plata
- **Selección múltiple** con Ctrl+click, Shift+click y "Todos" → acciones masivas
- Difusiones masivas segmentadas por provincia y ciudad
- **Publicar estados** de WhatsApp (texto con fondo, imagen o video)
- Plantillas, respuestas rápidas, notas internas y recordatorios de seguimiento

### Funciones de WhatsApp replicadas

| En el chat | En cada mensaje |
|---|---|
| Archivar / desarchivar | Responder citando |
| Silenciar (8 h / 1 semana) | Reaccionar con emoji |
| Fijar (también en WhatsApp) | Reenviar a otro chat |
| Marcar como no leído | Destacar ⭐ |
| Vaciar conversación | Editar (dentro de los 15 min) |
| Eliminar chat | Eliminar para todos |
| Bloquear contacto | Descargar el archivo recibido |
| Foto de perfil, en línea y última vez | |

Las acciones se aplican **en el WhatsApp real**, no solo en la base del CRM.

### Selección múltiple

| Gesto | Qué hace |
|---|---|
| Click | Abre la conversación |
| **Ctrl/⌘ + click** | Agrega o saca ese chat de la selección |
| **Shift + click** | Selecciona todo el rango desde el último |
| Click (con selección activa) | Sigue sumando, sin tener que mantener Ctrl |
| Botón **Todos** | Selecciona **todo lo filtrado**, no solo lo que está en pantalla |

Con la selección hecha: etiquetar, marcar leídos, fijar, archivar, cambiar estado,
programar seguimiento, **exportar a CSV** o **difundir exactamente a esos contactos**.

---

## Cómo evita el baneo

Todo lo que hacía `fau.js`, ahora configurable por difusión desde el panel:

| Mecanismo | Detalle | Por defecto |
|---|---|---|
| Espera aleatoria entre mensajes | Nunca dos envíos con el mismo intervalo | 20 s – 5 min |
| Bloques con pausa larga | Cada N envíos frena un rato | 25 msj → pausa 2–5 min |
| Ventana horaria | Fuera de hora duerme hasta la próxima apertura | 07:00 – 23:30 (AR) |
| Tope diario por cliente | Corta y sigue al día siguiente | 300 |
| Sin repetidos | Nadie recibe dos veces, ni tras reiniciar el server | por campaña + cooldown 30 días |
| Mensaje único | Spintax + sinónimos + IA opcional | activado |
| Tipeo simulado | 28 ms por caracter, entre 1,5 y 5,5 s | activado |
| Envío forzado | `WPP.chat.sendTextMessage(..., {createChat:true})` | activado |

> **Sobre el envío forzado:** `client.sendText()` de wppconnect no pasa
> `createChat: true` a wa-js, así que con números que nunca te escribieron el envío
> falla **en silencio** (loguea OK y no manda nada). El sistema usa primero la ruta
> interna de `WPP.chat` y solo cae a `sendText()` si esa no está disponible.
> Es exactamente el fix que tenías en `fau.js` (ver [`sender.js`](server/src/whatsapp/sender.js)).

### Variantes de mensaje

**Spintax** — se elige una opción al azar en cada envío, y se puede anidar:

```
{Hola|Buenas|Qué tal} {{nombre}}!

{Te escribo para contarte|Quería comentarte} que {ya abrimos|está abierta} la agenda.
```

**Variables** disponibles:

| Variable | Reemplaza por |
|---|---|
| `{{nombre}}` | Primer nombre del contacto (sin emojis) |
| `{{saludo}}` | Saludo al azar + nombre |
| `{{ciudad}}` | Localidad deducida del código de área |
| `{{provincia}}` | Provincia |
| `{{pais}}` | País |
| `{{cierre}}` | Frase de cierre al azar |
| `{{fecha}}` / `{{fecha_larga}}` | Fecha argentina |

**Sinónimos** — un diccionario rioplatense cambia palabras al azar según la
intensidad elegida (suave / media / alta). Editable en
[`message.service.js`](server/src/services/message.service.js).

**IA (opcional)** — con `OPENAI_API_KEY` cargada, cada mensaje se reescribe con
OpenAI manteniendo la información intacta. Incluye la guarda de `fau.js`: si la IA
inventa un precio que no estaba en el original, se descarta la reescritura.

---

## Detección de zona por prefijo

Prefijo más largo gana: se prueban 4 dígitos, después 3 y por último 2.

```
5492234077440
 └54┘ Argentina
    └9┘ móvil (no es parte del área)
      └223┘ Mar del Plata, Buenos Aires
```

Los códigos viven en JSON editable, sin tocar el código:
- [`ar-area-codes.json`](server/src/data/ar-area-codes.json) — áreas argentinas
- [`country-codes.json`](server/src/data/country-codes.json) — países

Si aparece un área que no está en la tabla, el contacto **igual queda agrupado**
como `Argentina · área XXX`, así que nunca se pierde. Agregá la entrada al JSON y
reiniciá `app` para que muestre el nombre de la localidad.

---

## Estructura

```
wppcrm/
├─ docker-compose.yml         postgres + app + nginx + certbot
├─ .env.example               copiar a .env
├─ nginx/
│  ├─ templates/              config activa (HTTP, para emitir el certificado)
│  └─ ssl/                    config con HTTPS (copiar a templates/ después)
├─ server/
│  ├─ Dockerfile              node 20 + chromium
│  ├─ src/
│  │  ├─ index.js             arranque: db → migración → http → sesiones → difusiones
│  │  ├─ app.js               express, helmet/CSP, estáticos
│  │  ├─ config/              env y pool de postgres
│  │  ├─ db/                  schema.sql + migración idempotente
│  │  ├─ routes/              auth · admin · sessions · chats · campaigns
│  │  ├─ middleware/          JWT, resolución de tenant, errores
│  │  ├─ services/
│  │  │  ├─ tenant.service.js     alta de clientes
│  │  │  ├─ chat.service.js       contactos, chats, mensajes
│  │  │  ├─ message.service.js    spintax + sinónimos + IA
│  │  │  └─ campaign.service.js   MOTOR DE DIFUSIÓN
│  │  ├─ whatsapp/
│  │  │  ├─ sessionManager.js     una sesión wppconnect por cliente
│  │  │  ├─ sender.js             envío forzado + tipeo simulado
│  │  │  ├─ handlers.js           entrantes → base + WebSocket
│  │  │  └─ jid.js                resolución de JID
│  │  ├─ realtime/            socket.io + bus de eventos
│  │  ├─ utils/               teléfono · hora AR · random · logger
│  │  └─ data/                códigos de área y de país (JSON editable)
│  └─ public/                 frontend sin build: login · admin · crm
└─ fau.js                     bot original, dejado como referencia
```

---

## Aislamiento entre clientes

- Cada consulta lleva `tenant_id` explícito; ninguna ruta puede cruzar datos.
- El usuario de un cliente **no puede** pedir otro tenant: se ignora lo que mande.
- Cada sesión de WhatsApp guarda sus tokens en una carpeta propia.
- Eliminar un cliente borra en cascada sus chats, mensajes, contactos y difusiones.

---

## Desarrollo local

```bash
docker compose up -d db
cd server
npm install
# Windows PowerShell:
$env:DATABASE_URL="postgres://wppcrm:wppcrm@localhost:5432/wppcrm"
$env:JWT_SECRET="dev"
npm run dev
```

Abrí `http://localhost:3000`. En local, Chromium se toma del que tengas instalado:
si hace falta, definí `CHROME_PATH` apuntando a tu `chrome.exe`.

---

## API

Todas las rutas cuelgan de `/api` y usan la cookie de sesión.

| Método | Ruta | Para qué |
|---|---|---|
| `POST` | `/auth/login` · `/auth/logout` · `/auth/password` | Sesión |
| `GET` | `/auth/me` | Usuario + cliente actual |
| `GET/POST/PATCH/DELETE` | `/admin/tenants…` | Clientes *(solo dueño)* |
| `GET` | `/sessions` | Líneas de WhatsApp |
| `POST` | `/sessions/:id/connect` · `/logout` · `/sync` | Vincular, desvincular, sincronizar |
| `GET` | `/chats` · `/chats/zonas` · `/chats/resumen` · `/chats/tags` | Listado, facetas, etiquetas |
| `GET/POST` | `/chats/:id/messages` | Conversación y respuesta |
| `POST` | `/chats/:id/archivo` | Adjuntos (multipart) |
| `POST` | `/chats/:id/mensajes/accion` | Responder · reaccionar · reenviar · destacar · editar · eliminar |
| `POST` | `/chats/:id/accion` | Archivar · silenciar · no leído · vaciar · bloquear · eliminar |
| `GET` | `/chats/:id/info` | Foto de perfil, en línea, última vez |
| `POST` | `/chats/:id/notas` · `/seguimiento` | Notas internas y recordatorios |
| `GET/POST` | `/chats/ids` · `/masivo` · `/exportar` | Selección múltiple, acciones masivas y CSV |
| `GET/POST/DELETE` | `/chats/respuestas-rapidas` | Respuestas rápidas |
| `POST` | `/status/texto` · `/status/media` | Publicar estados |
| `GET` | `/media/:tenantId/:archivo` | Archivos (aislados por cliente) |
| `POST` | `/campaigns` · `/:id/start` · `/pause` · `/cancel` | Difusiones |
| `POST` | `/campaigns/preview` · `/audience` | Variantes y tamaño de audiencia |

Eventos WebSocket: `session:status` · `message:new` · `message:ack` ·
`campaign:progress` · `campaign:status` · `chats:synced`.
