// Conexión de WhatsApp del cliente: QR, estado, sincronización.
const express = require("express")
const db = require("../config/db")
const { asyncHandler } = require("../middleware/error")
const { requiereAuth, resolverTenant } = require("../middleware/auth")
const sessionManager = require("../whatsapp/sessionManager")

const router = express.Router()
router.use(requiereAuth, resolverTenant)

async function sesionDelTenant(tenantId, id) {
  if (id) return db.one("SELECT * FROM wa_sessions WHERE tenant_id = $1 AND id = $2", [tenantId, id])
  return db.one("SELECT * FROM wa_sessions WHERE tenant_id = $1 ORDER BY id LIMIT 1", [tenantId])
}

router.get("/", asyncHandler(async (req, res) => {
  const filas = await db.many(
    `SELECT id, session_key, label, status, phone, last_qr, last_error, connected_at
       FROM wa_sessions WHERE tenant_id = $1 ORDER BY id`,
    [req.tenantId]
  )
  // El estado en memoria manda: si el proceso se reinició, la base puede decir
  // "connected" cuando en realidad ya no hay ningún navegador abierto.
  // El QR se manda también acá para que al recargar la página se vuelva a ver.
  res.json(filas.map(f => {
    const mem = sessionManager.estadoEnMemoria(f.session_key)
    return { ...f, status: mem.status, last_qr: mem.qr || (mem.status === "qr" ? f.last_qr : null) }
  }))
}))

/** Arranca el navegador y dispara el QR (llega por WebSocket: session:status). */
router.post("/:id/connect", asyncHandler(async (req, res) => {
  const sesion = await sesionDelTenant(req.tenantId, parseInt(req.params.id, 10))
  if (!sesion) return res.status(404).json({ error: "Sesión no encontrada" })

  const r = await sessionManager.iniciarSesion(sesion)
  res.status(r.ok ? 200 : 400).json(r)
}))

/** Devuelve el último QR guardado (por si el usuario recargó la página). */
router.get("/:id/qr", asyncHandler(async (req, res) => {
  const sesion = await sesionDelTenant(req.tenantId, parseInt(req.params.id, 10))
  if (!sesion) return res.status(404).json({ error: "Sesión no encontrada" })

  const mem = sessionManager.estadoEnMemoria(sesion.session_key)
  res.json({ status: mem.status || sesion.status, qr: mem.qr || sesion.last_qr || null, phone: sesion.phone })
}))

/** Cierra el navegador pero conserva los tokens: al reconectar no pide QR. */
router.post("/:id/disconnect", asyncHandler(async (req, res) => {
  const sesion = await sesionDelTenant(req.tenantId, parseInt(req.params.id, 10))
  if (!sesion) return res.status(404).json({ error: "Sesión no encontrada" })
  res.json(await sessionManager.detenerSesion(sesion))
}))

/** Desvincula del teléfono y borra los tokens: la próxima vez pide QR nuevo. */
router.post("/:id/logout", asyncHandler(async (req, res) => {
  const sesion = await sesionDelTenant(req.tenantId, parseInt(req.params.id, 10))
  if (!sesion) return res.status(404).json({ error: "Sesión no encontrada" })
  res.json(await sessionManager.cerrarSesionWhatsapp(sesion))
}))

router.post("/:id/sync", asyncHandler(async (req, res) => {
  const sesion = await sesionDelTenant(req.tenantId, parseInt(req.params.id, 10))
  if (!sesion) return res.status(404).json({ error: "Sesión no encontrada" })
  res.json(await sessionManager.sincronizarChats(sesion, { limite: parseInt(req.body.limite, 10) || 1000 }))
}))

module.exports = router
