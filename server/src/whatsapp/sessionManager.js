// ============================================================
//  Administrador de sesiones de WhatsApp (una por cliente)
//
//  Cada sesión = un cliente wppconnect = un Chromium propio, con su
//  carpeta de tokens aislada en /app/data/tokens/<session_key>.
//  El QR y los cambios de estado se emiten por WebSocket al CRM del
//  cliente dueño de esa sesión.
// ============================================================
const fs   = require("fs")
const path = require("path")
const wppconnect = require("@wppconnect-team/wppconnect")

const env = require("../config/env")
const db  = require("../config/db")
const log = require("../utils/logger")
const bus = require("../realtime/bus")
const { sleep } = require("../utils/random")
const chatService = require("../services/chat.service")
const handlers    = require("./handlers")
const { enviarConTyping } = require("./sender")
const { resolverJidDeChat } = require("./jid")

/** sessionKey -> { client, status, qr, tenantId, sessionId, arrancando } */
const vivas = new Map()

const ESTADOS = {
  DESCONECTADO: "disconnected",
  CONECTANDO:   "connecting",
  QR:           "qr",
  CONECTADO:    "connected",
  ERROR:        "error"
}

// ------------------------------------------------------------
//  Estado en base + WebSocket
// ------------------------------------------------------------
async function setEstado(sesion, status, extra = {}) {
  const campos = { status, ...extra }
  await db.query(
    `UPDATE wa_sessions
        SET status = $2,
            phone        = COALESCE($3, phone),
            last_qr      = $4,
            last_error   = $5,
            connected_at = CASE WHEN $2 = 'connected' THEN now() ELSE connected_at END
      WHERE id = $1`,
    [sesion.id, status, campos.phone || null,
     campos.qr === undefined ? null : campos.qr,
     campos.error || null]
  )

  const memoria = vivas.get(sesion.session_key)
  if (memoria) { memoria.status = status; memoria.qr = campos.qr || null }

  bus.aTenant(sesion.tenant_id, "session:status", {
    sessionId: sesion.id,
    sessionKey: sesion.session_key,
    status,
    phone: campos.phone || null,
    qr: campos.qr || null,
    error: campos.error || null
  })
  bus.aOwners("session:status", { tenantId: sesion.tenant_id, sessionId: sesion.id, status })
}

function carpetaTokens() {
  if (!fs.existsSync(env.tokensDir)) fs.mkdirSync(env.tokensDir, { recursive: true })
  return env.tokensDir
}

function activas() {
  return [...vivas.values()].filter(s => s.status === ESTADOS.CONECTADO || s.status === ESTADOS.CONECTANDO).length
}

/**
 * Borra el candado de perfil que deja Chromium cuando no cierra prolijo.
 *
 * wppconnect usa <tokensDir>/<session_key> como userDataDir. Si el contenedor
 * se recrea (docker compose up --build) mientras el navegador está vivo, queda
 * un SingletonLock apuntando al hostname del contenedor anterior, y el próximo
 * arranque falla con:
 *   "The profile appears to be in use by another Chromium process on another computer"
 *
 * Es seguro borrarlo porque un session_key nunca corre dos veces a la vez:
 * el mapa `vivas` lo impide dentro del proceso, y solo hay un proceso por volumen.
 */
function limpiarBloqueoPerfil(sessionKey) {
  const dir = path.join(carpetaTokens(), sessionKey)
  if (!fs.existsSync(dir)) return

  for (const archivo of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const ruta = path.join(dir, archivo)
    try {
      // lstat, no stat: SingletonLock es un symlink roto y stat() falla.
      fs.lstatSync(ruta)
      fs.rmSync(ruta, { force: true, recursive: true })
      log.info("wa:" + sessionKey, "candado de perfil removido:", archivo)
    } catch (_) { /* no existe: es lo normal */ }
  }
}

// ------------------------------------------------------------
//  ARRANCAR SESIÓN
// ------------------------------------------------------------
/**
 * Levanta el navegador y pide el QR.
 * Devuelve enseguida: el QR llega por WebSocket (evento session:status).
 */
