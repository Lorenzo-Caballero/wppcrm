// Socket.IO: cada usuario entra a la sala de su cliente ("tenant:<id>")
// y el dueño de la plataforma además a la sala "owners".
const { Server } = require("socket.io")
const cookie = require("cookie")

const env = require("../config/env")
const log = require("../utils/logger")
const bus = require("./bus")
const { verificarToken } = require("../middleware/auth")

function iniciarSocket(httpServer) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: env.appUrl, credentials: true },
    pingTimeout: 30000
  })

  io.use((socket, next) => {
    try {
      const cookies = cookie.parse(socket.handshake.headers.cookie || "")
      const token   = cookies[env.cookieName] || socket.handshake.auth?.token
      const payload = token && verificarToken(token)
      if (!payload) return next(new Error("No autenticado"))

      socket.data.user = payload
      next()
    } catch (e) {
      next(new Error("Handshake inválido"))
    }
  })

  io.on("connection", socket => {
    const { uid, tid, role } = socket.data.user

    if (tid) socket.join("tenant:" + tid)
    if (role === "owner") {
      socket.join("owners")
      // El dueño puede mirar el CRM de un cliente puntual desde el panel.
      socket.on("watch:tenant", tenantId => {
        const id = parseInt(tenantId, 10)
        if (Number.isFinite(id)) socket.join("tenant:" + id)
      })
    }

    log.debug("socket", "conectado uid", uid, "tenant", tid || "-")
    socket.on("disconnect", () => log.debug("socket", "desconectado uid", uid))
  })

  bus.setIo(io)
  log.ok("socket", "listo")
  return io
}

module.exports = { iniciarSocket }
