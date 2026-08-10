// ============================================================
//  Qué hacer con lo que llega de WhatsApp:
//  guardar contacto + chat + mensaje y avisar al CRM por WebSocket.
// ============================================================
const log  = require("../utils/logger")
const bus  = require("../realtime/bus")
const chatService = require("../services/chat.service")

/** Texto legible para tipos de mensaje que no son texto. */
function describirMensaje(msg) {
  const cuerpo = (msg.body || "").trim()
  switch (msg.type) {
    case "chat":     return cuerpo
    case "image":    return msg.caption || "📷 Foto"
    case "video":    return msg.caption || "🎥 Video"
    case "audio":
    case "ptt":      return "🎤 Audio"
    case "document": return "📄 " + (msg.filename || "Documento")
    case "sticker":  return "🩹 Sticker"
    case "location": return "📍 Ubicación"
    case "vcard":
    case "contact_card": return "👤 Contacto"
    default:         return cuerpo || "[" + msg.type + "]"
  }
}

/**
 * Registra un mensaje entrante. Devuelve { chat, message } o null si se ignoró.
 * @param {object} sesion  fila de wa_sessions
 */
async function procesarMensajeEntrante(sesion, msg) {
  try {
    if (msg.fromMe)                      return null
    if (msg.isGroupMsg)                  return null
    if (msg.type === "e2e_notification") return null
    if (msg.type === "notification")     return null
    if (msg.type === "notification_template") return null

    const jid = msg.from
    if (!jid || !/@(c\.us|lid)$/.test(jid)) return null

    const contacto = await chatService.upsertContacto(sesion.tenant_id, {
      jid,
      pushName: msg.sender?.pushname || msg.notifyName || null,
      name:     msg.sender?.name || msg.sender?.formattedName || null
    })

    const chat = await chatService.upsertChat(sesion.tenant_id, sesion.id, contacto.id, jid)

    const mensaje = await chatService.registrarMensaje(sesion.tenant_id, chat.id, {
      waMsgId:   msg.id?._serialized || msg.id || null,
      direction: "in",
      type:      msg.type || "chat",
      body:      describirMensaje(msg),
      sentAt:    msg.timestamp ? new Date(msg.timestamp * 1000) : new Date(),
      sumarNoLeido: true
    })
    if (!mensaje) return null

    const payload = {
      chatId:    chat.id,
      jid,
      contacto: {
        id: contacto.id, name: contacto.name, push_name: contacto.push_name,
        phone: contacto.phone, region: contacto.region, province: contacto.province,
        area_code: contacto.area_code, country: contacto.country
      },
      mensaje
    }
    bus.aTenant(sesion.tenant_id, "message:new", payload)
    log.info("wa:" + sesion.session_key, "entrante de", contacto.phone, "-", (mensaje.body || "").slice(0, 50))

    return { chat, mensaje, contacto }
  } catch (e) {
    log.error("handlers", "procesarMensajeEntrante:", e.message)
    return null
  }
}

/** Actualiza el estado de entrega (enviado / recibido / leído). */
async function procesarAck(sesion, ack) {
  try {
    const id = ack.id?._serialized || ack.id
    if (!id) return
    const MAPA = { 1: "sent", 2: "delivered", 3: "read", 4: "read" }
    const estado = MAPA[ack.ack]
    if (!estado) return

    await require("../config/db").query(
      "UPDATE messages SET status = $3 WHERE tenant_id = $1 AND wa_msg_id = $2",
      [sesion.tenant_id, id, estado]
    )
    bus.aTenant(sesion.tenant_id, "message:ack", { waMsgId: id, status: estado })
  } catch (e) {
    log.debug("handlers", "ack:", e.message)
  }
}

module.exports = { procesarMensajeEntrante, procesarAck, describirMensaje }