async function iniciarSesion(sesion) {
  const key = sesion.session_key

  const yaViva = vivas.get(key)
  if (yaViva?.arrancando) return { ok: true, mensaje: "La sesión ya se está iniciando" }
  if (yaViva?.client && yaViva.status === ESTADOS.CONECTADO) {
    return { ok: true, mensaje: "La sesión ya está conectada" }
  }

  if (activas() >= env.maxActiveSessions) {
    const msg = "Límite de sesiones simultáneas alcanzado (" + env.maxActiveSessions + "). " +
                "Cerrá una sesión o ampliá MAX_ACTIVE_SESSIONS / la RAM del VPS."
    log.warn("wa", msg)
    return { ok: false, mensaje: msg }
  }

  vivas.set(key, { client: null, status: ESTADOS.CONECTANDO, qr: null, arrancando: true,
                   tenantId: sesion.tenant_id, sessionId: sesion.id })
  await setEstado(sesion, ESTADOS.CONECTANDO)

  limpiarBloqueoPerfil(key)   // por si el contenedor anterior se fue sin cerrar Chromium
  log.info("wa:" + key, "iniciando navegador...")

  // No await: la creación puede tardar minutos esperando el escaneo del QR.
  wppconnect.create({
    session: key,
    folderNameToken: carpetaTokens(),
    mkdirFolderToken: "",
    headless: true,
    autoClose: 0,
    waitForLogin: true,
    logQR: false,
    disableWelcome: true,
    updatesLog: false,
    puppeteerOptions: {
      executablePath: env.chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-zygote",
        "--disable-extensions",
        "--disable-background-networking"
      ]
    },
    catchQR: (base64Qr, _ascii, intentos) => {
      log.info("wa:" + key, "QR generado (intento " + intentos + ")")
      setEstado(sesion, ESTADOS.QR, { qr: base64Qr }).catch(e => log.error("wa", e.message))
    },
    statusFind: (estado) => {
      log.info("wa:" + key, "estado wppconnect:", estado)
      manejarEstadoWpp(sesion, estado).catch(e => log.error("wa", e.message))
    }
  })
  .then(async client => {
    const registro = vivas.get(key) || {}
    vivas.set(key, { ...registro, client, status: ESTADOS.CONECTADO, qr: null, arrancando: false,
                     tenantId: sesion.tenant_id, sessionId: sesion.id })

    let phone = null
    try {
      const host = await client.getHostDevice()
      phone = host?.id?.user || host?.wid?.user || host?.id?._serialized?.split("@")[0] || null
    } catch (e) { log.debug("wa:" + key, "getHostDevice: " + e.message) }

    await setEstado(sesion, ESTADOS.CONECTADO, { phone })
    log.ok("wa:" + key, "conectado" + (phone ? " como " + phone : ""))

    registrarListeners(sesion, client)

    // Sincronización inicial en segundo plano: WhatsApp tarda en poblar el store.
    sleep(15000)
      .then(() => sincronizarChats(sesion))
      .catch(e => log.error("wa:" + key, "sync inicial: " + e.message))
  })
  .catch(async e => {
    log.error("wa:" + key, "no se pudo iniciar:", e.message)
    vivas.delete(key)
    await setEstado(sesion, ESTADOS.ERROR, { error: e.message })
  })

  return { ok: true, mensaje: "Iniciando sesión, esperá el QR" }
}

async function manejarEstadoWpp(sesion, estado) {
  switch (estado) {
    case "isLogged":
    case "inChat":
    case "chatsAvailable":
    case "successChat":
    case "qrReadSuccess":
      await setEstado(sesion, ESTADOS.CONECTADO)
      break
    case "notLogged":
    case "browserClose":
    case "serverClose":
    case "desconnectedMobile":
    case "deviceNotConnected":
      await setEstado(sesion, ESTADOS.DESCONECTADO)
      break
    case "qrReadFail":
      await setEstado(sesion, ESTADOS.ERROR, { error: "No se pudo leer el QR, probá de nuevo" })
      break
    case "autocloseCalled":
    case "deleteToken":
      await setEstado(sesion, ESTADOS.DESCONECTADO, { error: "Sesión cerrada desde el teléfono" })
      vivas.delete(sesion.session_key)
      break
  }
}

function registrarListeners(sesion, client) {
  client.onMessage(async msg => {
    await handlers.procesarMensajeEntrante(sesion, msg)
  })

  if (typeof client.onAck === "function") {
    client.onAck(async ack => { await handlers.procesarAck(sesion, ack) })
  }

  if (typeof client.onStateChange === "function") {
    client.onStateChange(async estado => {
      log.info("wa:" + sesion.session_key, "state:", estado)
      if (["CONFLICT", "UNPAIRED", "UNLAUNCHED"].includes(estado)) {
        try { await client.useHere() } catch (_) {}
      }
    })
  }
}

