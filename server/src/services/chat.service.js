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
       -- Los campos geográficos se PISAN siempre, sin COALESCE: se derivan del
       -- jid de forma determinista, así que recalcularlos es siempre correcto.
       -- Con COALESCE, una detección vieja y errónea quedaba pegada para
       -- siempre (un @lid clasificado como "Estados Unidos" nunca se limpiaba).
       country      = EXCLUDED.country,
       country_code = EXCLUDED.country_code,
       area_code    = EXCLUDED.area_code,
       region       = EXCLUDED.region,
       province     = EXCLUDED.province
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
/**
 * Construye el WHERE compartido por el listado y por el contador.
 * Devuelve { where, params, i } para que quien llame siga numerando desde ahí.
 */
function armarFiltros(tenantId, opciones = {}) {
  const {
    search = "", area = "", country = "", province = "",
    status = "", tag = "", quien = "", friosDias = 0,
    soloNoLeidos = false, incluirArchivados = false
  } = opciones

  const where  = ["c.tenant_id = $1"]
  const params = [tenantId]
  let i = 1

  if (!incluirArchivados) where.push("c.archived = FALSE")

  // Búsqueda por nombre, texto del último mensaje o teléfono.
  // Para el teléfono comparamos solo dígitos, así "223 407-7440",
  // "+54 9 223 4077440" y "2234077440" encuentran lo mismo.
  if (search) {
    const partes = []
    params.push("%" + search.toLowerCase() + "%")
    const pTexto = ++i
    partes.push(`LOWER(COALESCE(ct.name,''))            LIKE $${pTexto}`)
    partes.push(`LOWER(COALESCE(ct.push_name,''))       LIKE $${pTexto}`)
    partes.push(`LOWER(COALESCE(c.last_message_text,'')) LIKE $${pTexto}`)

    const digitos = String(search).replace(/\D/g, "")
    if (digitos.length >= 3) {
      params.push("%" + digitos + "%")
      partes.push(`ct.phone LIKE $${++i}`)
    }
    where.push("(" + partes.join(" OR ") + ")")
  }

  if (area)     { params.push(area);     where.push(`ct.area_code    = $${++i}`) }
  if (country)  { params.push(country);  where.push(`ct.country_code = $${++i}`) }
  if (province) { params.push(province); where.push(`ct.province     = $${++i}`) }
  if (status)   { params.push(status);   where.push(`c.status        = $${++i}`) }
  if (tag)      { params.push(tag);      where.push(`$${++i} = ANY(c.tags)`) }

  // Quién habló último
  if (quien === "cliente") where.push("c.last_direction = 'in'")
  if (quien === "yo")      where.push("c.last_direction = 'out'")
  if (quien === "ninguno") where.push("c.last_direction IS NULL")

  // Contactos "fríos": hace N días que el cliente no escribe (o nunca escribió).
  const dias = parseInt(friosDias, 10)
  if (Number.isFinite(dias) && dias > 0) {
    params.push(dias)
    where.push(`(c.last_inbound_at IS NULL OR c.last_inbound_at < now() - ($${++i} || ' days')::interval)`)
  }

  if (soloNoLeidos) where.push("c.unread_count > 0")

  return { where, params, i }
}

const ORDENES = {
  reciente:  "c.pinned DESC, c.last_message_at DESC NULLS LAST",
  antiguo:   "c.pinned DESC, c.last_message_at ASC  NULLS LAST",
  respuesta: "c.pinned DESC, c.last_inbound_at DESC NULLS LAST",
  // Para reactivar: primero los que nunca contestaron, después los más olvidados.
  frios:     "c.pinned DESC, c.last_inbound_at ASC  NULLS FIRST",
  nombre:    "c.pinned DESC, LOWER(COALESCE(ct.name, ct.push_name, ct.phone)) ASC",
  noleidos:  "c.pinned DESC, c.unread_count DESC, c.last_message_at DESC NULLS LAST",
  area:      "c.pinned DESC, ct.area_code ASC NULLS LAST, c.last_message_at DESC NULLS LAST"
}

