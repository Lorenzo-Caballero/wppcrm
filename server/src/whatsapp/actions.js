// ============================================================
//  Acciones de WhatsApp expuestas en el CRM
//  Envuelve la API de wppconnect y deja todo registrado en la base
//  + avisa al front por WebSocket.
// ============================================================
const db  = require("../config/db")
const log = require("../utils/logger")
const bus = require("../realtime/bus")
const chatService  = require("../services/chat.service")
const mediaService = require("../services/media.service")
const sessionManager = require("./sessionManager")

function cliente(sesion) {
  const c = sessionManager.obtenerCliente(sesion.session_key)
  if (!c) throw new Error("La sesión de WhatsApp no está conectada")
  return c
}

function dataUri(mime, base64) {
  return "data:" + (mime || "application/octet-stream") + ";base64," + base64
}

// ============================================================
//  ENVÍO DE ARCHIVOS
// ============================================================
/**
 * Manda un archivo y lo deja guardado en la carpeta del cliente.
 * @param archivo { buffer, mime, nombre }
 * @param opciones { caption, comoNotaDeVoz, quotedId }
 */
async function enviarArchivo(sesion, chatFila, archivo, opciones = {}, autor = null) {
  const c = cliente(sesion)
  const guardado = mediaService.guardar(sesion.tenant_id, archivo.buffer, archivo.mime, archivo.nombre)
  const b64  = archivo.buffer.toString("base64")
  const uri  = dataUri(guardado.mime, b64)
  const jid  = chatFila.wa_chat_id
  const cap  = opciones.caption || ""

  let resultado
  try {
    if (guardado.tipo === "image") {
      resultado = await c.sendImageFromBase64(jid, uri, guardado.nombre, cap, opciones.quotedId || undefined)
    } else if (guardado.tipo === "audio" && opciones.comoNotaDeVoz) {
      // Nota de voz: aparece con la onda y el play, no como archivo adjunto.
      resultado = await c.sendPttFromBase64(jid, uri, guardado.nombre, cap)
    } else {
      // Video y documentos: wppconnect deduce el tipo del data URI.
      resultado = await c.sendFileFromBase64(jid, uri, guardado.nombre, cap)
    }
  } catch (e) {
    mediaService.borrar(sesion.tenant_id, guardado.archivo)  // no dejamos basura si falló
    throw new Error("No se pudo enviar el archivo: " + e.message)
  }

  const waId = resultado?.id?._serialized || resultado?.id || null

  const mensaje = await chatService.registrarMensaje(sesion.tenant_id, chatFila.id, {
    waMsgId:   waId,
    direction: "out",
    type:      guardado.tipo === "documento" ? "document" : guardado.tipo,
    body:      cap,
    mediaUrl:  guardado.url,
    mediaMime: guardado.mime,
    mediaName: guardado.nombre,
    status:    "sent",
    author:    autor,
    quotedId:  opciones.quotedId || null
  })

  bus.aTenant(sesion.tenant_id, "message:new", { chatId: chatFila.id, jid, mensaje })
  log.info("wa:" + sesion.session_key, "archivo enviado a", jid, "(" + guardado.tipo + ")")
  return mensaje
}

/** Baja un archivo recibido, lo guarda y actualiza el mensaje. */
async function descargarMediaDeMensaje(sesion, mensajeFila) {
  if (mensajeFila.media_url) return mensajeFila           // ya lo teníamos
  if (!mensajeFila.wa_msg_id) throw new Error("El mensaje no tiene id de WhatsApp")

  const c = cliente(sesion)
  const base64 = await c.downloadMedia(mensajeFila.wa_msg_id)
  if (!base64) throw new Error("WhatsApp no devolvió el archivo")

  const guardado = mediaService.guardarBase64(
    sesion.tenant_id, base64, mensajeFila.media_mime, mensajeFila.media_name || mensajeFila.type
  )
  if (!guardado) throw new Error("No se pudo guardar el archivo")

  return db.one(
    `UPDATE messages SET media_url = $2, media_mime = COALESCE(media_mime, $3), media_name = COALESCE(media_name, $4)
      WHERE id = $1 RETURNING *`,
    [mensajeFila.id, guardado.url, guardado.mime, guardado.nombre]
  )
}