// ------------------------------------------------------------
//  DETENER / CERRAR
// ------------------------------------------------------------
async function detenerSesion(sesion) {
  const registro = vivas.get(sesion.session_key)
  if (registro?.client) {
    try { await registro.client.close() } catch (e) { log.warn("wa", "close: " + e.message) }
  }
  vivas.delete(sesion.session_key)
  await setEstado(sesion, ESTADOS.DESCONECTADO)
  return { ok: true }
}

/** Cierra sesión en el teléfono y borra los tokens: el próximo inicio pide QR nuevo. */
async function cerrarSesionWhatsapp(sesion) {
  const registro = vivas.get(sesion.session_key)
  if (registro?.client) {
    try { await registro.client.logout() } catch (e) { log.warn("wa", "logout: " + e.message) }
    try { await registro.client.close()  } catch (_) {}
  }
  vivas.delete(sesion.session_key)

  const dir = path.join(carpetaTokens(), sesion.session_key)
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    log.info("wa", "tokens borrados de", sesion.session_key)
  } catch (e) { log.warn("wa", "no pude borrar tokens: " + e.message) }

  await setEstado(sesion, ESTADOS.DESCONECTADO, { phone: null })
  return { ok: true }
}

function obtenerCliente(sessionKey) {
  const r = vivas.get(sessionKey)
  return r?.status === ESTADOS.CONECTADO ? r.client : null
}

function estadoEnMemoria(sessionKey) {
  const r = vivas.get(sessionKey)
  return { status: r?.status || ESTADOS.DESCONECTADO, qr: r?.qr || null }
}

// ------------------------------------------------------------
//  SINCRONIZAR CHATS
// ------------------------------------------------------------
// ------------------------------------------------------------
//  Extracción paginada del store del navegador
//
//  Por qué no alcanza con client.listChats():
//   1. Solo lee WPP.whatsapp.ChatStore (lo que WhatsApp Web ya tiene en
//      memoria); no consulta al servidor.
//   2. Devuelve los MODELOS COMPLETOS, que puppeteer tiene que serializar
//      uno por uno. Con miles de chats eso se vuelve lentísimo o se corta.
//   3. Pasarle count:-1 hace slice(0,-1) adentro de wa-js: se come el último
//      chat de la lista (de ahí el 503 en vez de 504).
//
//  Acá recorremos el store por tramos y devolvemos objetos planos y chicos,
//  así la serialización es constante y no importa cuántos chats haya.
// ------------------------------------------------------------

/** Le pide a WhatsApp Web que rehidrate su colección de chats. */
async function empujarStore(client) {
  try {
    await client.page.evaluate(async () => {
      try { await WPP?.whatsapp?.ChatStore?.sync?.() } catch (_) {}
    })
    await sleep(1500)
  } catch (e) {
    log.debug("sync", "empujarStore: " + e.message)
  }
}

/** Devuelve { total, items } o null si el store interno no está disponible. */
async function paginaDeChats(client, desde, cuantos) {
  return client.page.evaluate(({ d, c }) => {
    if (typeof WPP === "undefined" || !WPP.whatsapp || !WPP.whatsapp.ChatStore) return null

    const individuales = WPP.whatsapp.ChatStore.getModelsArray().filter(ch => {
      try { return !ch.id.isGroup() } catch (_) { return false }
    })

    const trozo = individuales.slice(d, d + c)
    const items = trozo.map(ch => {
      const seguro = fn => { try { return fn() } catch (_) { return null } }
      return {
        jid:      seguro(() => ch.id?._serialized || String(ch.id)),
        name:     seguro(() => ch.name || ch.formattedTitle) || null,
        pushname: seguro(() => ch.contact?.pushname || ch.contact?.formattedName) || null,
        t:        seguro(() => ch.t) || null,
        unread:   seguro(() => ch.unreadCount > 0 ? ch.unreadCount : 0) || 0,
        archived: !!seguro(() => ch.archive),
        preview:  seguro(() => (ch.msgs?.last?.body || "").slice(0, 160)) || null
      }
    }).filter(x => x.jid)

    // `leidos` es cuántos modelos consumimos del store; `items` los que
    // sobrevivieron. El bucle tiene que avanzar por `leidos`: si avanza por
    // `items` y alguno se descartó, relee los mismos y puede cortarse antes.
    return { total: individuales.length, leidos: trozo.length, items }
  }, { d: desde, c: cuantos })
}

