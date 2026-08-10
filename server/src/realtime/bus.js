// Bus de eventos en tiempo real. Módulo aparte del setup de Socket.IO
// para que cualquier servicio pueda emitir sin importar el server HTTP
// (y sin dependencias circulares).
let io = null

function setIo(instancia) { io = instancia }

/** Emite a todos los usuarios conectados de un cliente. */
function aTenant(tenantId, evento, payload) {
  if (!io || !tenantId) return
  io.to("tenant:" + tenantId).emit(evento, payload)
}

/** Emite al dueño de la plataforma (panel de administración). */
function aOwners(evento, payload) {
  if (!io) return
  io.to("owners").emit(evento, payload)
}

module.exports = { setIo, aTenant, aOwners, get io() { return io } }
