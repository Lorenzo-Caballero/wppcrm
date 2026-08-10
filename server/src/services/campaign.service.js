// ============================================================
//  MOTOR DE DIFUSIÓN
//
//  Reglas anti-baneo heredadas de fau.js, ahora configurables por campaña:
//   · espera aleatoria entre mensaje y mensaje (20 s – 5 min por defecto)
//   · envío en bloques de 25 con pausa larga entre bloques (2 – 5 min)
//   · ventana horaria: fuera de horario duerme hasta la próxima apertura
//   · un contacto no recibe dos veces (dedupe por campaña + cooldown global)
//   · cada mensaje se genera distinto (spintax + sinónimos + IA opcional)
//   · simulación de tipeo antes de cada envío
//   · tope diario de mensajes por cliente
// ============================================================
const db  = require("../config/db")
const log = require("../utils/logger")
const bus = require("../realtime/bus")
const { sleep, sleepRandomAbortable, randomInt } = require("../utils/random")
const { dentroDeVentana, msHastaProximaApertura } = require("../utils/time")
const { renderizarMensaje } = require("./message.service")
const chatService    = require("./chat.service")
const sessionManager = require("../whatsapp/sessionManager")

// ------------------------------------------------------------
//  Configuración por defecto (los mismos números que fau.js)
// ------------------------------------------------------------
const DEFAULTS = {
  delayMinMs:      20_000,    // 20 segundos
  delayMaxMs:     300_000,    // 5 minutos
  bloqueTamano:        25,
  bloqueDelayMinMs: 120_000,  // 2 minutos
  bloqueDelayMaxMs: 300_000,  // 5 minutos
  ventana: { inicio: "07:00", fin: "23:30", dias: [0, 1, 2, 3, 4, 5, 6] },
  sinonimos: 0.35,
  usarIA: false,
  cooldownDias: 30,           // no re-impactar al mismo contacto antes de X días
  topeDiario: null            // null = usa el daily_limit del cliente
}

/** campaignId -> { cancelar, pausar, control:{aborted} } */
const corriendo = new Map()

function mergeSettings(settings = {}) {
  return {
    ...DEFAULTS,
    ...settings,
    ventana: { ...DEFAULTS.ventana, ...(settings.ventana || {}) }
  }
}

// ------------------------------------------------------------
//  AUDIENCIA
// ------------------------------------------------------------
/**
 * Traduce los filtros del panel a la lista real de destinatarios.
 * filtros = {
 *   areas: ["223","11"], paises: ["54"], provincias: ["Buenos Aires"],
 *   jids: [...],  incluirArchivados: false, soloConRespuesta: false,
 *   excluirRecientes: true, limite: 500
 * }
 */
async function resolverAudiencia(tenantId, filtros = {}, settings = {}) {
  const cfg = mergeSettings(settings)

  if (Array.isArray(filtros.jids) && filtros.jids.length) {
    return db.many(
      `SELECT ct.id AS contact_id, ct.jid, ct.name, ct.push_name, ct.phone,
              ct.region, ct.province, ct.country, ct.area_code
         FROM contacts ct
        WHERE ct.tenant_id = $1 AND ct.jid = ANY($2::text[]) AND ct.is_group = FALSE`,
      [tenantId, filtros.jids]
    )
  }

  const where  = ["ct.tenant_id = $1", "ct.is_group = FALSE"]
  const params = [tenantId]
  let i = 1

  if (!filtros.incluirArchivados) where.push("(c.archived IS NULL OR c.archived = FALSE)")

  if (Array.isArray(filtros.areas) && filtros.areas.length) {
    params.push(filtros.areas); i++
    where.push(`ct.area_code = ANY($${i}::text[])`)
  }
  if (Array.isArray(filtros.paises) && filtros.paises.length) {
    params.push(filtros.paises); i++
    where.push(`ct.country_code = ANY($${i}::text[])`)
  }
  if (Array.isArray(filtros.provincias) && filtros.provincias.length) {
    params.push(filtros.provincias); i++
    where.push(`ct.province = ANY($${i}::text[])`)
  }
  if (filtros.soloConRespuesta) where.push("c.last_inbound_at IS NOT NULL")

  if (filtros.excluirRecientes !== false && cfg.cooldownDias > 0) {
    params.push(cfg.cooldownDias); i++
    where.push(`(ct.last_campaign_at IS NULL OR ct.last_campaign_at < now() - ($${i} || ' days')::interval)`)
  }

  const limite = Math.min(parseInt(filtros.limite, 10) || 5000, 20000)
  params.push(limite); const pLimite = ++i

  return db.many(
    `SELECT ct.id AS contact_id, ct.jid, ct.name, ct.push_name, ct.phone,
            ct.region, ct.province, ct.country, ct.area_code
       FROM contacts ct
       LEFT JOIN chats c ON c.contact_id = ct.id AND c.tenant_id = ct.tenant_id
      WHERE ${where.join(" AND ")}
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $${pLimite}`,
    params
  )
}

