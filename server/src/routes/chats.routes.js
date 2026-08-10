// CRM: listado de chats, conversación, respuesta manual y acciones de WhatsApp.
const express = require("express")
const multer  = require("multer")

const db  = require("../config/db")
const log = require("../utils/logger")
const { asyncHandler } = require("../middleware/error")
const { requiereAuth, resolverTenant } = require("../middleware/auth")
const chatService    = require("../services/chat.service")
const sessionManager = require("../whatsapp/sessionManager")
const actions        = require("../whatsapp/actions")
const { formatearParaMostrar } = require("../utils/phone")

const router = express.Router()
router.use(requiereAuth, resolverTenant)

// 64 MB: el tope práctico de WhatsApp para documentos.
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } })

/** Diagnóstico: cuántos chats hay realmente guardados para este cliente. */
router.get("/diagnostico", asyncHandler(async (req, res) => {
  const r = await db.one(
    `SELECT
       (SELECT COUNT(*)::int FROM chats    WHERE tenant_id = $1)                    AS chats_totales,
       (SELECT COUNT(*)::int FROM chats    WHERE tenant_id = $1 AND archived)       AS archivados,
       (SELECT COUNT(*)::int FROM contacts WHERE tenant_id = $1)                    AS contactos,
       (SELECT COUNT(*)::int FROM messages WHERE tenant_id = $1)                    AS mensajes,
       (SELECT COUNT(*)::int FROM contacts WHERE tenant_id = $1 AND country_code IS NULL) AS sin_pais`,
    [req.tenantId]
  )
  res.json(r)
}))

/** Sesión de WhatsApp asociada al chat (o la principal del cliente). */
async function sesionDeChat(tenantId, chat) {
  if (chat?.session_id) {
    const s = await db.one("SELECT * FROM wa_sessions WHERE id = $1", [chat.session_id])
    if (s) return s
  }
  return db.one("SELECT * FROM wa_sessions WHERE tenant_id = $1 ORDER BY id LIMIT 1", [tenantId])
}

/** Carga el chat y su sesión, o corta con 404. */
async function chatYSesion(req, res) {
  const chat = await chatService.obtenerChat(req.tenantId, parseInt(req.params.id, 10))
  if (!chat) { res.status(404).json({ error: "Chat no encontrado" }); return null }

  const sesion = await sesionDeChat(req.tenantId, chat)
  if (!sesion) { res.status(400).json({ error: "No hay sesión de WhatsApp configurada" }); return null }

  return { chat, sesion }
}

function decorar(chat) {
  return {
    ...chat,
    display_name: chat.name || chat.push_name || formatearParaMostrar(chat.phone || chat.jid),
    phone_pretty: formatearParaMostrar(chat.phone || chat.jid),
    zona: chat.region ? chat.region + (chat.province ? ", " + chat.province : "") : (chat.country || "Sin datos")
  }
}

router.get("/resumen", asyncHandler(async (req, res) => {
  res.json(await chatService.resumenTenant(req.tenantId))
}))

/**
 * Zonas detectadas en los chats del cliente.
 * Antes se mandaba también el catálogo completo de códigos de área (268
 * entradas en cada carga) que ningún componente usaba. Solo van las zonas
 * que este cliente realmente tiene.
 */
router.get("/zonas", asyncHandler(async (req, res) => {
  res.json(await chatService.facetasPorZona(req.tenantId))
}))

/** Traduce los parámetros de la URL a las opciones del servicio. */
function filtrosDeQuery(q) {
  return {
    search:            q.q      || "",
    area:              q.area   || "",
    country:           q.pais   || "",
    province:          q.prov   || "",
    status:            q.estado || "",
    tag:               q.tag    || "",
    quien:             q.quien  || "",
    friosDias:         parseInt(q.frios, 10) || 0,
    orden:             q.orden  || "reciente",
    soloNoLeidos:      q.noleidos === "1",
    archivados:        q.archivados || "",   // "" | "1" (incluir) | "solo"
    // Buscar dentro del historial completo, no solo en el último mensaje.
    // Se puede apagar desde la UI si se quiere una búsqueda más liviana.
    enMensajes:        q.enmensajes !== "0"
  }
}

router.get("/", asyncHandler(async (req, res) => {
  const filtros = filtrosDeQuery(req.query)
  const limit   = Math.min(parseInt(req.query.limit, 10) || 60, 200)
  const offset  = parseInt(req.query.offset, 10) || 0

  // Una sola consulta trae la página y el total (COUNT(*) OVER()).
  const { chats, total } = await chatService.listarChats(req.tenantId, { ...filtros, limit, offset })
  res.json({ chats: chats.map(decorar), total, offset, limit })
}))