/** Respaldo si WPP.whatsapp cambia de forma en una versión futura. */
async function traerChatsDeWhatsapp(client) {
  const intentos = [
    // Sin count: wa-js usa Infinity y devuelve todo lo que tenga el store.
    ["listChats",    () => client.listChats({ onlyUsers: true })],
    ["getAllChats",  () => client.getAllChats()],
    ["getListChats", () => client.getListChats()]
  ]
  for (const [nombre, intento] of intentos) {
    if (typeof client[nombre] !== "function") continue
    try {
      const chats = await intento()
      if (Array.isArray(chats) && chats.length) return chats
    } catch (e) {
      log.debug("sync", nombre + " falló: " + e.message)
    }
  }
  return []
}

/**
 * Trae la lista de chats de WhatsApp y la vuelca en la base.
 * Es lo que llena el CRM la primera vez y lo que alimenta las difusiones.
 */
/** Guarda un chat (objeto plano de paginaDeChats) en la base. */
async function guardarChatSincronizado(sesion, item) {
  const contacto = await chatService.upsertContacto(sesion.tenant_id, {
    jid: item.jid, name: item.name, pushName: item.pushname
  })

  const fila = await chatService.upsertChat(
    sesion.tenant_id, sesion.id, contacto.id, item.jid,
    { archived: item.archived, unreadCount: item.unread }
  )

  // chat.t viene en segundos. GREATEST evita pisar un dato más nuevo que ya
  // tengamos por un mensaje entrante recibido durante la sincronización.
  if (item.t) {
    await db.query(
      `UPDATE chats
          SET last_message_at   = GREATEST(COALESCE(last_message_at, to_timestamp(0)), to_timestamp($2)),
              last_message_text = COALESCE(last_message_text, $3)
        WHERE id = $1`,
      [fila.id, item.t, item.preview || null]
    )
  }
  return fila
}

/**
 * Vuelca en la base TODOS los chats del store, en tramos.
 * Es incremental: cada corrida hace upsert, así que se puede repetir sin
 * duplicar nada y va acumulando lo que WhatsApp vaya sincronizando con el
 * tiempo (el teléfono le manda historial al dispositivo vinculado de a poco).
 */
async function sincronizarChats(sesion, { tamanoPagina = 500, maximo = 50000 } = {}) {
  const client = obtenerCliente(sesion.session_key)
  if (!client) return { ok: false, mensaje: "La sesión no está conectada" }

  const key = sesion.session_key
  log.info("wa:" + key, "sincronizando chats por tramos de " + tamanoPagina + "...")

  await empujarStore(client)

  let desde = 0, guardados = 0, omitidos = 0, total = 0, tramos = 0

  while (desde < maximo) {
    let pagina
    try {
      pagina = await paginaDeChats(client, desde, tamanoPagina)
    } catch (e) {
      log.warn("wa:" + key, "tramo desde " + desde + " falló: " + e.message)
      break
    }

    // El store interno no está disponible: caemos a la API pública.
    if (pagina === null) {
      log.warn("wa:" + key, "ChatStore no accesible, uso listChats()")
      return sincronizarConApiPublica(sesion, client)
    }

    total = pagina.total
    // Se corta cuando el store no dio más modelos, no cuando no quedó ningún
    // item válido: una página entera de descartes no significa que se terminó.
    if (!pagina.leidos) break

    for (const item of pagina.items) {
      try { await guardarChatSincronizado(sesion, item); guardados++ }
      catch (e) { omitidos++; log.debug("sync", e.message) }
    }

    desde += pagina.leidos
    tramos++
    log.info("wa:" + key, "tramo " + tramos + ": " + desde + "/" + total)
    bus.aTenant(sesion.tenant_id, "chats:sync-progress", {
      procesados: desde, total, guardados, tramo: tramos
    })

    if (desde >= total) break
    await sleep(200)   // respiro para no trabar el navegador
  }

  if (!guardados && !total) {
    return { ok: false, mensaje: "WhatsApp todavía no cargó los chats, probá de nuevo en un minuto" }
  }

  log.ok("wa:" + key, "sincronizados " + guardados + "/" + total + " chats en " + tramos + " tramo(s)")
  bus.aTenant(sesion.tenant_id, "chats:synced", { guardados, omitidos, total, tramos })
  return { ok: true, guardados, omitidos, total, tramos }
}

