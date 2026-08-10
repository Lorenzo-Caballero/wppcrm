// ============================================================
//  Capa de datos del CRM: contactos, chats y mensajes.
//  Todo recibe tenant_id explícito — ningún query puede cruzar clientes.
// ============================================================
const db  = require("../config/db")
const log = require("../utils/logger")
const { analizarNumero, jidANumero } = require("../utils/phone")

// ------------------------------------------------------------
//  CONTACTOS
// ------------------------------------------------------------
/**
 * Crea o actualiza un contacto y calcula su origen geográfico por prefijo.
 * Nunca pisa un nombre existente con null.
 */
async function upsertContacto(tenantId, { jid, name, pushName, isGroup = false }) {
  const geo   = analizarNumero(jid)
  const phone = jidANumero(jid)

  return db.one(
    `INSERT INTO contacts
       (tenant_id, jid, phone, name, push_name, country, country_code, area_code, region, province, is_group)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tenant_id, jid) DO UPDATE SET
       name         = COALESCE(NULLIF(EXCLUDED.name, ''),      contacts.name),
       push_name    = COALESCE(NULLIF(EXCLUDED.push_name, ''), contacts.push_name),
       phone        = COALESCE(EXCLUDED.phone,        contacts.phone),
       country      = COALESCE(EXCLUDED.country,      contacts.country),
       country_code = COALESCE(EXCLUDED.country_code, contacts.country_code),
       area_code    = COALESCE(EXCLUDED.area_code,    contacts.area_code),
       region       = COALESCE(EXCLUDED.region,       contacts.region),
       province     = COALESCE(EXCLUDED.province,     contacts.province)
     RETURNING *`,
    [tenantId, jid, phone, name || null, pushName || null,
     geo.country, geo.countryCode, geo.areaCode, geo.region, geo.province, isGroup]
  )
}

// ------------------------------------------------------------
//  CHATS
// ------------------------------------------------------------
async function upsertChat(tenantId, sessionId, contactId, waChatId, extra = {}) {
  // `archived` solo se pisa cuando viene explícito (sincronización con WhatsApp).
  // Si no, un mensaje entrante desarchivaría un chat que el operador archivó a mano.
  const archived = extra.archived === undefined ? null : !!extra.archived

  return db.one(
    `INSERT INTO chats (tenant_id, session_id, contact_id, wa_chat_id, archived, unread_count)
     VALUES ($1,$2,$3,$4,COALESCE($5, FALSE),$6)
     ON CONFLICT (tenant_id, wa_chat_id) DO UPDATE SET
       session_id = EXCLUDED.session_id,
       archived   = COALESCE($5::boolean, chats.archived)
     RETURNING *`,
    [tenantId, sessionId, contactId, waChatId, archived, extra.unreadCount || 0]
  )
}

/**
 * Listado principal del CRM. Soporta filtro por país, código de área,
 * provincia, estado, búsqueda de texto y ordenamiento.
 */
async function listarChats(tenantId, opciones = {}) {
  const {
    search = "", area = "", country = "", province = "",
    status = "", soloNoLeidos = false, incluirArchivados = false,
    orden = "reciente", limit = 60, offset = 0
  } = opciones

  const where  = ["c.tenant_id = $1"]
  const params = [tenantId]
  let i = 1

  if (!incluirArchivados) where.push("c.archived = FALSE")
  if (search) {
    params.push("%" + search.toLowerCase() + "%"); i++
    where.push(`(LOWER(COALESCE(ct.name,'')) LIKE $${i}
              OR LOWER(COALESCE(ct.push_name,'')) LIKE $${i}
              OR ct.phone LIKE $${i}
              OR LOWER(COALESCE(c.last_message_text,'')) LIKE $${i})`)
  }
  if (area)     { params.push(area);     i++; where.push(`ct.area_code    = $${i}`) }
  if (country)  { params.push(country);  i++; where.push(`ct.country_code = $${i}`) }
  if (province) { params.push(province); i++; where.push(`ct.province     = $${i}`) }
  if (status)   { params.push(status);   i++; where.push(`c.status        = $${i}`) }
  if (soloNoLeidos) where.push("c.unread_count > 0")

  const ORDENES = {
    reciente:  "c.pinned DESC, c.last_message_at DESC NULLS LAST",
    antiguo:   "c.pinned DESC, c.last_message_at ASC  NULLS LAST",
    respuesta: "c.pinned DESC, c.last_inbound_at DESC NULLS LAST",
    nombre:    "c.pinned DESC, LOWER(COALESCE(ct.name, ct.push_name, ct.phone)) ASC",
    noleidos:  "c.pinned DESC, c.unread_count DESC, c.last_message_at DESC NULLS LAST",
    area:      "c.pinned DESC, ct.area_code ASC NULLS LAST, c.last_message_at DESC NULLS LAST"
  }
  const orderBy = ORDENES[orden] || ORDENES.reciente

  params.push(limit); const pLimit = ++i
  params.push(offset); const pOffset = ++i

  return db.many(
    `SELECT c.id, c.wa_chat_id, c.unread_count, c.last_message_at, c.last_message_text,
            c.last_direction, c.last_inbound_at, c.archived, c.pinned, c.status, c.tags,
            ct.id AS contact_id, ct.jid, ct.phone, ct.name, ct.push_name,
            ct.country, ct.country_code, ct.area_code, ct.region, ct.province, ct.is_group
       FROM chats c
       JOIN contacts ct ON ct.id = c.contact_id
      WHERE ${where.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT $${pLimit} OFFSET $${pOffset}`,
    params
  )
}