/** Cuántos destinatarios saldrían con esos filtros (para la vista previa). */
async function contarAudiencia(tenantId, filtros, settings) {
  const filas = await resolverAudiencia(tenantId, filtros, settings)
  const porZona = {}
  for (const f of filas) {
    const clave = f.region || f.country || "Sin datos"
    porZona[clave] = (porZona[clave] || 0) + 1
  }
  return {
    total: filas.length,
    porZona: Object.entries(porZona).map(([zona, total]) => ({ zona, total })).sort((a, b) => b.total - a.total)
  }
}

// ------------------------------------------------------------
//  CRUD
// ------------------------------------------------------------
async function crearCampania(tenantId, userId, payload) {
  const settings = mergeSettings(payload.settings)
  const filtros  = payload.filtros || {}

  const audiencia = await resolverAudiencia(tenantId, filtros, settings)
  if (!audiencia.length) throw new Error("Ningún contacto coincide con esos filtros")

  return db.tx(async client => {
    const { rows } = await client.query(
      `INSERT INTO campaigns (tenant_id, session_id, name, base_message, status, filters, settings, total, created_by)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8) RETURNING *`,
      [tenantId, payload.sessionId || null, payload.nombre, payload.mensaje,
       JSON.stringify(filtros), JSON.stringify(settings), audiencia.length, userId]
    )
    const campania = rows[0]

    // Inserción por lotes: una campaña puede tener miles de destinatarios.
    const LOTE = 500
    for (let i = 0; i < audiencia.length; i += LOTE) {
      const lote   = audiencia.slice(i, i + LOTE)
      const values = []
      const params = []
      lote.forEach((a, idx) => {
        const base = idx * 4
        values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4})`)
        params.push(campania.id, a.contact_id, a.jid, a.name || a.push_name || null)
      })
      await client.query(
        `INSERT INTO campaign_targets (campaign_id, contact_id, jid, name)
         VALUES ${values.join(",")} ON CONFLICT (campaign_id, jid) DO NOTHING`,
        params
      )
    }
    return campania
  })
}

async function listarCampanias(tenantId) {
  return db.many(
    `SELECT c.*, s.label AS session_label, s.status AS session_status
       FROM campaigns c LEFT JOIN wa_sessions s ON s.id = c.session_id
      WHERE c.tenant_id = $1 ORDER BY c.created_at DESC LIMIT 100`,
    [tenantId]
  )
}

async function obtenerCampania(tenantId, id) {
  const campania = await db.one("SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2", [tenantId, id])
  if (!campania) return null
  const targets = await db.many(
    `SELECT jid, name, status, error, sent_at, rendered
       FROM campaign_targets WHERE campaign_id = $1
      ORDER BY (status <> 'pending') DESC, sent_at DESC NULLS LAST LIMIT 500`,
    [id]
  )
  return { ...campania, targets, enMemoria: corriendo.has(id) }
}

// ------------------------------------------------------------
//  CONTROL
// ------------------------------------------------------------
async function iniciarCampania(tenantId, id) {
  const campania = await db.one("SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2", [tenantId, id])
  if (!campania) throw new Error("Difusión no encontrada")
  if (corriendo.has(id)) return { ok: true, mensaje: "La difusión ya está corriendo" }
  if (["done", "cancelled"].includes(campania.status)) throw new Error("Esta difusión ya finalizó")

  const sesion = await db.one(
    "SELECT * FROM wa_sessions WHERE tenant_id = $1 AND id = COALESCE($2, (SELECT id FROM wa_sessions WHERE tenant_id = $1 ORDER BY id LIMIT 1))",
    [tenantId, campania.session_id]
  )
  if (!sesion) throw new Error("El cliente no tiene ninguna sesión de WhatsApp configurada")
  if (!sessionManager.obtenerCliente(sesion.session_key)) {
    throw new Error("La sesión de WhatsApp no está conectada. Escaneá el QR antes de difundir.")
  }

  await db.query(
    "UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, now()), finished_at = NULL WHERE id = $1",
    [id]
  )

  const control = { aborted: false, motivo: null }
  corriendo.set(id, control)

  // El runner vive fuera del ciclo de la request.
  ejecutarCampania(campania, sesion, control)
    .catch(e => log.error("difusion", "campaña " + id + ":", e.message))
    .finally(() => corriendo.delete(id))

  return { ok: true, mensaje: "Difusión iniciada" }
}

async function pausarCampania(tenantId, id) {
  const control = corriendo.get(id)
  if (control) { control.aborted = true; control.motivo = "paused" }
  await db.query("UPDATE campaigns SET status = 'paused' WHERE tenant_id = $1 AND id = $2", [tenantId, id])
  emitirEstado(tenantId, id, "paused")
  return { ok: true }
}

async function cancelarCampania(tenantId, id) {
  const control = corriendo.get(id)
  if (control) { control.aborted = true; control.motivo = "cancelled" }
  await db.query(
    "UPDATE campaigns SET status = 'cancelled', finished_at = now() WHERE tenant_id = $1 AND id = $2",
    [tenantId, id]
  )
  emitirEstado(tenantId, id, "cancelled")
  return { ok: true }
}

function emitirEstado(tenantId, id, status, extra = {}) {
  bus.aTenant(tenantId, "campaign:status", { id, status, ...extra })
}

// ------------------------------------------------------------
//  RUNNER
// ------------------------------------------------------------
async function mensajesEnviadosHoy(tenantId) {
  const r = await db.one(
    `SELECT COUNT(*)::int AS n FROM messages
      WHERE tenant_id = $1 AND campaign_id IS NOT NULL
        AND sent_at >= date_trunc('day', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')`,
    [tenantId]
  )
  return r?.n || 0
}

/** Busca el chat del destinatario; si no existe lo crea para que la difusión quede en el CRM. */
async function asegurarChat(tenantId, sessionId, target) {
  const existente = await chatService.obtenerChatPorJid(tenantId, target.jid)
  if (existente) return existente

  const contacto = await chatService.upsertContacto(tenantId, {
    jid: target.jid, name: target.name || null
  })
  return chatService.upsertChat(tenantId, sessionId, contacto.id, target.jid)
}

async function ejecutarCampania(campania, sesion, control) {
  const cfg      = mergeSettings(campania.settings)
  const tenantId = campania.tenant_id
  const id       = campania.id

  const tenant = await db.one("SELECT daily_limit FROM tenants WHERE id = $1", [tenantId])
  const topeDiario = cfg.topeDiario || tenant?.daily_limit || 300

  log.info("difusion", "campaña " + id + " arranca | delay " +
    (cfg.delayMinMs / 1000) + "-" + (cfg.delayMaxMs / 1000) + "s | bloques de " + cfg.bloqueTamano)

  let enBloque = 0

  while (!control.aborted) {
    const target = await db.one(
      `SELECT t.*, ct.region, ct.province, ct.country, ct.area_code, ct.phone, ct.push_name
         FROM campaign_targets t
         LEFT JOIN contacts ct ON ct.id = t.contact_id
        WHERE t.campaign_id = $1 AND t.status = 'pending'
        ORDER BY t.id LIMIT 1`,
      [id]
    )
    if (!target) break // no quedan pendientes

    // ---- Ventana horaria: fuera de hora, dormimos hasta la apertura ----
    if (!dentroDeVentana(cfg.ventana)) {
      const espera = msHastaProximaApertura(cfg.ventana)
      log.info("difusion", "campaña " + id + " fuera de horario, reanuda en " + Math.round(espera / 60000) + " min")
      emitirEstado(tenantId, id, "running", { esperando: "fuera_de_horario", reanudaEnMs: espera })
      const dormido = await esperaCortable(espera, control)
      if (dormido.aborted) break
      continue
    }

    // ---- Tope diario del cliente ----
    const hoy = await mensajesEnviadosHoy(tenantId)
    if (hoy >= topeDiario) {
      log.warn("difusion", "campaña " + id + ": tope diario alcanzado (" + hoy + "/" + topeDiario + ")")
      emitirEstado(tenantId, id, "running", { esperando: "tope_diario", enviadosHoy: hoy, topeDiario })
      const dormido = await esperaCortable(msHastaProximaApertura(cfg.ventana), control)
      if (dormido.aborted) break
      continue
    }

    // ---- La sesión puede haberse caído a mitad de campaña ----
    const client = sessionManager.obtenerCliente(sesion.session_key)
    if (!client) {
      log.warn("difusion", "campaña " + id + ": sesión desconectada, pauso")
      await db.query("UPDATE campaigns SET status = 'paused' WHERE id = $1", [id])
      emitirEstado(tenantId, id, "paused", { motivo: "sesion_desconectada" })
      return
    }

    // ---- Render único para este contacto ----
    let textoFinal = ""
    try {
      textoFinal = await renderizarMensaje(campania.base_message, {
        name: target.name, push_name: target.push_name, phone: target.phone,
        region: target.region, province: target.province, country: target.country
      }, { sinonimos: cfg.sinonimos, usarIA: cfg.usarIA })
    } catch (e) {
      textoFinal = campania.base_message
      log.warn("difusion", "render falló, uso el mensaje base: " + e.message)
    }

    // ---- Envío (con tipeo simulado, igual que fau.js) ----
    try {
      const chatFila = await asegurarChat(tenantId, sesion.id, target)
      const envio    = await require("../whatsapp/sender").enviarConTyping(client, target.jid, textoFinal)

      await db.query(
        "UPDATE campaign_targets SET status = 'sent', rendered = $2, sent_at = now(), error = NULL WHERE id = $1",
        [target.id, textoFinal]
      )
      await db.query("UPDATE campaigns SET sent = sent + 1 WHERE id = $1", [id])
      if (target.contact_id) {
        await db.query("UPDATE contacts SET last_campaign_at = now() WHERE id = $1", [target.contact_id])
      }

      // Queda registrada en el chat, así el operador ve qué se le mandó.
      await chatService.registrarMensaje(tenantId, chatFila.id, {
        waMsgId:   envio.id || null,
        direction: "out",
        type:      "chat",
        body:      textoFinal,
        status:    "sent",
        author:    "Difusión: " + campania.name,
        campaignId: id
      })

      log.ok("difusion", "campaña " + id + " → " + (target.name || target.jid))
    } catch (e) {
      await db.query(
        "UPDATE campaign_targets SET status = 'failed', error = $2, rendered = $3 WHERE id = $1",
        [target.id, (e.message || "error").slice(0, 400), textoFinal]
      )
      await db.query("UPDATE campaigns SET failed = failed + 1 WHERE id = $1", [id])
      log.error("difusion", "campaña " + id + " falló con " + target.jid + ":", e.message)
      await sleep(5000)
    }

    // ---- Progreso en vivo ----
    const stats = await db.one(
      "SELECT total, sent, failed, skipped FROM campaigns WHERE id = $1", [id]
    )
    bus.aTenant(tenantId, "campaign:progress", { id, ...stats, ultimo: target.name || target.jid })

    if (control.aborted) break

    // ---- Pausas anti-baneo ----
    enBloque++
    if (enBloque >= cfg.bloqueTamano) {
      enBloque = 0
      log.info("difusion", "campaña " + id + ": pausa entre bloques")
      emitirEstado(tenantId, id, "running", { esperando: "pausa_bloque" })
      const r = await sleepRandomAbortable(cfg.bloqueDelayMinMs, cfg.bloqueDelayMaxMs, control)
      if (r.aborted) break
    } else {
      const r = await sleepRandomAbortable(cfg.delayMinMs, cfg.delayMaxMs, control)
      if (r.aborted) break
    }
  }

  // ---- Cierre ----
  const pendientes = await db.one(
    "SELECT COUNT(*)::int AS n FROM campaign_targets WHERE campaign_id = $1 AND status = 'pending'", [id]
  )
  if (control.aborted) {
    const estado = control.motivo === "cancelled" ? "cancelled" : "paused"
    await db.query(
      "UPDATE campaigns SET status = $2, finished_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE NULL END WHERE id = $1",
      [id, estado]
    )
    emitirEstado(tenantId, id, estado)
    log.info("difusion", "campaña " + id + " " + estado)
  } else if (!pendientes.n) {
    await db.query("UPDATE campaigns SET status = 'done', finished_at = now() WHERE id = $1", [id])
    emitirEstado(tenantId, id, "done")
    log.ok("difusion", "campaña " + id + " finalizada")
  }
}

/** Espera larga que se corta apenas se pausa/cancela la campaña. */
async function esperaCortable(ms, control) {
  const fin = Date.now() + ms
  while (Date.now() < fin) {
    if (control.aborted) return { aborted: true }
    await sleep(Math.min(5000, fin - Date.now()))
  }
  return { aborted: false }
}

// ------------------------------------------------------------
//  REANUDAR TRAS UN REINICIO DEL SERVIDOR
// ------------------------------------------------------------
async function reanudarCampaniasActivas() {
  const activas = await db.many("SELECT * FROM campaigns WHERE status = 'running'")
  for (const c of activas) {
    try {
      await iniciarCampania(c.tenant_id, c.id)
      log.ok("difusion", "campaña " + c.id + " reanudada tras reinicio")
    } catch (e) {
      await db.query("UPDATE campaigns SET status = 'paused' WHERE id = $1", [c.id])
      log.warn("difusion", "campaña " + c.id + " quedó en pausa: " + e.message)
    }
  }
}

module.exports = {
  DEFAULTS, mergeSettings,
  resolverAudiencia, contarAudiencia,
  crearCampania, listarCampanias, obtenerCampania,
  iniciarCampania, pausarCampania, cancelarCampania,
  reanudarCampaniasActivas
}