async function listarChats(tenantId, opciones = {}) {
  const { limit = 60, offset = 0, orden = "reciente" } = opciones
  const { where, params, i } = armarFiltros(tenantId, opciones)

  const orderBy = ORDENES[orden] || ORDENES.reciente
  params.push(limit);  const pLimit  = i + 1
  params.push(offset); const pOffset = i + 2

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

/** Cuántos chats hay en total con esos filtros (el listado viene paginado). */
async function contarChats(tenantId, opciones = {}) {
  const { where, params } = armarFiltros(tenantId, opciones)
  const r = await db.one(
    `SELECT COUNT(*)::int AS total
       FROM chats c JOIN contacts ct ON ct.id = c.contact_id
      WHERE ${where.join(" AND ")}`,
    params
  )
  return r?.total || 0
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
  const provincias = await db.many(
    `SELECT ct.province, COUNT(*)::int AS total
       FROM chats c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.tenant_id = $1 AND ct.country_code = '54' AND ct.province IS NOT NULL
      GROUP BY ct.province
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
  return { areas, provincias, paises }
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

async function marcarTodoLeido(tenantId) {
  const r = await db.query(
    "UPDATE chats SET unread_count = 0 WHERE tenant_id = $1 AND unread_count > 0", [tenantId]
  )
  return r.rowCount
}

// ------------------------------------------------------------
//  OPERACIONES MASIVAS (sobre la selección del CRM)
// ------------------------------------------------------------
/**
 * Aplica una acción a varios chats de una vez.
 * @param accion etiquetar | desetiquetar | archivar | desarchivar | leer |
 *               estado | fijar | desfijar | seguimiento
 */
async function accionMasiva(tenantId, ids, accion, valor) {
  const lista = (ids || []).map(n => parseInt(n, 10)).filter(Number.isFinite)
  if (!lista.length) return { afectados: 0 }

  const SQL = {
    etiquetar:   ["UPDATE chats SET tags = array_append(tags, $3) WHERE tenant_id = $1 AND id = ANY($2::bigint[]) AND NOT ($3 = ANY(tags))", true],
    desetiquetar:["UPDATE chats SET tags = array_remove(tags, $3) WHERE tenant_id = $1 AND id = ANY($2::bigint[])", true],
    archivar:    ["UPDATE chats SET archived = TRUE  WHERE tenant_id = $1 AND id = ANY($2::bigint[])", false],
    desarchivar: ["UPDATE chats SET archived = FALSE WHERE tenant_id = $1 AND id = ANY($2::bigint[])", false],
    fijar:       ["UPDATE chats SET pinned   = TRUE  WHERE tenant_id = $1 AND id = ANY($2::bigint[])", false],
    desfijar:    ["UPDATE chats SET pinned   = FALSE WHERE tenant_id = $1 AND id = ANY($2::bigint[])", false],
    leer:        ["UPDATE chats SET unread_count = 0 WHERE tenant_id = $1 AND id = ANY($2::bigint[])", false],
    estado:      ["UPDATE chats SET status = $3 WHERE tenant_id = $1 AND id = ANY($2::bigint[])", true],
    seguimiento: ["UPDATE chats SET follow_up_at = $3::timestamptz WHERE tenant_id = $1 AND id = ANY($2::bigint[])", true]
  }

  const entrada = SQL[accion]
  if (!entrada) throw new Error("Acción desconocida: " + accion)

  const [sql, usaValor] = entrada
  const params = usaValor ? [tenantId, lista, valor] : [tenantId, lista]
  const r = await db.query(sql, params)
  return { afectados: r.rowCount }
}

/** Trae los chats seleccionados (para difundir o exportar). */
async function chatsPorIds(tenantId, ids) {
  const lista = (ids || []).map(n => parseInt(n, 10)).filter(Number.isFinite)
  if (!lista.length) return []
  return db.many(
    `SELECT c.id, c.wa_chat_id, c.status, c.tags, c.last_message_at, c.last_inbound_at,
            ct.jid, ct.phone, ct.name, ct.push_name, ct.region, ct.province, ct.country, ct.area_code
       FROM chats c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.tenant_id = $1 AND c.id = ANY($2::bigint[])`,
    [tenantId, lista]
  )
}

/** Todos los ids que coinciden con los filtros — para "seleccionar todos". */
async function idsFiltrados(tenantId, opciones = {}, tope = 20000) {
  const { where, params, i } = armarFiltros(tenantId, opciones)
  params.push(tope)
  const filas = await db.many(
    `SELECT c.id FROM chats c JOIN contacts ct ON ct.id = c.contact_id
      WHERE ${where.join(" AND ")} LIMIT $${i + 1}`,
    params
  )
  return filas.map(f => f.id)
}

/** CSV con los contactos seleccionados o filtrados. */
function aCsv(filas) {
  const cols = ["telefono", "nombre", "zona", "provincia", "pais", "estado",
                "etiquetas", "ultimo_mensaje", "ultima_respuesta"]
  const escapar = v => {
    const s = v === null || v === undefined ? "" : String(v)
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const lineas = [cols.join(";")]
  for (const f of filas) {
    lineas.push([
      f.phone, f.name || f.push_name || "", f.region || "", f.province || "",
      f.country || "", f.status || "", (f.tags || []).join("|"),
      f.last_message_at ? new Date(f.last_message_at).toISOString() : "",
      f.last_inbound_at ? new Date(f.last_inbound_at).toISOString() : ""
    ].map(escapar).join(";"))
  }
  // BOM para que Excel en Windows respete los acentos.
  return "﻿" + lineas.join("\r\n")
}

// ------------------------------------------------------------
//  NOTAS Y SEGUIMIENTO
// ------------------------------------------------------------
async function guardarNotas(tenantId, chatId, notas) {
  await db.query("UPDATE chats SET notes = $3 WHERE tenant_id = $1 AND id = $2",
    [tenantId, chatId, String(notas || "").slice(0, 5000)])
  return obtenerChat(tenantId, chatId)
}

async function definirSeguimiento(tenantId, chatId, cuando) {
  await db.query("UPDATE chats SET follow_up_at = $3::timestamptz WHERE tenant_id = $1 AND id = $2",
    [tenantId, chatId, cuando || null])
  return obtenerChat(tenantId, chatId)
}

/** Seguimientos ya vencidos: la lista de "a quién le tengo que escribir hoy". */
async function seguimientosPendientes(tenantId) {
  return db.many(
    `SELECT c.id, c.follow_up_at, ct.name, ct.push_name, ct.phone, ct.region
       FROM chats c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.tenant_id = $1 AND c.follow_up_at IS NOT NULL AND c.follow_up_at <= now()
      ORDER BY c.follow_up_at ASC LIMIT 100`,
    [tenantId]
  )
}

// ------------------------------------------------------------
//  RESPUESTAS RÁPIDAS
// ------------------------------------------------------------
async function listarRespuestasRapidas(tenantId) {
  return db.many("SELECT * FROM quick_replies WHERE tenant_id = $1 ORDER BY shortcut", [tenantId])
}

async function guardarRespuestaRapida(tenantId, { shortcut, body }) {
  const atajo = String(shortcut || "").trim().replace(/^\//, "").slice(0, 30)
  if (!atajo) throw new Error("Falta el atajo")
  if (!String(body || "").trim()) throw new Error("Falta el texto")

  return db.one(
    `INSERT INTO quick_replies (tenant_id, shortcut, body) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, shortcut) DO UPDATE SET body = EXCLUDED.body
     RETURNING *`,
    [tenantId, atajo, body]
  )
}

async function borrarRespuestaRapida(tenantId, id) {
  await db.query("DELETE FROM quick_replies WHERE tenant_id = $1 AND id = $2", [tenantId, id])
  return { ok: true }
}

// ------------------------------------------------------------
//  ETIQUETAS
// ------------------------------------------------------------
/** Todas las etiquetas usadas por el cliente, con cuántos chats tiene cada una. */
async function listarTags(tenantId) {
  return db.many(
    `SELECT etiqueta AS tag, COUNT(*)::int AS total
       FROM chats c, unnest(c.tags) AS etiqueta
      WHERE c.tenant_id = $1
      GROUP BY etiqueta
      ORDER BY total DESC, etiqueta ASC`,
    [tenantId]
  )
}

async function agregarTag(tenantId, chatId, tag) {
  const limpia = String(tag || "").trim().slice(0, 30)
  if (!limpia) throw new Error("La etiqueta está vacía")

  await db.query(
    `UPDATE chats SET tags = array_append(tags, $3)
      WHERE tenant_id = $1 AND id = $2 AND NOT ($3 = ANY(tags))`,
    [tenantId, chatId, limpia]
  )
  return obtenerChat(tenantId, chatId)
}

async function quitarTag(tenantId, chatId, tag) {
  await db.query(
    "UPDATE chats SET tags = array_remove(tags, $3) WHERE tenant_id = $1 AND id = $2",
    [tenantId, chatId, String(tag || "")]
  )
  return obtenerChat(tenantId, chatId)
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
    mediaUrl = null, mediaMime = null, mediaName = null, quotedId = null,
    status = null, author = null,
    campaignId = null, sentAt = new Date(), sumarNoLeido = false
  } = datos

  const msg = await db.one(
    `INSERT INTO messages
       (tenant_id, chat_id, wa_msg_id, direction, type, body, media_url, media_mime, media_name,
        quoted_id, status, author, campaign_id, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (tenant_id, wa_msg_id) DO NOTHING
     RETURNING *`,
    [tenantId, chatId, waMsgId, direction, type, body, mediaUrl, mediaMime, mediaName,
     quotedId, status, author, campaignId, sentAt]
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
  upsertContacto, upsertChat, listarChats, contarChats, facetasPorZona,
  obtenerChat, obtenerChatPorJid, actualizarChat, marcarLeido, marcarTodoLeido,
  listarTags, agregarTag, quitarTag,
  accionMasiva, chatsPorIds, idsFiltrados, aCsv,
  guardarNotas, definirSeguimiento, seguimientosPendientes,
  listarRespuestasRapidas, guardarRespuestaRapida, borrarRespuestaRapida,
  registrarMensaje, listarMensajes, resumenTenant, ORDENES
}
