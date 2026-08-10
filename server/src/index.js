// ============================================================
//  Punto de entrada
//  1. espera Postgres        4. reanuda sesiones de WhatsApp
//  2. aplica migraciones     5. reanuda difusiones interrumpidas
//  3. levanta HTTP + socket
// ============================================================
const fs   = require("fs")
const http = require("http")

const env = require("./config/env")
const db  = require("./config/db")
const log = require("./utils/logger")
const app = require("./app")
const migrate = require("./db/migrate")
const { iniciarSocket } = require("./realtime/socket")
const sessionManager  = require("./whatsapp/sessionManager")
const campaignService = require("./services/campaign.service")

process.on("uncaughtException",  err    => log.error("proceso", "Excepción no capturada:", err.stack || err))
process.on("unhandledRejection", motivo => log.error("proceso", "Promesa rechazada:", motivo))

async function main() {
  for (const dir of [env.dataDir, env.tokensDir, env.mediaDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }

  await db.waitForDb()
  await migrate()

  const server = http.createServer(app)
  iniciarSocket(server)

  await new Promise(resolve => server.listen(env.port, "0.0.0.0", resolve))
  log.ok("http", "escuchando en el puerto " + env.port + " (" + env.nodeEnv + ")")
  log.info("http", "URL pública:", env.appUrl)

  // Las sesiones tardan en levantar; que no bloqueen el arranque del server.
  sessionManager.autoIniciarSesiones()
    .then(() => campaignService.reanudarCampaniasActivas())
    .catch(e => log.error("arranque", e.message))

  const apagar = async señal => {
    log.info("proceso", "recibí " + señal + ", cerrando prolijamente...")
    server.close()
    await sessionManager.cerrarTodo()
    await db.pool.end().catch(() => {})
    process.exit(0)
  }
  process.on("SIGTERM", () => apagar("SIGTERM"))
  process.on("SIGINT",  () => apagar("SIGINT"))
}

main().catch(e => {
  log.error("arranque", "no se pudo iniciar:", e.stack || e.message)
  process.exit(1)
})
