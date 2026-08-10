// CRM: listado de chats, conversación y respuesta manual.
const express = require("express")
const db = require("../config/db")
const { asyncHandler } = require("../middleware/error")
const { requiereAuth, resolverTenant } = require("../middleware/auth")
const chatService    = require("../services/chat.service")
const sessionManager = require("../whatsapp/sessionManager")
const { formatearParaMostrar, catalogoAreas } = require("../utils/phone")

const router = express.Router()
router.use(requiereAuth, resolverTenant)

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

router.get("/zonas", asyncHandler(async (req, res) => {
  const facetas = await chatService.facetasPorZona(req.tenantId)
  res.json({ ...facetas, catalogo: catalogoAreas() })
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
    soloNoLeidos:      q.noleidos   === "1",
    incluirArchivados: q.archivados === "1"
  }
}

router.get("/", asyncHandler(async (req, res) => {
  const filtros = filtrosDeQuery(req.query)
  const limit   = Math.min(parseInt(req.query.limit, 10) || 60, 200)
  const offset  = parseInt(req.query.offset, 10) || 0

  const [chats, total] = await Promise.all([
    chatService.listarChats(req.tenantId, { ...filtros, limit, offset }),
    chatService.contarChats(req.tenantId, filtros)
  ])
  res.json({ chats: chats.map(decorar), total, offset, limit })
}))

router.get("/tags", asyncHandler(async (req, res) => {
  res.json(await chatService.listarTags(req.tenantId))
}))

router.post("/leer-todo", asyncHandler(async (req, res) => {
  res.json({ ok: true, actualizados: await chatService.marcarTodoLeido(req.tenantId) })
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

module.exports = router
