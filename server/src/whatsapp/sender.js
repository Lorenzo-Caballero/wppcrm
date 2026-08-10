// ============================================================
//  Envío de mensajes
//
//  El corazón de esto es enviarTextoForzando(), portado tal cual de
//  fau.js: client.sendText() de wppconnect NO pasa { createChat: true }
//  a wa-js, así que con números que nunca te escribieron el envío falla
//  EN SILENCIO (loguea "OK" y no manda nada). Por eso primero se intenta
//  WPP.chat.sendTextMessage(...,{createChat:true}) dentro de la página y
//  recién si esa ruta no está disponible se cae a sendText().
// ============================================================
const log = require("../utils/logger")
const { sleep } = require("../utils/random")
const { normalizarNegritas } = require("../services/message.service")

async function enviarTextoForzando(client, jid, texto) {
  try {
    const resultado = await client.page.evaluate(
      async ([to, content]) => {
        if (typeof WPP === "undefined" || !WPP?.chat?.sendTextMessage) {
          return { ok: false, motivo: "WPP no disponible" }
        }
        try {
          const r = await WPP.chat.sendTextMessage(to, content, { createChat: true })
          return { ok: true, id: r?.id?._serialized || r?.id || null }
        } catch (err) {
          return { ok: false, motivo: err?.message || String(err) }
        }
      },
      [jid, texto]
    )
    if (resultado?.ok) return { ok: true, id: resultado.id, via: "WPP.chat" }
    log.debug("send", jid, "WPP.chat falló (" + (resultado?.motivo || "?") + "), pruebo sendText")
  } catch (e) {
    log.debug("send", jid, "page.evaluate falló: " + e.message + " — pruebo sendText")
  }

  const r = await client.sendText(jid, texto)
  return { ok: true, id: r?.id?._serialized || r?.id || null, via: "sendText" }
}

/**
 * Simula que alguien está tipeando antes de mandar: el delay es
 * proporcional al largo del texto (28 ms por caracter, entre 1,5 y 5,5 s),
 * igual que sendWithTyping() de fau.js.
 */
async function enviarConTyping(client, jid, texto) {
  const mensaje   = normalizarNegritas(texto)
  const charDelay = Math.min(Math.max(mensaje.length * 28, 1500), 5500)

  try {
    await client.startTyping(jid)
    await sleep(charDelay)
    await client.stopTyping(jid)
  } catch (e) {
    // El chat puede no existir todavía en el store: no es fatal.
    log.debug("typing", jid, e.message || e)
  }

  return enviarTextoForzando(client, jid, mensaje)
}

module.exports = { enviarTextoForzando, enviarConTyping }
