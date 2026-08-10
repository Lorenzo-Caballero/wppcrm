const jwt = require("jsonwebtoken")
const env = require("../config/env")
const db  = require("../config/db")

function firmarToken(user) {
  return jwt.sign(
    { uid: user.id, tid: user.tenant_id, role: user.role, name: user.name, email: user.email },
    env.jwtSecret,
    { expiresIn: env.sessionTtlHours + "h" }
  )
}

function verificarToken(token) {
  try { return jwt.verify(token, env.jwtSecret) } catch { return null }
}

function ponerCookie(res, token) {
  res.cookie(env.cookieName, token, {
    httpOnly: true,
    secure:   env.cookieSecure,
    sameSite: "lax",
    maxAge:   env.sessionTtlHours * 3600 * 1000,
    path:     "/"
  })
}

function borrarCookie(res) {
  res.clearCookie(env.cookieName, { path: "/" })
}

/** Exige sesión válida y carga req.user. */
async function requiereAuth(req, res, next) {
  const token = req.cookies?.[env.cookieName] ||
                (req.headers.authorization || "").replace(/^Bearer\s+/i, "")
  const payload = token && verificarToken(token)
  if (!payload) return res.status(401).json({ error: "No autenticado" })

  const user = await db.one(
    "SELECT id, tenant_id, email, name, role, status FROM users WHERE id = $1",
    [payload.uid]
  )
  if (!user || user.status !== "active") return res.status(401).json({ error: "Usuario inactivo" })

  req.user = user
  next()
}

/** Solo el dueño de la plataforma. */
function requiereOwner(req, res, next) {
  if (req.user?.role !== "owner") return res.status(403).json({ error: "Solo el dueño de la plataforma" })
  next()
}

/**
 * Resuelve sobre qué cliente opera la request.
 * - usuario de cliente -> su propio tenant, siempre
 * - dueño              -> el que indique ?tenantId= (para poder soportar/depurar)
 */
async function resolverTenant(req, res, next) {
  let tenantId = req.user.tenant_id

  if (req.user.role === "owner") {
    const solicitado = parseInt(req.query.tenantId || req.body?.tenantId, 10)
    if (Number.isFinite(solicitado)) tenantId = solicitado
  }
  if (!tenantId) return res.status(400).json({ error: "Falta indicar el cliente (tenantId)" })

  const tenant = await db.one("SELECT * FROM tenants WHERE id = $1", [tenantId])
  if (!tenant) return res.status(404).json({ error: "Cliente no encontrado" })
  if (tenant.status !== "active" && req.user.role !== "owner") {
    return res.status(403).json({ error: "Cuenta suspendida. Contactá al administrador." })
  }

  req.tenant   = tenant
  req.tenantId = tenant.id
  next()
}

module.exports = {
  firmarToken, verificarToken, ponerCookie, borrarCookie,
  requiereAuth, requiereOwner, resolverTenant
}