// ============================================================
//  ESTADOS (historias)
// ============================================================
async function publicarEstadoTexto(sesion, { texto, backgroundColor = "#0f5c45", font = 2 }, userId) {
  const c = cliente(sesion)
  await c.sendTextStatus(texto, { backgroundColor, font })

  await db.query(
    `INSERT INTO statuses (tenant_id, session_id, tipo, contenido, opciones, created_by)
     VALUES ($1,$2,'texto',$3,$4,$5)`,
    [sesion.tenant_id, sesion.id, texto, JSON.stringify({ backgroundColor, font }), userId || null]
  )
  log.ok("wa:" + sesion.session_key, "estado de texto publicado")
  return { ok: true }
}

async function publicarEstadoMedia(sesion, archivo, caption = "", userId) {
  const c = cliente(sesion)
  const guardado = mediaService.guardar(sesion.tenant_id, archivo.buffer, archivo.mime, archivo.nombre)
  const uri = dataUri(guardado.mime, archivo.buffer.toString("base64"))

  if (guardado.tipo === "image")      await c.sendImageStatus(uri, { caption })
  else if (guardado.tipo === "video") await c.sendVideoStatus(uri, { caption })
  else {
    mediaService.borrar(sesion.tenant_id, guardado.archivo)
    throw new Error("Los estados solo aceptan imagen o video")
  }

  await db.query(
    `INSERT INTO statuses (tenant_id, session_id, tipo, contenido, media_url, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [sesion.tenant_id, sesion.id, guardado.tipo === "image" ? "imagen" : "video",
     caption, guardado.url, userId || null]
  )
  log.ok("wa:" + sesion.session_key, "estado multimedia publicado")
  return { ok: true, media: guardado.url }
}

// ============================================================
//  ACCIONES SOBRE MENSAJES
// ============================================================
async function responderCitando(sesion, chatFila, texto, quotedWaId, autor) {
  const c = cliente(sesion)
  const r = await c.reply(chatFila.wa_chat_id, texto, quotedWaId)

  const mensaje = await chatService.registrarMensaje(sesion.tenant_id, chatFila.id, {
    waMsgId:   r?.id?._serialized || r?.id || null,
    direction: "out", type: "chat", body: texto,
    status: "sent", author: autor, quotedId: quotedWaId
  })
  bus.aTenant(sesion.tenant_id, "message:new", { chatId: chatFila.id, jid: chatFila.wa_chat_id, mensaje })
  return mensaje
}

async function reaccionar(sesion, waMsgId, emoji) {
  const c = cliente(sesion)
  // `false` quita la reacción; wppconnect lo distingue de la cadena vacía.
  await c.sendReactionToMessage(waMsgId, emoji || false)
  await db.query(
    "UPDATE messages SET reaction = $3 WHERE tenant_id = $1 AND wa_msg_id = $2",
    [sesion.tenant_id, waMsgId, emoji || null]
  )
  return { ok: true }
}

async function reenviar(sesion, chatDestino, waMsgId) {
  const c = cliente(sesion)
  await c.forwardMessage(chatDestino.wa_chat_id, waMsgId)
  return { ok: true }
}

async function destacar(sesion, waMsgId, valor = true) {
  const c = cliente(sesion)
  await c.starMessage(waMsgId, valor)
  await db.query(
    "UPDATE messages SET starred = $3 WHERE tenant_id = $1 AND wa_msg_id = $2",
    [sesion.tenant_id, waMsgId, !!valor]
  )
  return { ok: true }
}

async function eliminarMensaje(sesion, chatFila, waMsgId, soloParaMi = false) {
  const c = cliente(sesion)
  await c.deleteMessage(chatFila.wa_chat_id, waMsgId, soloParaMi)
  await db.query(
    "UPDATE messages SET deleted = TRUE WHERE tenant_id = $1 AND wa_msg_id = $2",
    [sesion.tenant_id, waMsgId]
  )
  bus.aTenant(sesion.tenant_id, "message:deleted", { chatId: chatFila.id, waMsgId })
  return { ok: true }
}

async function editarMensaje(sesion, waMsgId, texto) {
  const c = cliente(sesion)
  await c.editMessage(waMsgId, texto)
  await db.query(
    "UPDATE messages SET body = $3 WHERE tenant_id = $1 AND wa_msg_id = $2",
    [sesion.tenant_id, waMsgId, texto]
  )
  bus.aTenant(sesion.tenant_id, "message:edited", { waMsgId, body: texto })
  return { ok: true }
}

// ============================================================
//  ACCIONES SOBRE EL CHAT (se replican en el WhatsApp real)
// ============================================================
async function archivar(sesion, chatFila, valor = true) {
  const c = cliente(sesion)
  await c.archiveChat(chatFila.wa_chat_id, valor)
  return chatService.actualizarChat(sesion.tenant_id, chatFila.id, { archived: !!valor })
}

async function fijarEnWhatsapp(sesion, chatFila, valor = true) {
  const c = cliente(sesion)
  try { await c.pinChat(chatFila.wa_chat_id, valor, false) }
  catch (e) { log.warn("wa", "pinChat: " + e.message) }   // WhatsApp limita a 3 fijados
  return chatService.actualizarChat(sesion.tenant_id, chatFila.id, { pinned: !!valor })
}

async function silenciar(sesion, chatFila, horas = 8) {
  const c = cliente(sesion)
  await c.sendMute(chatFila.wa_chat_id, horas, "hours")
  await db.query(
    "UPDATE chats SET muted_until = now() + ($2 || ' hours')::interval WHERE id = $1",
    [chatFila.id, horas]
  )
  return { ok: true }
}

async function marcarNoLeidoWa(sesion, chatFila) {
  const c = cliente(sesion)
  await c.markUnseenMessage(chatFila.wa_chat_id)
  await db.query("UPDATE chats SET unread_count = GREATEST(unread_count, 1) WHERE id = $1", [chatFila.id])
  return { ok: true }
}

async function marcarLeidoWa(sesion, chatFila) {
  const c = cliente(sesion)
  await c.sendSeen(chatFila.wa_chat_id)
  await chatService.marcarLeido(sesion.tenant_id, chatFila.id)
  return { ok: true }
}

async function vaciarChat(sesion, chatFila) {
  const c = cliente(sesion)
  await c.clearChat(chatFila.wa_chat_id, true)   // conserva los destacados
  await db.query("DELETE FROM messages WHERE tenant_id = $1 AND chat_id = $2",
    [sesion.tenant_id, chatFila.id])
  return { ok: true }
}

async function eliminarChat(sesion, chatFila) {
  const c = cliente(sesion)
  await c.deleteChat(chatFila.wa_chat_id)
  await db.query("DELETE FROM chats WHERE tenant_id = $1 AND id = $2", [sesion.tenant_id, chatFila.id])
  return { ok: true }
}

async function bloquear(sesion, chatFila, valor = true) {
  const c = cliente(sesion)
  if (valor) await c.blockContact(chatFila.wa_chat_id)
  else       await c.unblockContact(chatFila.wa_chat_id)
  return { ok: true, bloqueado: valor }
}

/** Foto de perfil, última conexión y si está en línea. Todo tolerante a fallos. */
async function infoContacto(sesion, chatFila) {
  const c = cliente(sesion)
  const info = { foto: null, ultimaVez: null, enLinea: null }

  try {
    const pic = await c.getProfilePicFromServer(chatFila.wa_chat_id)
    info.foto = pic?.eurl || pic?.imgFull || pic?.img || null
  } catch (_) { /* privacidad: puede estar oculta */ }

  try {
    const visto = await c.getLastSeen(chatFila.wa_chat_id)
    if (typeof visto === "number" && visto > 0) info.ultimaVez = new Date(visto * 1000).toISOString()
  } catch (_) { /* idem */ }

  try { info.enLinea = await c.getChatIsOnline(chatFila.wa_chat_id) } catch (_) {}

  return info
}

/** "escribiendo…" / "grabando audio…" visible para el contacto. */
async function marcarEstadoEscritura(sesion, chatFila, estado) {
  const c = cliente(sesion)
  try {
    if (estado === "grabando")      await c.startRecording(chatFila.wa_chat_id)
    else if (estado === "detener")  { await c.stopTyping(chatFila.wa_chat_id); await c.stopRecording(chatFila.wa_chat_id) }
    else                            await c.startTyping(chatFila.wa_chat_id)
  } catch (e) { log.debug("wa", "estado escritura: " + e.message) }
  return { ok: true }
}

module.exports = {
  enviarArchivo, descargarMediaDeMensaje,
  publicarEstadoTexto, publicarEstadoMedia,
  responderCitando, reaccionar, reenviar, destacar, eliminarMensaje, editarMensaje,
  archivar, fijarEnWhatsapp, silenciar, marcarNoLeidoWa, marcarLeidoWa,
  vaciarChat, eliminarChat, bloquear, infoContacto, marcarEstadoEscritura
}