router.get("/tags", asyncHandler(async (req, res) => {
  res.json(await chatService.listarTags(req.tenantId))
}))

router.post("/leer-todo", asyncHandler(async (req, res) => {
  res.json({ ok: true, actualizados: await chatService.marcarTodoLeido(req.tenantId) })
}))

router.get("/seguimientos", asyncHandler(async (req, res) => {
  res.json(await chatService.seguimientosPendientes(req.tenantId))
}))

// ---------- Selección múltiple ----------
/**
 * Ids de todos los chats que coinciden con los filtros ("seleccionar todos").
 * Devuelve también el total real, para poder avisar si se alcanzó el tope
 * en vez de dejar al usuario creyendo que esos son todos sus chats.
 */
router.get("/ids", asyncHandler(async (req, res) => {
  const filtros = filtrosDeQuery(req.query)
  const tope    = Math.min(parseInt(req.query.tope, 10) || 20000, 50000)

  const [ids, total] = await Promise.all([
    chatService.idsFiltrados(req.tenantId, filtros, tope),
    chatService.contarChats(req.tenantId, filtros)
  ])
  res.json({ ids, total, tope, truncado: ids.length < total })
}))

router.post("/masivo", asyncHandler(async (req, res) => {
  const { ids, accion, valor } = req.body
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "No hay chats seleccionados" })
  if (ids.length > 20000)                  return res.status(400).json({ error: "Demasiados chats de una vez" })

  // Archivar y desarchivar tienen que replicarse en WhatsApp. Si solo se
  // tocara nuestra base, la próxima sincronización leería el estado real
  // desde el teléfono y desharía el cambio sin avisar.
  let enWhatsapp = 0, fallidos = 0
  if (accion === "archivar" || accion === "desarchivar") {
    const chats  = await chatService.chatsPorIds(req.tenantId, ids)
    const sesion = await sesionDeChat(req.tenantId, null)
    const activo = sesion && sessionManager.obtenerCliente(sesion.session_key)

    if (!activo) {
      return res.status(400).json({
        error: "WhatsApp no está conectado. Sin conexión el archivado se revertiría en la próxima sincronización."
      })
    }

    for (const c of chats) {
      try {
        await actions.archivar(sesion, { id: c.id, wa_chat_id: c.wa_chat_id }, accion === "archivar")
        enWhatsapp++
      } catch (e) {
        fallidos++
        log.warn("masivo", "no pude archivar " + c.wa_chat_id + ": " + e.message)
      }
    }
    // actions.archivar ya actualizó cada fila; no hace falta el UPDATE masivo.
    return res.json({ afectados: enWhatsapp, fallidos })
  }

  res.json(await chatService.accionMasiva(req.tenantId, ids, accion, valor))
}))

/** JIDs de los chats seleccionados, para difundirles exactamente a ellos. */
router.post("/exportar-jids", asyncHandler(async (req, res) => {
  const filas = await chatService.chatsPorIds(req.tenantId, req.body.ids || [])
  res.json({ jids: filas.map(f => f.jid), total: filas.length })
}))

/** CSV de la selección, o de todo lo filtrado si no mandan ids. */
router.post("/exportar", asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) && req.body.ids.length
    ? req.body.ids
    : await chatService.idsFiltrados(req.tenantId, filtrosDeQuery(req.body.filtros || {}))

  const filas = await chatService.chatsPorIds(req.tenantId, ids)
  const fecha = new Date().toISOString().slice(0, 10)

  res.setHeader("Content-Type", "text/csv; charset=utf-8")
  res.setHeader("Content-Disposition", 'attachment; filename="contactos-' + fecha + '.csv"')
  res.send(chatService.aCsv(filas))
}))

// ---------- Respuestas rápidas ----------
router.get("/respuestas-rapidas", asyncHandler(async (req, res) => {
  res.json(await chatService.listarRespuestasRapidas(req.tenantId))
}))

router.post("/respuestas-rapidas", asyncHandler(async (req, res) => {
  res.status(201).json(await chatService.guardarRespuestaRapida(req.tenantId, req.body))
}))

router.delete("/respuestas-rapidas/:id", asyncHandler(async (req, res) => {
  res.json(await chatService.borrarRespuestaRapida(req.tenantId, parseInt(req.params.id, 10)))
}))