/** Camino viejo, por si el store interno deja de estar accesible. */
async function sincronizarConApiPublica(sesion, client) {
  const chats = await traerChatsDeWhatsapp(client)
  if (!chats.length) return { ok: false, mensaje: "WhatsApp todavía no devolvió chats" }

  let guardados = 0, omitidos = 0
  for (const chat of chats) {
    try {
      if (chat.isGroup) { omitidos++; continue }
      const { jid } = await resolverJidDeChat(client, chat)
      if (!jid) { omitidos++; continue }

      await guardarChatSincronizado(sesion, {
        jid,
        name:     chat.contact?.name || chat.name || null,
        pushname: chat.contact?.pushname || chat.contact?.formattedName || null,
        t:        chat.t || null,
        unread:   chat.unreadCount || 0,
        archived: !!chat.archive,
        preview:  (chat.lastMessage?.body || "").slice(0, 160) || null
      })
      guardados++
    } catch (e) { omitidos++; log.debug("sync", e.message) }
  }

  bus.aTenant(sesion.tenant_id, "chats:synced", { guardados, omitidos, total: chats.length, tramos: 1 })
  return { ok: true, guardados, omitidos, total: chats.length, tramos: 1 }
}

/** Trae el historial reciente de un chat desde WhatsApp y lo guarda. */
async function importarHistorial(sesion, chatFila, cantidad = 40) {
  const client = obtenerCliente(sesion.session_key)
  if (!client) return 0

  let mensajes = []
  try {
    mensajes = await client.getMessages(chatFila.wa_chat_id, { count: cantidad, direction: "before" })
  } catch (e) {
    log.debug("historial", e.message)
    return 0
  }

  let nuevos = 0
  for (const m of mensajes || []) {
    const guardado = await chatService.registrarMensaje(sesion.tenant_id, chatFila.id, {
      waMsgId:   m.id?._serialized || m.id || null,
      direction: m.fromMe ? "out" : "in",
      type:      m.type || "chat",
      body:      handlers.describirMensaje(m),
      sentAt:    m.timestamp ? new Date(m.timestamp * 1000) : new Date(),
      status:    m.fromMe ? "sent" : null
    })
    if (guardado) nuevos++
  }
  return nuevos
}

// ------------------------------------------------------------
//  ENVIAR DESDE EL CRM
// ------------------------------------------------------------
async function enviarDesdeCrm(sesion, chatFila, texto, autor) {
  const client = obtenerCliente(sesion.session_key)
  if (!client) throw new Error("La sesión de WhatsApp no está conectada")

  const resultado = await enviarConTyping(client, chatFila.wa_chat_id, texto)

  const mensaje = await chatService.registrarMensaje(sesion.tenant_id, chatFila.id, {
    waMsgId:   resultado.id || null,
    direction: "out",
    type:      "chat",
    body:      texto,
    status:    "sent",
    author:    autor || null
  })

  bus.aTenant(sesion.tenant_id, "message:new", {
    chatId: chatFila.id, jid: chatFila.wa_chat_id, mensaje
  })
  return mensaje
}

// ------------------------------------------------------------
//  AUTOARRANQUE
// ------------------------------------------------------------
/** Reanuda las sesiones que ya tienen tokens guardados en disco. */
async function autoIniciarSesiones() {
  const sesiones = await db.many(
    `SELECT s.* FROM wa_sessions s
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.autostart = TRUE AND t.status = 'active'
      ORDER BY s.id`
  )

  let lanzadas = 0
  for (const sesion of sesiones) {
    const dir = path.join(carpetaTokens(), sesion.session_key)
    if (!fs.existsSync(dir)) continue           // nunca escaneó el QR
    if (lanzadas >= env.maxActiveSessions) break

    log.info("wa", "autoarrancando", sesion.session_key)
    await iniciarSesion(sesion)
    lanzadas++
    await sleep(8000)                            // escalonado: no abrir N Chromium a la vez
  }
  if (lanzadas) log.ok("wa", lanzadas, "sesión(es) reanudada(s)")
}

/**
 * Cierra todos los navegadores al apagar el proceso.
 * En paralelo y con techo de 8 s: Docker manda SIGKILL a los 30 s
 * (stop_grace_period), y si nos pasamos, Chromium muere de golpe y deja
 * el candado de perfil que después rompe el próximo arranque.
 */
async function cerrarTodo() {
  const cierres = [...vivas.entries()].map(async ([key, r]) => {
    try {
      await Promise.race([
        r.client?.close(),
        new Promise(res => setTimeout(res, 8000))
      ])
      log.info("wa", "cerrada", key)
    } catch (e) {
      log.warn("wa", "no cerró prolijo " + key + ": " + e.message)
    }
  })
  await Promise.all(cierres)
  vivas.clear()
}

module.exports = {
  ESTADOS,
  iniciarSesion, detenerSesion, cerrarSesionWhatsapp,
  obtenerCliente, estadoEnMemoria,
  sincronizarChats, importarHistorial, enviarDesdeCrm,
  autoIniciarSesiones, cerrarTodo, activas
}
