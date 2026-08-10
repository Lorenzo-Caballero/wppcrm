// Aplica schema.sql y crea el usuario dueño de la plataforma si no existe.
// Es idempotente: corre en cada arranque sin efectos secundarios.
const fs     = require("fs")
const path   = require("path")
const bcrypt = require("bcryptjs")

const db  = require("../config/db")
const env = require("../config/env")
const log = require("../utils/logger")

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8")
  await db.query(sql)
  log.ok("migrate", "esquema aplicado")

  const existing = await db.one("SELECT id FROM users WHERE role = 'owner' LIMIT 1")
  if (existing) {
    log.info("migrate", "usuario dueño ya existe (id " + existing.id + ")")
    return
  }

  const hash = await bcrypt.hash(env.owner.password, 12)
  const user = await db.one(
    `INSERT INTO users (tenant_id, email, password_hash, name, role)
     VALUES (NULL, $1, $2, $3, 'owner')
     ON CONFLICT (email) DO UPDATE SET role = 'owner'
     RETURNING id, email`,
    [env.owner.email.toLowerCase(), hash, env.owner.name]
  )
  log.ok("migrate", "usuario dueño creado:", user.email)
}

if (require.main === module) {
  db.waitForDb()
    .then(migrate)
    .then(() => process.exit(0))
    .catch(e => { log.error("migrate", e.message); process.exit(1) })
}

module.exports = migrate
