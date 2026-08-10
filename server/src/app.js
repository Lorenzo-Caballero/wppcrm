const fs          = require("fs")
const path        = require("path")
const express     = require("express")
const helmet      = require("helmet")
const compression = require("compression")
const cookieParser= require("cookie-parser")

const env = require("./config/env")
const { notFound, errorHandler } = require("./middleware/error")

const app = express()
const PUBLIC_DIR = path.join(__dirname, "..", "public")

// Detrás de nginx: necesario para que req.secure y el rate-limit por IP funcionen.
app.set("trust proxy", 1)

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],   // estilos inline puntuales del CRM
      // data: para el QR · blob: para la vista previa de adjuntos ·
      // https: porque las fotos de perfil las sirve WhatsApp (pps.whatsapp.net)
      imgSrc:      ["'self'", "data:", "blob:", "https:"],
      mediaSrc:    ["'self'", "blob:", "data:"],    // audio y video de los chats
      connectSrc:  ["'self'", "ws:", "wss:"],
      fontSrc:     ["'self'", "data:"],
      objectSrc:   ["'none'"],
      frameAncestors: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}))
app.use(compression())
app.use(express.json({ limit: "1mb" }))
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

// ---------- API ----------
app.use("/api", require("./routes"))

// ---------- Frontend ----------
//
// Los assets se cachean fuerte, pero sus URLs llevan ?v=<BUILD>, que cambia
// en cada arranque del proceso. Así un deploy invalida el cache solo.
// Sin esto, tras actualizar quedaba HTML nuevo con JavaScript viejo cacheado
// — combinación silenciosa y difícil de diagnosticar.
const BUILD = (process.env.BUILD_ID || Date.now().toString(36))

app.use(express.static(PUBLIC_DIR, {
  maxAge: env.isProd ? "7d" : 0,
  index: false,
  etag: true
}))

// El sprite de iconos se inyecta en el HTML en vez de repetirlo en cada
// página: una sola fuente de verdad y sin pedido extra al servidor
// (un <use> a un SVG externo tiene problemas de compatibilidad).
let spriteIconos = ""
try {
  spriteIconos = fs.readFileSync(path.join(PUBLIC_DIR, "assets", "iconos.svg"), "utf8")
} catch (e) {
  console.warn("[app] no encontré assets/iconos.svg:", e.message)
}

/** Lee el HTML una vez, inyecta los iconos y versiona los assets. */
const paginasCache = new Map()
function servirPagina(archivo) {
  return (req, res) => {
    let html = paginasCache.get(archivo)
    if (!html) {
      html = fs.readFileSync(path.join(PUBLIC_DIR, archivo), "utf8")
        .replace("<!--ICONOS-->", spriteIconos)
        .replace(/(src|href)="(\/assets\/[^"]+)"/g, `$1="$2?v=${BUILD}"`)
      paginasCache.set(archivo, html)
    }
    // El HTML nunca se cachea: es quien reparte las URLs versionadas.
    res.set("Cache-Control", "no-store, must-revalidate")
    res.type("html").send(html)
  }
}

app.get("/",      servirPagina("login.html"))
app.get("/login", servirPagina("login.html"))
app.get("/admin", servirPagina("admin.html"))
app.get("/app",   servirPagina("crm.html"))

app.use(notFound)
app.use(errorHandler)

module.exports = app
