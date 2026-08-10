// Panel del dueño de la plataforma: alta y gestión de clientes.
const express = require("express")
const db = require("../config/db")
const { asyncHandler } = require("../middleware/error")
const { requiereAuth, requiereOwner } = require("../middleware/auth")
const tenantService = require("../services/tenant.service")
const sessionManager = require("../whatsapp/sessionManager")

const router = express.Router()
router.use(requiereAuth, requiereOwner)

router.get("/stats", asyncHandler(async (req, res) => {
  res.json(await tenantService.estadisticasPlataforma())
}))

router.get("/tenants", asyncHandler(async (req, res) => {
  res.json(await tenantService.listarTenants())
}))

router.post("/tenants", asyncHandler(async (req, res) => {
  const creado = await tenantService.crearTenant(req.body)
  res.status(201).json(creado)
}))

router.patch("/tenants/:id", asyncHandler(async (req, res) => {
  const campos = {}
  if (req.body.nombre      !== undefined) campos.name         = req.body.nombre
  if (req.body.status      !== undefined) campos.status       = req.body.status
  if (req.body.plan        !== undefined) campos.plan         = req.body.plan
  if (req.body.maxSessions !== undefined) campos.max_sessions = parseInt(req.body.maxSessions, 10)
  if (req.body.dailyLimit  !== undefined) campos.daily_limit  = parseInt(req.body.dailyLimit, 10)

  res.json(await tenantService.actualizarTenant(parseInt(req.params.id, 10), campos))
}))

router.delete("/tenants/:id", asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10)

  // Cerramos los Chromium del cliente antes de borrar sus datos.
  const sesiones = await db.many("SELECT * FROM wa_sessions WHERE tenant_id = $1", [id])
  for (const s of sesiones) {
    try { await sessionManager.cerrarSesionWhatsapp(s) } catch (_) {}
  }
  res.json(await tenantService.eliminarTenant(id))
}))

router.get("/tenants/:id/users", asyncHandler(async (req, res) => {
  res.json(await db.many(
    "SELECT id, email, name, role, status, last_login_at, created_at FROM users WHERE tenant_id = $1 ORDER BY id",
    [parseInt(req.params.id, 10)]
  ))
}))

router.post("/tenants/:id/users", asyncHandler(async (req, res) => {
  res.status(201).json(await tenantService.crearUsuario(parseInt(req.params.id, 10), req.body))
}))

router.post("/users/:id/password", asyncHandler(async (req, res) => {
  res.json(await tenantService.cambiarPassword(parseInt(req.params.id, 10), req.body.password))
}))

router.patch("/users/:id", asyncHandler(async (req, res) => {
  const estado = req.body.status === "active" ? "active" : "disabled"
  res.json(await db.one(
    "UPDATE users SET status = $2 WHERE id = $1 RETURNING id, email, status",
    [parseInt(req.params.id, 10), estado]
  ))
}))

/** Alta de una sesión de WhatsApp adicional para un cliente. */
router.post("/tenants/:id/sessions", asyncHandler(async (req, res) => {
  const tenantId = parseInt(req.params.id, 10)
  const tenant   = await db.one("SELECT * FROM tenants WHERE id = $1", [tenantId])
  if (!tenant) return res.status(404).json({ error: "Cliente no encontrado" })

  const actuales = await db.one("SELECT COUNT(*)::int AS n FROM wa_sessions WHERE tenant_id = $1", [tenantId])
  if (actuales.n >= tenant.max_sessions) {
    return res.status(400).json({ error: "El plan del cliente permite " + tenant.max_sessions + " sesión(es)" })
  }

  const key = tenant.slug + "-" + tenantId + "-" + (actuales.n + 1)
  res.status(201).json(await db.one(
    "INSERT INTO wa_sessions (tenant_id, session_key, label) VALUES ($1,$2,$3) RETURNING *",
    [tenantId, key, req.body.label || "Línea " + (actuales.n + 1)]
  ))
}))

module.exports = router
