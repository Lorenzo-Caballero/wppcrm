const log = require("../utils/logger")

/** Envuelve handlers async para que los rechazos lleguen al middleware de error. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

function notFound(req, res) {
  res.status(404).json({ error: "Recurso no encontrado" })
}

function errorHandler(err, req, res, _next) {
  const status = err.status || 400
  if (status >= 500) log.error("http", err.stack || err.message)
  else               log.warn("http", req.method, req.path, "-", err.message)

  res.status(status).json({ error: err.message || "Error interno" })
}

module.exports = { asyncHandler, notFound, errorHandler }
