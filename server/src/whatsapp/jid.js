// Resolución de JIDs — portado de resolverJid() / resolverJidNumero() de fau.js.
// WhatsApp devuelve chats con id serializado, @lid, o solo con el nombre
// formateado; hay que probar todas las rutas antes de dar el número por perdido.
const { normalizarNumeroArgentino } = require("../utils/phone")

/**
 * Pregunta a WhatsApp si un número existe y devuelve su JID real.
 * wppconnect v2 renombró getNumberId() a checkNumberStatus(); soportamos las dos
 * para no depender de la versión exacta instalada.
 */
async function consultarNumero(client, numero) {
  if (typeof client.checkNumberStatus === "function") {
    const r = await client.checkNumberStatus(numero + "@c.us")
    if (r?.numberExists === false) return null
    return r?.id?._serialized || (typeof r?.id === "string" ? r.id : null)
  }
  if (typeof client.getNumberId === "function") {
    const r = await client.getNumberId(numero)
    return r?._serialized || (typeof r === "string" ? r : null)
  }
  return null
}

async function resolverJidDeChat(client, chat) {
  const idSer = chat.id?._serialized || (typeof chat.id === "string" ? chat.id : "") || ""
  if (typeof idSer === "string" && idSer.endsWith("@c.us")) {
    return { jid: idSer, metodo: "serialized" }
  }

  const remoteRec = chat.lastReceivedKey?.remote
  if (remoteRec) {
    const s = remoteRec._serialized || remoteRec
    if (typeof s === "string" && s.endsWith("@c.us")) return { jid: s, metodo: "lastReceived" }
  }

  const remoteSent = chat.lastSentKey?.remote
  if (remoteSent) {
    const s = remoteSent._serialized || remoteSent
    if (typeof s === "string" && s.endsWith("@c.us")) return { jid: s, metodo: "lastSent" }
  }

  const formattedName = chat.contact?.formattedName || chat.formattedName || ""
  const norm = normalizarNumeroArgentino(formattedName)
  if (norm) {
    try {
      const id = await consultarNumero(client, norm)
      if (id) return { jid: id, metodo: "consulta" }
    } catch (_) { /* el número puede no estar en WhatsApp */ }
    return { jid: norm + "@c.us", metodo: "manual" }
  }

  if (idSer.endsWith("@lid")) return { jid: idSer, metodo: "lid" }
  return { jid: null, metodo: "sin_jid" }
}

/** Resuelve el JID de un número suelto probando con y sin el 9 argentino. */
async function resolverJidDeNumero(client, numeroRaw) {
  const norm = normalizarNumeroArgentino(numeroRaw)
  if (!norm) return null

  const variantes = new Set([norm])
  if (norm.startsWith("549"))     variantes.add("54" + norm.slice(3))
  else if (norm.startsWith("54")) variantes.add("549" + norm.slice(2))

  for (const num of variantes) {
    try {
      const id = await consultarNumero(client, num)
      if (id) return id
    } catch (_) { /* seguimos con la siguiente variante */ }
  }
  return [...variantes][0] + "@c.us"
}

module.exports = { resolverJidDeChat, resolverJidDeNumero, consultarNumero }
