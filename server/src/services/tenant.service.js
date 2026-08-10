// ============================================================
//  Alta y gestión de clientes de la plataforma (tenants).
//  Al crear un cliente se le arma todo de una: usuario admin,
//  sesión de WhatsApp vacía y plantilla de mensaje de ejemplo.
// ============================================================
const bcrypt = require("bcryptjs")
const db  = require("../config/db")
const log = require("../utils/logger")

function slugify(texto) {
  return String(texto)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "cliente"
}

async function slugUnico(base) {
  let slug = slugify(base)
  let intento = slug
  let n = 1
  while (await db.one("SELECT 1 FROM tenants WHERE slug = $1", [intento])) {
    intento = slug + "-" + (++n)
  }
  return intento
}

async function listarTenants() {
  return db.many(
    `SELECT t.*,
            (SELECT COUNT(*)::int FROM users       u WHERE u.tenant_id = t.id) AS usuarios,
            (SELECT COUNT(*)::int FROM chats       c WHERE c.tenant_id = t.id) AS chats,
            (SELECT COUNT(*)::int FROM campaigns   k WHERE k.tenant_id = t.id) AS difusiones,
            (SELECT json_agg(json_build_object('id', s.id, 'label', s.label,
                                               'status', s.status, 'phone', s.phone,
                                               'sessionKey', s.session_key))
               FROM wa_sessions s WHERE s.tenant_id = t.id) AS sesiones
       FROM tenants t
      ORDER BY t.created_at DESC`
  )
}

/**
 * Crea un cliente completo.
 * @param datos { nombre, email, password, plan, maxSessions, dailyLimit, nombreUsuario }
 */
async function crearTenant(datos) {
  const emailNorm = String(datos.email || "").trim().toLowerCase()
  if (!emailNorm || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) throw new Error("Email inválido")
  if (!datos.password || datos.password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres")
  if (!datos.nombre)  throw new Error("Falta el nombre del cliente")

  const yaExiste = await db.one("SELECT 1 FROM users WHERE email = $1", [emailNorm])
  if (yaExiste) throw new Error("Ya hay un usuario con ese email")

  const slug = await slugUnico(datos.nombre)
  const hash = await bcrypt.hash(datos.password, 12)

  return db.tx(async client => {
    const { rows: [tenant] } = await client.query(
      `INSERT INTO tenants (name, slug, plan, max_sessions, daily_limit)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [datos.nombre, slug, datos.plan || "basico",
       parseInt(datos.maxSessions, 10) || 1, parseInt(datos.dailyLimit, 10) || 300]
    )

    const { rows: [user] } = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role)
       VALUES ($1,$2,$3,$4,'admin') RETURNING id, email, name, role`,
      [tenant.id, emailNorm, hash, datos.nombreUsuario || datos.nombre]
    )

    // Sesión de WhatsApp lista para escanear el QR desde el panel del cliente.
    const { rows: [sesion] } = await client.query(
      `INSERT INTO wa_sessions (tenant_id, session_key, label)
       VALUES ($1,$2,'Principal') RETURNING *`,
      [tenant.id, slug + "-" + tenant.id]
    )

    await client.query(
      `INSERT INTO templates (tenant_id, name, body) VALUES ($1,$2,$3)`,
      [tenant.id, "Ejemplo con variantes",
`{Hola|Buenas|Qué tal} {{nombre}}! 👋

{Te escribo para contarte|Quería comentarte|Paso a contarte} que {ya tenemos|está disponible} la {nueva agenda|agenda del mes}.

{Escribime|Contame|Mandame un mensaje} y lo coordinamos 🙌`]
    )

    log.ok("tenant", "creado", tenant.name, "(slug " + slug + ")")
    return { tenant, user, sesion }
  })
}

async function actualizarTenant(id, campos) {
  const permitidos = ["name", "status", "plan", "max_sessions", "daily_limit"]
  const sets = [], params = [id]
  let i = 1
  for (const [k, v] of Object.entries(campos)) {
    if (!permitidos.includes(k)) continue
    params.push(v); i++
    sets.push(`${k} = $${i}`)
  }
  if (!sets.length) return db.one("SELECT * FROM tenants WHERE id = $1", [id])
  return db.one(`UPDATE tenants SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params)
}

async function eliminarTenant(id) {
  // ON DELETE CASCADE se lleva usuarios, chats, mensajes, campañas y sesiones.
  await db.query("DELETE FROM tenants WHERE id = $1", [id])
  return { ok: true }
}

async function crearUsuario(tenantId, datos) {
  const emailNorm = String(datos.email || "").trim().toLowerCase()
  if (!emailNorm) throw new Error("Email requerido")
  if (!datos.password || datos.password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres")

  const hash = await bcrypt.hash(datos.password, 12)
  return db.one(
    `INSERT INTO users (tenant_id, email, password_hash, name, role)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, tenant_id, email, name, role, status`,
    [tenantId, emailNorm, hash, datos.nombre || emailNorm, datos.role === "agent" ? "agent" : "admin"]
  )
}

async function cambiarPassword(userId, nueva) {
  if (!nueva || nueva.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres")
  const hash = await bcrypt.hash(nueva, 12)
  await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, hash])
  return { ok: true }
}

async function estadisticasPlataforma() {
  return db.one(
    `SELECT
      (SELECT COUNT(*)::int FROM tenants)                                    AS clientes,
      (SELECT COUNT(*)::int FROM tenants WHERE status = 'active')            AS clientes_activos,
      (SELECT COUNT(*)::int FROM wa_sessions WHERE status = 'connected')     AS sesiones_conectadas,
      (SELECT COUNT(*)::int FROM chats)                                      AS chats,
      (SELECT COUNT(*)::int FROM messages WHERE sent_at > now() - interval '24 hours') AS mensajes_24h,
      (SELECT COUNT(*)::int FROM campaigns WHERE status = 'running')         AS difusiones_activas`
  )
}

module.exports = {
  listarTenants, crearTenant, actualizarTenant, eliminarTenant,
  crearUsuario, cambiarPassword, estadisticasPlataforma, slugify
}
