// Sirve los archivos guardados (enviados y recibidos) del cliente.
const express = require("express")
const fs = require("fs")

const { asyncHandler } = require("../middleware/error")
const { requiereAuth } = require("../middleware/auth")
const mediaService = require("../services/media.service")

const router = express.Router()
router.use(requiereAuth)

router.get("/:tenantId/:archivo", asyncHandler(async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10)

  // Aislamiento: un usuario solo ve los archivos de su propio cliente.
  if (req.user.role !== "owner" && req.user.tenant_id !== tenantId) {
    return res.status(403).json({ error: "Sin acceso a este archivo" })
  }

  const ruta = mediaService.rutaSegura(tenantId, req.params.archivo)
  if (!ruta) return res.status(404).json({ error: "Archivo no encontrado" })

  res.setHeader("Cache-Control", "private, max-age=86400")
  if (req.query.descargar) {
    res.setHeader("Content-Disposition",
      'attachment; filename="' + encodeURIComponent(req.query.nombre || req.params.archivo) + '"')
  }
  fs.createReadStream(ruta).pipe(res)
}))

module.exports = router
