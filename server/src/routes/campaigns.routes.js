// Difusiones: creación, vista previa de variantes, audiencia y control.
const express = require("express")
const db = require("../config/db")
const { asyncHandler } = require("../middleware/error")
const { requiereAuth, resolverTenant } = require("../middleware/auth")
const campaignService = require("../services/campaign.service")
const { previsualizar, validarSpintax } = require("../services/message.service")

const router = express.Router()
router.use(requiereAuth, resolverTenant)

router.get("/defaults", (req, res) => {
  res.json(campaignService.DEFAULTS)
})

/** Vista previa: N variantes del mismo mensaje base. */
router.post("/preview", asyncHandler(async (req, res) => {
  const mensaje = String(req.body.mensaje || "")
  const check   = validarSpintax(mensaje)
  if (!check.ok) return res.status(400).json({ error: "Spintax inválido: " + check.error })

  res.json({ variantes: previsualizar(mensaje, Math.min(parseInt(req.body.cantidad, 10) || 3, 8)) })
}))

/** Cuántos contactos entran con esos filtros, desglosado por zona. */
router.post("/audience", asyncHandler(async (req, res) => {
  res.json(await campaignService.contarAudiencia(req.tenantId, req.body.filtros || {}, req.body.settings || {}))
}))

router.get("/", asyncHandler(async (req, res) => {
  res.json(await campaignService.listarCampanias(req.tenantId))
}))

router.get("/:id", asyncHandler(async (req, res) => {
  const c = await campaignService.obtenerCampania(req.tenantId, parseInt(req.params.id, 10))
  if (!c) return res.status(404).json({ error: "Difusión no encontrada" })
  res.json(c)
}))

router.post("/", asyncHandler(async (req, res) => {
  const nombre  = String(req.body.nombre  || "").trim()
  const mensaje = String(req.body.mensaje || "").trim()
  if (!nombre)  return res.status(400).json({ error: "Ponele un nombre a la difusión" })
  if (!mensaje) return res.status(400).json({ error: "El mensaje no puede estar vacío" })

  const check = validarSpintax(mensaje)
  if (!check.ok) return res.status(400).json({ error: "Spintax inválido: " + check.error })

  const campania = await campaignService.crearCampania(req.tenantId, req.user.id, {
    nombre, mensaje,
    sessionId: req.body.sessionId ? parseInt(req.body.sessionId, 10) : null,
    filtros:   req.body.filtros  || {},
    settings:  req.body.settings || {}
  })

  if (req.body.iniciar) {
    try { await campaignService.iniciarCampania(req.tenantId, campania.id) }
    catch (e) { return res.status(201).json({ ...campania, avisoInicio: e.message }) }
  }
  res.status(201).json(campania)
}))

router.post("/:id/start",  asyncHandler(async (req, res) => {
  res.json(await campaignService.iniciarCampania(req.tenantId, parseInt(req.params.id, 10)))
}))

router.post("/:id/pause",  asyncHandler(async (req, res) => {
  res.json(await campaignService.pausarCampania(req.tenantId, parseInt(req.params.id, 10)))
}))

router.post("/:id/cancel", asyncHandler(async (req, res) => {
  res.json(await campaignService.cancelarCampania(req.tenantId, parseInt(req.params.id, 10)))
}))

// ---------- Plantillas de mensaje ----------
router.get("/templates/list", asyncHandler(async (req, res) => {
  res.json(await db.many("SELECT * FROM templates WHERE tenant_id = $1 ORDER BY id DESC", [req.tenantId]))
}))

router.post("/templates", asyncHandler(async (req, res) => {
  const check = validarSpintax(req.body.body || "")
  if (!check.ok) return res.status(400).json({ error: "Spintax inválido: " + check.error })

  res.status(201).json(await db.one(
    "INSERT INTO templates (tenant_id, name, body) VALUES ($1,$2,$3) RETURNING *",
    [req.tenantId, String(req.body.name || "Sin nombre").slice(0, 80), String(req.body.body || "")]
  ))
}))

router.delete("/templates/:id", asyncHandler(async (req, res) => {
  await db.query("DELETE FROM templates WHERE tenant_id = $1 AND id = $2",
    [req.tenantId, parseInt(req.params.id, 10)])
  res.json({ ok: true })
}))

module.exports = router
