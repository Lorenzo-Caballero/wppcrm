const express = require("express")
const bcrypt  = require("bcryptjs")
const rateLimit = require("express-rate-limit")

const db  = require("../config/db")
const { asyncHandler } = require("../middleware/error")
const { firmarToken, ponerCookie, borrarCookie, requiereAuth } = require("../middleware/auth")

const router = express.Router()

const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos. Probá de nuevo en 15 minutos." }
})

router.post("/login", limiteLogin, asyncHandler(async (req, res) => {
  const email    = String(req.body.email || "").trim().toLowerCase()
  const password = String(req.body.password || "")
  if (!email || !password) return res.status(400).json({ error: "Email y contraseña son obligatorios" })

  const user = await db.one(
    `SELECT u.*, t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email = $1`,
    [email]
  )
  // Mensaje genérico a propósito: no revelamos si el email existe.
  if (!user) return res.status(401).json({ error: "Email o contraseña incorrectos" })

  const ok = await bcrypt.compare(password, user.password_hash)
  if (!ok) return res.status(401).json({ error: "Email o contraseña incorrectos" })
  if (user.status !== "active") return res.status(403).json({ error: "Usuario deshabilitado" })
  if (user.role !== "owner" && user.tenant_status !== "active") {
    return res.status(403).json({ error: "Cuenta suspendida. Contactá al administrador." })
  }

  await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id])
  ponerCookie(res, firmarToken(user))

  res.json({
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      tenantId: user.tenant_id, tenantName: user.tenant_name
    },
    redirect: user.role === "owner" ? "/admin" : "/app"
  })
}))

router.post("/logout", (req, res) => {
  borrarCookie(res)
  res.json({ ok: true })
})

router.get("/me", requiereAuth, asyncHandler(async (req, res) => {
  const tenant = req.user.tenant_id
    ? await db.one("SELECT id, name, slug, plan, daily_limit, max_sessions FROM tenants WHERE id = $1", [req.user.tenant_id])
    : null
  res.json({ user: req.user, tenant })
}))

router.post("/password", requiereAuth, asyncHandler(async (req, res) => {
  const actual = String(req.body.actual || "")
  const nueva  = String(req.body.nueva  || "")
  if (nueva.length < 8) return res.status(400).json({ error: "La nueva contraseña debe tener al menos 8 caracteres" })

  const row = await db.one("SELECT password_hash FROM users WHERE id = $1", [req.user.id])
  if (!await bcrypt.compare(actual, row.password_hash)) {
    return res.status(400).json({ error: "La contraseña actual no coincide" })
  }
  await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [req.user.id, await bcrypt.hash(nueva, 12)])
  res.json({ ok: true })
}))

module.exports = router