router.get("/:id/messages", asyncHandler(async (req, res) => {
  const chatId = parseInt(req.params.id, 10)
  const chat   = await chatService.obtenerChat(req.tenantId, chatId)
  if (!chat) return res.status(404).json({ error: "Chat no encontrado" })

  // Primera apertura: traemos el historial reciente desde WhatsApp.
  const yaHay = await db.one("SELECT COUNT(*)::int AS n FROM messages WHERE chat_id = $1", [chatId])
  if (yaHay.n < 5 && chat.session_id) {
    const sesion = await db.one("SELECT * FROM wa_sessions WHERE id = $1", [chat.session_id])
    if (sesion) { try { await sessionManager.importarHistorial(sesion, chat, 50) } catch (_) {} }
  }

  const mensajes = await chatService.listarMensajes(req.tenantId, chatId, {
    limit:    Math.min(parseInt(req.query.limit, 10) || 60, 200),
    beforeId: req.query.before ? parseInt(req.query.before, 10) : null
  })
  await chatService.marcarLeido(req.tenantId, chatId)

  res.json({ chat: decorar(chat), mensajes })
}))

router.post("/:id/messages", asyncHandler(async (req, res) => {
  const texto = String(req.body.texto || "").trim()
  if (!texto) return res.status(400).json({ error: "El mensaje está vacío" })
  if (texto.length > 4000) return res.status(400).json({ error: "El mensaje es demasiado largo" })

  const chat = await chatService.obtenerChat(req.tenantId, parseInt(req.params.id, 10))
  if (!chat) return res.status(404).json({ error: "Chat no encontrado" })

  const sesion = chat.session_id
    ? await db.one("SELECT * FROM wa_sessions WHERE id = $1", [chat.session_id])
    : await db.one("SELECT * FROM wa_sessions WHERE tenant_id = $1 ORDER BY id LIMIT 1", [req.tenantId])
  if (!sesion) return res.status(400).json({ error: "No hay sesión de WhatsApp configurada" })

  const mensaje = await sessionManager.enviarDesdeCrm(sesion, chat, texto, req.user.name)
  res.status(201).json(mensaje)
}))

router.patch("/:id", asyncHandler(async (req, res) => {
  const campos = {}
  if (req.body.estado   !== undefined) campos.status   = req.body.estado
  if (req.body.pinned   !== undefined) campos.pinned   = !!req.body.pinned
  if (req.body.archived !== undefined) campos.archived = !!req.body.archived
  if (req.body.tags     !== undefined) campos.tags     = req.body.tags

  const chat = await chatService.actualizarChat(req.tenantId, parseInt(req.params.id, 10), campos)
  res.json(decorar(chat))
}))

router.post("/:id/read", asyncHandler(async (req, res) => {
  await chatService.marcarLeido(req.tenantId, parseInt(req.params.id, 10))
  res.json({ ok: true })
}))

router.post("/:id/tags", asyncHandler(async (req, res) => {
  const chatId = parseInt(req.params.id, 10)
  const chat = req.body.quitar
    ? await chatService.quitarTag(req.tenantId, chatId, req.body.quitar)
    : await chatService.agregarTag(req.tenantId, chatId, req.body.agregar)
  res.json(decorar(chat))
}))

// ============================================================
//  ARCHIVOS
// ============================================================
router.post("/:id/archivo", subida.single("archivo"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Falta el archivo" })

  const ctx = await chatYSesion(req, res)
  if (!ctx) return

  const mensaje = await actions.enviarArchivo(ctx.sesion, ctx.chat, {
    buffer: req.file.buffer, mime: req.file.mimetype, nombre: req.file.originalname
  }, {
    caption:       String(req.body.caption || ""),
    comoNotaDeVoz: req.body.notaDeVoz === "true" || req.body.notaDeVoz === "1",
    quotedId:      req.body.quotedId || null
  }, req.user.name)

  res.status(201).json(mensaje)
}))

/** Descarga on-demand de un archivo recibido y lo deja cacheado. */
router.post("/:id/mensajes/:msgId/descargar", asyncHandler(async (req, res) => {
  const ctx = await chatYSesion(req, res)
  if (!ctx) return

  const mensaje = await db.one(
    "SELECT * FROM messages WHERE tenant_id = $1 AND id = $2",
    [req.tenantId, parseInt(req.params.msgId, 10)]
  )
  if (!mensaje) return res.status(404).json({ error: "Mensaje no encontrado" })

  res.json(await actions.descargarMediaDeMensaje(ctx.sesion, mensaje))
}))

