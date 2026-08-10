const { Pool } = require("pg")
const env = require("./env")
const log = require("../utils/logger")

const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
})

pool.on("error", err => log.error("db", "error en cliente idle:", err.message))

async function query(text, params) {
  const start = Date.now()
  const res   = await pool.query(text, params)
  const ms    = Date.now() - start
  if (ms > 500) log.warn("db", "query lenta (" + ms + "ms):", text.slice(0, 90).replace(/\s+/g, " "))
  return res
}

/** Devuelve la primera fila o null. */
async function one(text, params) {
  const { rows } = await query(text, params)
  return rows[0] || null
}

/** Devuelve el array de filas. */
async function many(text, params) {
  const { rows } = await query(text, params)
  return rows
}

/** Ejecuta un callback dentro de una transacción. */
async function tx(fn) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

/** Espera a que Postgres esté listo (el contenedor puede tardar en arrancar). */
async function waitForDb(retries = 30, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query("SELECT 1")
      log.ok("db", "conectado")
      return
    } catch (e) {
      log.warn("db", "esperando Postgres (" + i + "/" + retries + "): " + e.message)
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
  throw new Error("No se pudo conectar a Postgres")
}

module.exports = { pool, query, one, many, tx, waitForDb }
