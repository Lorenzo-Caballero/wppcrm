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

router.get("/", asyncHandler(async (req, res) => {
  const chats = await chatService.listarChats(req.tenantId, {
    search:            req.query.q       || "",
    area:              req.query.area    || "",
    country:           req.query.pais    || "",
    province:          req.query.prov    || "",
    status:            req.query.estado  || "",
    orden:             req.query.orden   || "reciente",
    soloNoLeidos:      req.query.noleidos === "1",
    incluirArchivados: req.query.archivados === "1",
    limit:             Math.min(parseInt(req.query.limit, 10) || 60, 200),
    offset:            parseInt(req.query.offset, 10) || 0
  })
  res.json(chats.map(decorar))
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

module.exports = router
