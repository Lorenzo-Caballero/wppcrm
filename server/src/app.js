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
      imgSrc:      ["'self'", "data:", "blob:"],    // el QR llega como data:image/png;base64
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
app.use(express.static(PUBLIC_DIR, { maxAge: env.isProd ? "1h" : 0, index: false }))

app.get("/",      (req, res) => res.sendFile(path.join(PUBLIC_DIR, "login.html")))
app.get("/login", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "login.html")))
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")))
app.get("/app",   (req, res) => res.sendFile(path.join(PUBLIC_DIR, "crm.html")))

app.use(notFound)
app.use(errorHandler)

module.exports = app
