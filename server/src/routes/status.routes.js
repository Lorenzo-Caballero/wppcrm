// Publicación de estados (historias) de WhatsApp.
const express = require("express")
const multer  = require("multer")

const db = require("../config/db")
const { asyncHandler } = require("../middleware/error")
const { requiereAuth, resolverTenant } = require("../middleware/auth")
const actions = require("../whatsapp/actions")

const router = express.Router()
router.use(requiereAuth, resolverTenant)

// En memoria: el archivo se manda a WhatsApp y recién ahí se guarda en disco.
const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 }   // WhatsApp corta los videos de estado a ~64 MB
})

async function sesionActiva(tenantId, sessionId) {
  if (sessionId) return db.one("SELECT * FROM wa_sessions WHERE tenant_id = $1 AND id = $2", [tenantId, sessionId])
  return db.one("SELECT * FROM wa_sessions WHERE tenant_id = $1 ORDER BY id LIMIT 1", [tenantId])
}

router.get("/", asyncHandler(async (req, res) => {
  res.json(await db.many(
    "SELECT * FROM statuses WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50",
    [req.tenantId]
  ))
}))

router.post("/texto", asyncHandler(async (req, res) => {
  const texto = String(req.body.texto || "").trim()
  if (!texto) return res.status(400).json({ error: "El estado está vacío" })
  if (texto.length > 700) return res.status(400).json({ error: "Máximo 700 caracteres" })

  const sesion = await sesionActiva(req.tenantId, parseInt(req.body.sessionId, 10))
  if (!sesion) return res.status(400).json({ error: "No hay sesión de WhatsApp" })

  res.json(await actions.publicarEstadoTexto(sesion, {
    texto,
    backgroundColor: req.body.color || "#0f5c45",
    font: parseInt(req.body.fuente, 10) || 2
  }, req.user.id))
}))

router.post("/media", subida.single("archivo"), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Falta el archivo" })

  const sesion = await sesionActiva(req.tenantId, parseInt(req.body.sessionId, 10))
  if (!sesion) return res.status(400).json({ error: "No hay sesión de WhatsApp" })

  res.json(await actions.publicarEstadoMedia(sesion, {
    buffer: req.file.buffer,
    mime:   req.file.mimetype,
    nombre: req.file.originalname
  }, String(req.body.caption || ""), req.user.id))
}))

module.exports = router