// ============================================================
//  ACCIONES SOBRE MENSAJES
//  El id de WhatsApp va en el cuerpo: trae @ y guiones bajos que
//  ensucian la URL.
// ============================================================
router.post("/:id/mensajes/accion", asyncHandler(async (req, res) => {
  const ctx = await chatYSesion(req, res)
  if (!ctx) return

  const { accion, waMsgId, texto, emoji, destinoChatId, soloParaMi } = req.body
  if (!waMsgId && accion !== "responder") return res.status(400).json({ error: "Falta el id del mensaje" })

  switch (accion) {
    case "responder":
      if (!String(texto || "").trim()) return res.status(400).json({ error: "El mensaje está vacío" })
      return res.json(await actions.responderCitando(ctx.sesion, ctx.chat, texto, waMsgId, req.user.name))

    case "reaccionar":
      return res.json(await actions.reaccionar(ctx.sesion, waMsgId, emoji))

    case "destacar":
      return res.json(await actions.destacar(ctx.sesion, waMsgId, req.body.valor !== false))

    case "eliminar":
      return res.json(await actions.eliminarMensaje(ctx.sesion, ctx.chat, waMsgId, !!soloParaMi))

    case "editar":
      if (!String(texto || "").trim()) return res.status(400).json({ error: "El texto está vacío" })
      return res.json(await actions.editarMensaje(ctx.sesion, waMsgId, texto))

    case "reenviar": {
      const destino = await chatService.obtenerChat(req.tenantId, parseInt(destinoChatId, 10))
      if (!destino) return res.status(404).json({ error: "Chat de destino no encontrado" })
      return res.json(await actions.reenviar(ctx.sesion, destino, waMsgId))
    }

    default:
      return res.status(400).json({ error: "Acción desconocida" })
  }
}))

// ============================================================
//  ACCIONES SOBRE EL CHAT (se replican en el WhatsApp real)
// ============================================================
router.post("/:id/accion", asyncHandler(async (req, res) => {
  const ctx = await chatYSesion(req, res)
  if (!ctx) return
  const { accion } = req.body

  switch (accion) {
    case "archivar":    return res.json(decorar(await actions.archivar(ctx.sesion, ctx.chat, true)))
    case "desarchivar": return res.json(decorar(await actions.archivar(ctx.sesion, ctx.chat, false)))
    case "fijar":       return res.json(decorar(await actions.fijarEnWhatsapp(ctx.sesion, ctx.chat, true)))
    case "desfijar":    return res.json(decorar(await actions.fijarEnWhatsapp(ctx.sesion, ctx.chat, false)))
    case "silenciar":   return res.json(await actions.silenciar(ctx.sesion, ctx.chat, parseInt(req.body.horas, 10) || 8))
    case "no-leido":    return res.json(await actions.marcarNoLeidoWa(ctx.sesion, ctx.chat))
    case "leido":       return res.json(await actions.marcarLeidoWa(ctx.sesion, ctx.chat))
    case "vaciar":      return res.json(await actions.vaciarChat(ctx.sesion, ctx.chat))
    case "eliminar":    return res.json(await actions.eliminarChat(ctx.sesion, ctx.chat))
    case "bloquear":    return res.json(await actions.bloquear(ctx.sesion, ctx.chat, true))
    case "desbloquear": return res.json(await actions.bloquear(ctx.sesion, ctx.chat, false))
    case "escribiendo": return res.json(await actions.marcarEstadoEscritura(ctx.sesion, ctx.chat, req.body.estado))
    default:            return res.status(400).json({ error: "Acción desconocida" })
  }
}))

/** Foto de perfil, última vez y si está en línea. */
router.get("/:id/info", asyncHandler(async (req, res) => {
  const ctx = await chatYSesion(req, res)
  if (!ctx) return
  res.json(await actions.infoContacto(ctx.sesion, ctx.chat))
}))

// ============================================================
//  NOTAS Y SEGUIMIENTO
// ============================================================
router.post("/:id/notas", asyncHandler(async (req, res) => {
  res.json(decorar(await chatService.guardarNotas(
    req.tenantId, parseInt(req.params.id, 10), req.body.notas)))
}))

router.post("/:id/seguimiento", asyncHandler(async (req, res) => {
  res.json(decorar(await chatService.definirSeguimiento(
    req.tenantId, parseInt(req.params.id, 10), req.body.cuando || null)))
}))

module.exports = router