/** Cuenta de chats agrupada por zona — alimenta los filtros laterales. */
async function facetasPorZona(tenantId) {
  const areas = await db.many(
    `SELECT ct.area_code, ct.region, ct.province, COUNT(*)::int AS total
       FROM chats c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.tenant_id = $1 AND ct.country_code = '54' AND ct.area_code IS NOT NULL
      GROUP BY ct.area_code, ct.region, ct.province
      ORDER BY total DESC`,
    [tenantId]
  )
  const paises = await db.many(
    `SELECT ct.country_code, ct.country, COUNT(*)::int AS total
       FROM chats c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.tenant_id = $1 AND ct.country_code IS NOT NULL
      GROUP BY ct.country_code, ct.country
      ORDER BY total DESC`,
    [tenantId]
  )
  return { areas, paises }
}

async function obtenerChat(tenantId, chatId) {
  return db.one(
    `SELECT c.*, ct.jid, ct.phone, ct.name, ct.push_name, ct.country, ct.country_code,
            ct.area_code, ct.region, ct.province, ct.is_group
       FROM chats c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, chatId]
  )
}

async function obtenerChatPorJid(tenantId, jid) {
  return db.one(
    `SELECT c.*, ct.jid, ct.phone, ct.name, ct.push_name
       FROM chats c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.tenant_id = $1 AND c.wa_chat_id = $2`,
    [tenantId, jid]
  )
}

async function actualizarChat(tenantId, chatId, campos) {
  const permitidos = ["status", "pinned", "archived", "unread_count", "tags"]
  const sets = [], params = [tenantId, chatId]
  let i = 2
  for (const [k, v] of Object.entries(campos)) {
    if (!permitidos.includes(k)) continue
    params.push(v); i++
    sets.push(`${k} = $${i}`)
  }
  if (!sets.length) return obtenerChat(tenantId, chatId)

  await db.query(`UPDATE chats SET ${sets.join(", ")} WHERE tenant_id = $1 AND id = $2`, params)
  return obtenerChat(tenantId, chatId)
}

async function marcarLeido(tenantId, chatId) {
  await db.query("UPDATE chats SET unread_count = 0 WHERE tenant_id = $1 AND id = $2", [tenantId, chatId])
}

// ------------------------------------------------------------
//  MENSAJES
// ------------------------------------------------------------
/**
 * Guarda un mensaje y actualiza los agregados del chat
 * (último mensaje, última vez que escribió el cliente, no leídos).
 */
async function registrarMensaje(tenantId, chatId, datos) {
  const {
    waMsgId = null, direction, type = "chat", body = "",
    mediaUrl = null, status = null, author = null,
    campaignId = null, sentAt = new Date(), sumarNoLeido = false
  } = datos

  const msg = await db.one(
    `INSERT INTO messages
       (tenant_id, chat_id, wa_msg_id, direction, type, body, media_url, status, author, campaign_id, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tenant_id, wa_msg_id) DO NOTHING
     RETURNING *`,
    [tenantId, chatId, waMsgId, direction, type, body, mediaUrl, status, author, campaignId, sentAt]
  )
  if (!msg) return null // duplicado: WhatsApp reemitió el mismo id

  const preview = (body || "[" + type + "]").slice(0, 160)
  await db.query(
    `UPDATE chats SET
       last_message_at   = GREATEST(COALESCE(last_message_at, to_timestamp(0)), $3),
       last_message_text = $4,
       last_direction    = $5,
       last_inbound_at   = CASE WHEN $5 = 'in'
                                THEN GREATEST(COALESCE(last_inbound_at, to_timestamp(0)), $3)
                                ELSE last_inbound_at END,
       unread_count      = CASE WHEN $6 THEN unread_count + 1 ELSE unread_count END
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, chatId, sentAt, preview, direction, sumarNoLeido]
  )
  return msg
}

async function listarMensajes(tenantId, chatId, { limit = 60, beforeId = null } = {}) {
  const params = [tenantId, chatId, limit]
  const filtroId = beforeId ? "AND id < $4" : ""
  if (beforeId) params.push(beforeId)

  const rows = await db.many(
    `SELECT * FROM messages
      WHERE tenant_id = $1 AND chat_id = $2 ${filtroId}
      ORDER BY sent_at DESC, id DESC
      LIMIT $3`,
    params
  )
  return rows.reverse() // el front los quiere en orden cronológico
}

async function resumenTenant(tenantId) {
  const r = await db.one(
    `SELECT
       (SELECT COUNT(*)::int FROM chats    WHERE tenant_id = $1)                                AS chats,
       (SELECT COUNT(*)::int FROM chats    WHERE tenant_id = $1 AND unread_count > 0)           AS no_leidos,
       (SELECT COUNT(*)::int FROM contacts WHERE tenant_id = $1)                                AS contactos,
       (SELECT COUNT(*)::int FROM messages WHERE tenant_id = $1 AND sent_at > now() - interval '24 hours') AS mensajes_24h,
       (SELECT COUNT(*)::int FROM campaigns WHERE tenant_id = $1 AND status = 'running')        AS difusiones_activas`,
    [tenantId]
  )
  return r || {}
}

module.exports = {
  upsertContacto, upsertChat, listarChats, facetasPorZona,
  obtenerChat, obtenerChatPorJid, actualizarChat, marcarLeido,
  registrarMensaje, listarMensajes, resumenTenant
}
