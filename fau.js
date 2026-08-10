require("dotenv").config()

const wppconnect = require("@wppconnect-team/wppconnect")
const fetch      = require("node-fetch")
const fs         = require("fs")
const path       = require("path")

process.on('uncaughtException',  err    => console.error('Uncaught Exception:', err.stack || err))
process.on('unhandledRejection', reason => console.error('Unhandled Rejection:', reason))

// ============================================================
// CONFIG
// ============================================================
const SESSION      = "faunotattoo"
const API_BASE     = "https://faunotattoo.com/bot.php"

// ⚠️ SEGURIDAD: la key vieja quedó expuesta en texto plano en versiones
// anteriores de este archivo. Revocala en platform.openai.com y definí
// la nueva como variable de entorno, NUNCA hardcodeada en el código:
//   .env         OPENAI_API_KEY=sk-...          (se carga solo con dotenv)
//   PowerShell:  $env:OPENAI_API_KEY = "sk-..."
//   Linux/Mac:   export OPENAI_API_KEY="sk-..."
//   Termux:      export OPENAI_API_KEY="sk-..."   (o ponelo en ~/.bashrc)
const OPENAI_KEY   = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || ""
const OPENAI_MODEL = process.env.OPENAI_MODEL   || "gpt-4o-mini"

if (!OPENAI_KEY) {
  console.error("[CONFIG] Falta OPENAI_API_KEY. Definila en el .env o como variable de entorno antes de arrancar el bot.")
  process.exit(1)
}

// Número que recibe el primer aviso de inicio (cualquier formato, se normaliza solo)
const NUMERO_PRIMER_AVISO = "5492233407440"

// ============================================================
// MODO DE OPERACIÓN
// ============================================================
// false = el bot SOLO difunde el mensaje una vez por persona.
//         Cuando un cliente responde, el mensaje queda registrado en la
//         base pero el bot NO contesta nada ni negocia turnos.
// true  = además de difundir, el bot conversa con quien responda y puede
//         llegar a agendar turnos automáticamente (motor completo, más abajo).
const RESPONDER_AUTOMATICAMENTE = false

// ============================================================
// HORARIO DE DIFUSION (hora argentina)
// ============================================================
const DIFUSION_HORA_INICIO = { h: 7,  m: 0  }
const DIFUSION_HORA_FIN    = { h: 23, m: 30 }

const DIFUSION_DELAY_MIN_MS        =  20_000   // 20 seg
const DIFUSION_DELAY_MAX_MS        = 300_000   //  5 min
const DIFUSION_BLOQUE_DELAY_MIN_MS = 120_000   //  2 min
const DIFUSION_BLOQUE_DELAY_MAX_MS = 300_000   //  5 min

// ============================================================
// MENSAJE VIGENTE — Agenda de agosto abierta, sin precios
// ============================================================
const MENSAJE_DIFUSION_BASE =
`*AGENDA DE AGOSTO ABIERTA* 🗓️

Ya podés reservar tu turno en Fauno Tattoo para este mes.

Si venís pensando hace rato en ese tatuaje, este es el momento de bajarlo a la piel. Contame qué tenés en mente y armamos juntos diseño, tamaño y fecha.

Los días se ocupan por orden de reserva, así que cuanto antes escribas, mejor elegís tu horario.

Escribime y lo coordinamos 🙌`

// ============================================================
// CONSTANTES DEL NEGOCIO (usadas solo si RESPONDER_AUTOMATICAMENTE = true)
// ============================================================
// NOTA: las claves de tipo_servicio se dejan igual que antes ("2x1_lineal",
// "tatuaje_grande", etc.) porque son las que espera la base / bot.php.
// Solo cambian las etiquetas visibles para el cliente.
const PRECIOS_SENA = {
  "2x1_lineal":     15000,
  "tatuaje_grande": 20000,
  "tatuaje_xxl":    20000,
  "consulta":       0
}

const DURACION = {
  "2x1_lineal":     60,
  "tatuaje_grande": 120,
  "tatuaje_xxl":    300,
  "consulta":       60
}

const ESTADO = {
  INICIO:                "inicio",
  RECOPILANDO_INFO:      "recopilando_info",
  ESPERANDO_IMAGEN:      "esperando_imagen",
  VERIFICANDO_AGENDA:    "verificando_agenda",
  ESPERANDO_SENA:        "esperando_sena",
  ESPERANDO_COMPROBANTE: "esperando_comprobante",
  CONFIRMADO:            "confirmado",
  ATENCION_HUMANA:       "atencion_humana"
}

// Botones del menú (se listan como texto plano — los template buttons nativos
// están deprecados server-side en WhatsApp y rompen wppconnect con error msgChunks)
const BOTONES_MENU = [
  { id: "btn_agenda",  text: "🗓️ Reservar turno de agosto" },
  { id: "btn_cotizar", text: "💬 Cotizar mi tattoo"        },
  { id: "btn_fauno",   text: "👤 Hablar con Fauno"         }
]

const MAPA_BOTONES = {
  "btn_agenda":  "Quiero reservar un turno para agosto",
  "btn_cotizar": "Quiero cotizar un tatuaje personalizado",
  "btn_fauno":   "Quiero hablar con Fauno directamente",
  "btn_si":      "Sí, quiero reservar ese turno",
  "btn_no":      "Prefiero elegir otro horario"
}

const botsDesactivados      = new Set()
const turnoPropuesto        = new Map()
const ultimaImagenProcesada = new Map()
const DEBOUNCE_MS           = 4000

// ============================================================
// UTILIDADES
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function sleepRandom(minMs, maxMs) {
  const ms = randomInt(minMs, maxMs)
  console.log("  Esperando " + Math.round(ms / 1000) + "s...")
  return sleep(ms)
}

function extraerTelefono(msg) {
  const fromRaw = (msg.from || "").replace(/@.*$/, "").replace(/\D/g, "")
  if (fromRaw.length >= 10) return fromRaw
  const formatted = (msg.sender?.formattedName || "").replace(/\D/g, "")
  if (formatted.length >= 10) return formatted
  return null
}

function ahoraArgentina() {
  const now   = new Date()
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000
  const arMs  = utcMs - 3 * 3600000
  const d     = new Date(arMs)
  const pad   = n => String(n).padStart(2, "0")
  const DIAS  = ["domingo","lunes","martes","miercoles","jueves","viernes","sabado"]
  const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio",
                 "agosto","septiembre","octubre","noviembre","diciembre"]
  return {
    fecha:        d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()),
    hora:         pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()),
    fechaLegible: DIAS[d.getDay()] + " " + d.getDate() + " de " + MESES[d.getMonth()] + " de " + d.getFullYear(),
    diaSemana:    d.getDay(),
    horaNum:      d.getHours(),
    minutoNum:    d.getMinutes()
  }
}

function dentroDelHorarioDifusion() {
  const { horaNum, minutoNum } = ahoraArgentina()
  const totalMin = horaNum * 60 + minutoNum
  const inicio   = DIFUSION_HORA_INICIO.h * 60 + DIFUSION_HORA_INICIO.m
  const fin      = DIFUSION_HORA_FIN.h   * 60 + DIFUSION_HORA_FIN.m
  return totalMin >= inicio && totalMin < fin
}

// ============================================================
// FIX: el cálculo viejo (msecsHastaManana7am) SIEMPRE sumaba un día
// completo, sin chequear si la apertura de HOY ya había pasado o no.
// Si el bot arrancaba de madrugada (antes de las 7), en vez de esperar
// unas horas hasta las 7 de HOY, esperaba ~28 hs hasta las 7 de MAÑANA.
// Esta versión calcula la PRÓXIMA apertura real: hoy si no llegó todavía,
// o mañana si ya pasó.
// ============================================================
function msecsHastaProximaAperturaDifusion() {
  const now = new Date()
  const apertura = new Date(now)
  apertura.setUTCHours(DIFUSION_HORA_INICIO.h + 3, DIFUSION_HORA_INICIO.m, 0, 0) // AR = UTC-3
  if (apertura.getTime() <= now.getTime()) {
    apertura.setUTCDate(apertura.getUTCDate() + 1)
  }
  return apertura.getTime() - now.getTime()
}

function sumarMinutos(fecha, hora, minutos) {
  const [y, mo, d]  = fecha.split("-").map(Number)
  const [h, mi, s]  = hora.split(":").map(Number)
  const base  = new Date(Date.UTC(y, mo - 1, d, h + 3, mi, s || 0))
  const fin   = new Date(base.getTime() + minutos * 60000)
  const arFin = new Date(fin.getTime() - 3 * 3600000)
  const pad   = n => String(n).padStart(2, "0")
  return pad(arFin.getUTCHours()) + ":" + pad(arFin.getUTCMinutes()) + ":00"
}

// ============================================================
// FIX: antes tenía una fecha "piso" hardcodeada (22/06/2025) que hacía
// que la tabla de días disponibles se rompiera apenas pasara esa fecha.
// Ahora se calcula siempre a partir de HOY, sin fechas fijas.
// ============================================================
function proximosDiasTabla() {
  const DIAS  = ["domingo","lunes","martes","miercoles","jueves","viernes","sabado"]
  const arNow = new Date(new Date().getTime() + new Date().getTimezoneOffset() * 60000 - 3 * 3600000)
  const lineas = []
  for (let i = 1; i <= 7; i++) {
    const d   = new Date(arNow.getTime() + i * 86400000)
    const pad = n => String(n).padStart(2, "0")
    const f   = d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate())
    lineas.push("  " + DIAS[d.getDay()] + " -> " + f)
  }
  return lineas.join("\n")
}

function extraerNombre(pushname) {
  if (!pushname || typeof pushname !== "string") return null
  let limpio = pushname
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u{2600}-\u{27BF}]/gu,   "")
    .replace(/[\u{FE00}-\u{FEFF}]/gu,   "")
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, "")
    .replace(/[\u{1FA00}-\u{1FA9F}]/gu, "")
    .replace(/[^\p{L}\p{N}\s\-]/gu,     "")
    .trim()
  if (!limpio || limpio.length < 2) return null
  if (/^\d+$/.test(limpio)) return null
  const primera = limpio.split(/\s+/)[0]
  if (!primera || primera.length < 2) return null
  return primera.charAt(0).toUpperCase() + primera.slice(1).toLowerCase()
}

function botonesATexto(texto, botones) {
  if (!botones || botones.length === 0) return texto
  const opcs = botones.map(b => "▸ " + b.text).join("\n")
  return texto + "\n\n" + opcs
}

function normalizarNegritas(texto) {
  if (!texto) return texto
  return texto.replace(/\*{2,}/g, "*")
}

function normalizarNumeroArgentino(raw) {
  if (!raw) return null
  const d = String(raw).replace(/\D/g, "")
  if (d.length < 10) return null
  if (d.startsWith("54") && d.length === 13) return d
  if (d.startsWith("54") && d.length === 12) return "549" + d.slice(2)
  if (d.startsWith("54") && d.length === 11) return d
  if (d.length === 10) return "549" + d
  if (d.length === 11) return "54" + d
  return d
}

// ============================================================
// ENVIO — FIX DEL BUG "no envía pero dice OK"
// ============================================================
// wppconnect corre sobre la librería wa-js, que expone internamente
// WPP.chat.sendTextMessage(chatId, texto, opciones). Esa función acepta
// { createChat: true }, que le dice a WhatsApp Web que cree el chat en
// su store interno si no existe (típico con números que nunca te
// escribieron o nunca abriste manualmente). client.sendText() de
// wppconnect-team NO pasa esa opción, y en muchas versiones ni siquiera
// tira excepción cuando falla por este motivo — simplemente no manda
// nada y tu try/catch nunca se entera. Por eso el log decía "OK" pero
// el mensaje jamás llegaba.
// Esta función intenta primero el envío forzado vía WPP.chat, y si esa
// ruta no está disponible cae al client.sendText normal como último recurso.
async function enviarTextoForzando(client, jid, texto) {
  try {
    const resultado = await client.page.evaluate(
      async ([to, content]) => {
        if (typeof WPP === "undefined" || !WPP?.chat?.sendTextMessage) {
          return { ok: false, motivo: "WPP no disponible" }
        }
        try {
          await WPP.chat.sendTextMessage(to, content, { createChat: true })
          return { ok: true }
        } catch (err) {
          return { ok: false, motivo: err?.message || String(err) }
        }
      },
      [jid, texto]
    )
    if (resultado?.ok) return true
    console.log("[enviarForzado]", jid, "WPP.chat no sirvió (" + (resultado?.motivo || "?") + "), pruebo sendText normal")
  } catch (e) {
    console.log("[enviarForzado]", jid, "page.evaluate falló:", e.message, "- pruebo sendText normal")
  }

  await client.sendText(jid, texto)
  return true
}

async function resolverJid(client, chat) {
  const idSer = chat.id?._serialized || ""
  if (typeof idSer === "string" && idSer.endsWith("@c.us")) return { jid: idSer, metodo: "serialized" }

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

  const formattedName = chat.contact?.formattedName || ""
  const norm = normalizarNumeroArgentino(formattedName)
  if (norm) {
    try {
      const r = await client.getNumberId(norm)
      if (r?._serialized) return { jid: r._serialized, metodo: "getNumberId" }
    } catch (_) {}
    return { jid: norm + "@c.us", metodo: "manual" }
  }

  if (idSer.endsWith("@lid")) return { jid: idSer, metodo: "lid" }
  return { jid: null, metodo: "sin_jid" }
}

// Resuelve el JID de un número suelto (no de un objeto chat) — se usa
// para el aviso de arranque, probando variantes con y sin el 9.
async function resolverJidNumero(client, numeroRaw) {
  const norm = normalizarNumeroArgentino(numeroRaw)
  if (!norm) return null
  const variantes = new Set([norm])
  if (norm.startsWith("549")) variantes.add("54" + norm.slice(3))
  else if (norm.startsWith("54")) variantes.add("549" + norm.slice(2))

  for (const num of variantes) {
    try {
      const r  = await client.getNumberId(num)
      const id = r?._serialized || (typeof r === "string" ? r : null)
      if (id) return id
    } catch (_) {}
  }
  return [...variantes][0] + "@c.us"
}

// ============================================================
// ENVIAR MENSAJE CON TYPING SIMULADO
// ============================================================
async function sendWithTyping(client, jid, texto, botones) {
  const mensajeFinal = normalizarNegritas(botonesATexto(texto, botones))

  const charDelay = Math.min(Math.max(mensajeFinal.length * 28, 1500), 5500)
  try {
    await client.startTyping(jid)
    await sleep(charDelay)
    await client.stopTyping(jid)
  } catch (e) {
    // Chat aún no existe en el store: no es fatal, solo no se simula tipeo
    console.warn("[typing]", jid, e.message || e)
  }

  try {
    await enviarTextoForzando(client, jid, mensajeFinal)
    return "ok"
  } catch (e) {
    console.error("[sendText] Error:", e.message)
    return "error"
  }
}

// ============================================================
// GENERAR MENSAJE DE DIFUSIÓN ÚNICO CON IA — Agenda de agosto, sin precios
// ============================================================
function generarMensajeDifusionFallback(nombre) {
  const saludos = ["Hola!", "Buenas!", "Qué tal!", "Buen día!", "Cómo andás!"]
  const sal = nombre
    ? saludos[randomInt(0, saludos.length - 1)] + " " + nombre + "! 👋"
    : saludos[randomInt(0, saludos.length - 1)]
  return sal + "\n\n" + MENSAJE_DIFUSION_BASE
}

async function generarMensajeDifusion(nombre) {
  if (!OPENAI_KEY) return generarMensajeDifusionFallback(nombre)

  const { fechaLegible } = ahoraArgentina()

  const saludoCtx = nombre
    ? "El destinatario se llama " + nombre + ". Saludalo por su nombre al inicio de forma natural."
    : "No tenés el nombre. Usá un saludo genérico argentino (Hola!, Buenas!, Qué tal!, Buen día!, Hola gente!, Cómo andás!)."

  const prompt =
`Sos el asistente de *Fauno Tattoo*, estudio de tatuajes profesional en Mar del Plata, Argentina.
Reformulá el siguiente mensaje de difusión de WhatsApp, cambiando el orden de las frases y
algunas palabras para que no quede idéntico cada vez, pero manteniendo EXACTAMENTE la misma
información. Hoy es ${fechaLegible}.

${saludoCtx}

Información que NO podés cambiar:
- La agenda del mes de agosto ya está abierta para reservar turnos.
- Los turnos se asignan por orden de reserva, así que conviene escribir cuanto antes.
- El cliente tiene que escribir para coordinar diseño, tamaño y fecha.

INSTRUCCIONES:
- IMPORTANTE: NUNCA menciones ningún precio ni monto en pesos, bajo ningún concepto.
- No inventes promociones, descuentos, fechas puntuales, cupos numerados ni sucursales.
- No agregues preguntas ni le pidas ningún dato al cliente.
- Tono argentino, cálido y profesional, con llamado a la acción final para reservar turno.
- Usá un solo asterisco para negrita (*texto*), nunca doble ni triple.
- Máximo 4-5 líneas.
- No menciones opciones de botones en el texto (van listadas aparte).
- No menciones que sos un bot ni un sistema automático.
- No uses listas ni viñetas.

Mensaje original:
${MENSAJE_DIFUSION_BASE}

Respondé ÚNICAMENTE con el mensaje final reformulado, sin comentarios, sin explicaciones, sin comillas.`

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_KEY },
      body: JSON.stringify({
        model: OPENAI_MODEL, temperature: 1.0, max_tokens: 300,
        messages: [
          { role: "system", content: "Sos un redactor experto en comunicación informal argentina para WhatsApp. Nunca mencionás precios. Cada mensaje es único." },
          { role: "user",   content: prompt }
        ]
      })
    })
    if (!res.ok) { console.error("[difusion IA] error", res.status); return generarMensajeDifusionFallback(nombre) }
    const data  = await res.json()
    let texto   = (data.choices?.[0]?.message?.content || "").trim()
    if (!texto || texto.length < 25) return generarMensajeDifusionFallback(nombre)

    // Chequeo defensivo: si a pesar de la instrucción la IA metió un precio
    // (patrón "$" seguido de números), descartamos y usamos el fallback fijo.
    if (/\$\s?\d/.test(texto)) {
      console.warn("[difusion IA] detecté un precio en la respuesta, uso fallback")
      return generarMensajeDifusionFallback(nombre)
    }

    console.log("[DIFUSION MSG]", texto.substring(0, 90) + "...")
    return normalizarNegritas(texto)
  } catch (e) {
    console.error("[difusion IA] excepción:", e.message)
    return generarMensajeDifusionFallback(nombre)
  }
}

// ============================================================
// PERSISTENCIA: quién ya recibió la difusión (para nunca duplicar,
// ni siquiera si el bot se reinicia a mitad de la corrida)
// ============================================================
// OJO: archivo NUEVO para esta campaña. Si usás el de la promo anterior
// (difusion-enviados.json), todos los que ya recibieron aquel mensaje
// quedarían salteados y nunca se enterarían de la agenda de agosto.
const ARCHIVO_ENVIADOS = path.join(__dirname, "difusion-agosto.json")

function cargarEnviadosPrevios() {
  try {
    if (!fs.existsSync(ARCHIVO_ENVIADOS)) return new Set()
    const data = JSON.parse(fs.readFileSync(ARCHIVO_ENVIADOS, "utf8"))
    return new Set(Array.isArray(data) ? data : [])
  } catch (e) {
    console.error("[ENVIADOS] error leyendo archivo, arranco de cero:", e.message)
    return new Set()
  }
}

function guardarEnviados(set) {
  try {
    fs.writeFileSync(ARCHIVO_ENVIADOS, JSON.stringify([...set]), "utf8")
  } catch (e) {
    console.error("[ENVIADOS] error guardando archivo:", e.message)
  }
}

// ============================================================
// DIFUSION MASIVA
// ============================================================
function dividirEnBloques(arr, tam) {
  const bloques = []
  for (let i = 0; i < arr.length; i += tam) bloques.push(arr.slice(i, i + tam))
  return bloques
}

async function enviarDifusionAhora(client) {
  console.log("[DIFUSION] Obteniendo chats...")
  await sleep(10000)

  let chats = []
  for (let intento = 1; intento <= 5; intento++) {
    try {
      chats = typeof client.getListChats === "function"
        ? await client.getListChats()
        : await client.getAllChats()
      console.log("[DIFUSION] intento", intento, "→", chats.length, "chats")
      if (chats.length > 0) break
    } catch (e) {
      console.error("[DIFUSION] error obteniendo chats:", e.message)
    }
    await sleep(5000)
  }

  if (!chats.length) { console.error("[DIFUSION] sin chats, abortando"); return }

  const individuales = chats.filter(c => !c.isGroup && c.isUser !== false && c.archive !== true)
  const archivados   = chats.filter(c => !c.isGroup && c.isUser !== false && c.archive === true)
  console.log("[DIFUSION] individuales:", individuales.length, "| archivados omitidos:", archivados.length)

  const enviadosPrevios = cargarEnviadosPrevios()
  console.log("[DIFUSION] ya recibieron el mensaje en corridas anteriores:", enviadosPrevios.size)

  const bloques = dividirEnBloques(individuales, 25)
  let enviados = 0, omitidos = 0, sinJid = 0, yaTenian = 0
  const errores = []
  const yaEnviadosEnEstaCorrida = new Set()

  for (let i = 0; i < bloques.length; i++) {
    console.log("[DIFUSION] === Bloque", (i+1) + "/" + bloques.length, "===")

    for (const chat of bloques[i]) {
      if (!dentroDelHorarioDifusion()) {
        const espera = msecsHastaProximaAperturaDifusion()
        console.log("[DIFUSION] fuera de horario. Pausa", Math.round(espera/60000), "min")
        await sleep(espera)
        console.log("[DIFUSION] reanudando...")
      }

      try {
        const { jid, metodo } = await resolverJid(client, chat)
        if (!jid) { sinJid++; console.log("[DIFUSION] sin JID:", chat.contact?.formattedName || "?"); continue }

        // ── Un solo mensaje por persona, para siempre ──
        if (enviadosPrevios.has(jid) || yaEnviadosEnEstaCorrida.has(jid)) {
          yaTenian++
          continue
        }
        yaEnviadosEnEstaCorrida.add(jid)

        const pushname   = chat.contact?.pushname || ""
        const nombre     = extraerNombre(pushname)
        const textoBase  = await generarMensajeDifusion(nombre)
        const texto      = normalizarNegritas(botonesATexto(textoBase, BOTONES_MENU))

        const charDelay = Math.min(Math.max(texto.length * 28, 1500), 5500)
        try { await client.startTyping(jid); await sleep(charDelay); await client.stopTyping(jid) }
        catch (e) { console.warn("[typing difusion]", jid, e.message) }

        let enviado = false
        try {
          await enviarTextoForzando(client, jid, texto)
          enviado = true
        } catch (e2) {
          console.error("[DIFUSION] error enviando:", e2.message)
        }

        if (enviado) {
          enviados++
          enviadosPrevios.add(jid)
          guardarEnviados(enviadosPrevios) // persistimos enseguida, por si el proceso se corta
          console.log("[DIFUSION] OK (" + enviados + ")", (nombre || jid), "[" + metodo + "]")
        } else {
          omitidos++
        }

        await sleepRandom(DIFUSION_DELAY_MIN_MS, DIFUSION_DELAY_MAX_MS)

      } catch (e) {
        omitidos++
        const quien = chat.id?._serialized || "?"
        console.error("[DIFUSION] error enviando a", quien + ":", e.message)
        errores.push({ jid: quien, error: e.message })
        await sleep(5000)
      }
    }

    if (i < bloques.length - 1) {
      console.log("[DIFUSION] pausa entre bloques...")
      await sleepRandom(DIFUSION_BLOQUE_DELAY_MIN_MS, DIFUSION_BLOQUE_DELAY_MAX_MS)
    }
  }

  console.log("=== DIFUSION FINALIZADA ===")
  console.log("Enviados:", enviados, "| Ya lo tenían:", yaTenian, "| Omitidos:", omitidos, "| Sin JID:", sinJid)
  if (errores.length) errores.forEach(e => console.log(" ", e.jid, "→", e.error))
}

async function iniciarDifusion(client) {
  if (!dentroDelHorarioDifusion()) {
    const espera = msecsHastaProximaAperturaDifusion()
    console.log("[DIFUSION] fuera de horario. Inicia en", Math.round(espera/60000), "min (07:00 AR)")
    await sleep(espera)
    console.log("[DIFUSION] iniciando (07:00 AR)...")
  } else {
    console.log("[DIFUSION] dentro del horario. Iniciando ahora...")
  }
  await enviarDifusionAhora(client)
}

// ============================================================
// REFERENCIAS DE COMPROBANTES (solo se usa si RESPONDER_AUTOMATICAMENTE = true)
// ============================================================
function cargarComprobantesReferencia() {
  const dir  = path.join(__dirname, "referenciaComprobante")
  const imgs = []
  if (!fs.existsSync(dir)) return imgs
  for (const archivo of fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png)$/i.test(f))) {
    try {
      const buf  = fs.readFileSync(path.join(dir, archivo))
      const mime = archivo.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg"
      imgs.push({ nombre: archivo, b64: buf.toString("base64"), mime })
      console.log("[comprobantes] cargada:", archivo)
    } catch (e) { console.error("[comprobantes] error cargando:", archivo, e.message) }
  }
  return imgs
}
const COMPROBANTES_REFERENCIA = RESPONDER_AUTOMATICAMENTE ? cargarComprobantesReferencia() : []

// ============================================================
// CLASIFICAR / VERIFICAR IMÁGENES CON GPT-4o (motor conversacional)
// ============================================================
async function clasificarImagen(imagenB64, mimeType) {
  const contenido = []
  if (COMPROBANTES_REFERENCIA.length > 0) {
    contenido.push({ type: "text", text: "Referencias de comprobantes válidos:" })
    for (const r of COMPROBANTES_REFERENCIA)
      contenido.push({ type: "image_url", image_url: { url: "data:" + r.mime + ";base64," + r.b64, detail: "low" } })
  }
  contenido.push({
    type: "text",
    text: "Analizá esta imagen. Respondé SOLO con JSON sin markdown:\n{\"tipo\":\"comprobante|tatuaje|otro\",\"razon\":\"breve\"}"
  })
  contenido.push({ type: "image_url", image_url: { url: "data:" + mimeType + ";base64," + imagenB64, detail: "high" } })

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_KEY },
    body: JSON.stringify({
      model: "gpt-4o", temperature: 0, max_tokens: 100,
      messages: [
        { role: "system", content: "Clasificador de imágenes para estudio de tatuajes. Solo JSON." },
        { role: "user",   content: contenido }
      ]
    })
  })
  if (!res.ok) throw new Error("Vision clasificar " + res.status)
  const data   = await res.json()
  const limpio = (data.choices?.[0]?.message?.content || "{}").replace(/```json|```/g, "").trim()
  try { return JSON.parse(limpio).tipo || "otro" } catch { return "otro" }
}

async function verificarComprobante(imagenB64, mimeType, montoEsperado) {
  const contenido = []
  if (COMPROBANTES_REFERENCIA.length > 0) {
    contenido.push({ type: "text", text: "Referencias de comprobantes válidos:" })
    for (const r of COMPROBANTES_REFERENCIA)
      contenido.push({ type: "image_url", image_url: { url: "data:" + r.mime + ";base64," + r.b64, detail: "low" } })
  }
  contenido.push({
    type: "text",
    text: "Verificá este comprobante. Criterios:\n1. ¿Es transferencia bancaria?\n2. ¿Monto = $" + montoEsperado + "?\n3. ¿Destinatario = alias faunotattoo / CBU 0140415303610057041111 / Jose Lorenzo Argentino Fernandez Caballero?\n\nJSON sin markdown:\n{\"valido\":true,\"motivo\":\"ok\",\"monto_detectado\":\"...\",\"destinatario_detectado\":\"...\"}"
  })
  contenido.push({ type: "image_url", image_url: { url: "data:" + mimeType + ";base64," + imagenB64, detail: "high" } })

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_KEY },
    body: JSON.stringify({
      model: "gpt-4o", temperature: 0, max_tokens: 200,
      messages: [
        { role: "system", content: "Verificador de comprobantes bancarios argentinos. Solo JSON." },
        { role: "user",   content: contenido }
      ]
    })
  })
  if (!res.ok) throw new Error("Vision verificar " + res.status)
  const data   = await res.json()
  const limpio = (data.choices?.[0]?.message?.content || "{}").replace(/```json|```/g, "").trim()
  try { return JSON.parse(limpio) } catch { return { valido: false, motivo: "imagen_ilegible" } }
}

// ============================================================
// API PHP
// ============================================================
async function obtenerSesion(telefono) {
  try {
    const res = await fetch(API_BASE + "?recurso=bot&telefono=" + telefono)
    if (!res.ok) return { mensajes: [], cliente: null }
    return await res.json()
  } catch (e) { console.error("[API] obtenerSesion:", e.message); return { mensajes: [], cliente: null } }
}

async function guardarMensaje(telefono, rol, mensaje) {
  try {
    await fetch(API_BASE + "?recurso=bot", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telefono, rol, mensaje })
    })
  } catch (e) { console.error("[API] guardarMensaje:", e.message) }
}

async function actualizarCliente(telefono, datos) {
  try {
    await fetch(API_BASE + "?recurso=bot", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ telefono }, datos))
    })
  } catch (e) { console.error("[API] actualizarCliente:", e.message) }
}

async function consultarDisponibilidad(fecha, horaInicio, tipoServicio) {
  try {
    const duracion = DURACION[tipoServicio] || 60
    const horaFin  = sumarMinutos(fecha, horaInicio, duracion)
    const url = API_BASE
      + "?recurso=disponibilidad"
      + "&fecha="       + fecha
      + "&hora_inicio=" + encodeURIComponent(horaInicio)
      + "&hora_fin="    + encodeURIComponent(horaFin)
      + "&duracion="    + duracion
    const res = await fetch(url)
    if (!res.ok) return { disponible: false }
    return await res.json()
  } catch (e) { console.error("[API] consultarDisponibilidad:", e.message); return { disponible: false } }
}

async function crearTurno(telefono, datos) {
  try {
    const duracion   = DURACION[datos.tipo_servicio] || 60
    const monto_sena = PRECIOS_SENA[datos.tipo_servicio] ?? 20000
    const payload    = {
      telefono,
      nombre_cliente: datos.nombre_cliente || null,
      fecha_turno:    datos.fecha_turno,
      hora_turno:     datos.hora_turno,
      tipo_servicio:  datos.tipo_servicio,
      descripcion:    datos.descripcion || null,
      notas:          datos.notas       || null,
      monto_sena,
      duracion
    }
    console.log("[crearTurno]", JSON.stringify(payload))
    const res  = await fetch(API_BASE + "?recurso=turno", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
    const json = await res.json()
    console.log("[crearTurno resp]", JSON.stringify(json))
    return json
  } catch (e) { console.error("[API] crearTurno:", e.message); return { error: e.message } }
}

async function obtenerTurnoPendiente(telefono) {
  try {
    const res = await fetch(API_BASE + "?recurso=turno&telefono=" + telefono + "&estado=pendiente")
    if (!res.ok) return null
    const data = await res.json()
    return data.turno || null
  } catch { return null }
}

async function confirmarSena(turnoId) {
  try {
    await fetch(API_BASE + "?recurso=turno&id=" + turnoId, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estado: "confirmado", sena_pagada: 1 })
    })
  } catch (e) { console.error("[API] confirmarSena:", e.message) }
}

// ============================================================
// SYSTEM PROMPT (motor conversacional — solo si RESPONDER_AUTOMATICAMENTE = true)
// ============================================================
function buildSystemPrompt(estadoCliente, infoRecopilada, turnoEnEspera) {
  const { hora, fechaLegible } = ahoraArgentina()

  const contextoEstado = estadoCliente
    ? "\nEstado actual del cliente: " + estadoCliente : ""

  const infoKeys = infoRecopilada
    ? Object.keys(infoRecopilada).filter(k => infoRecopilada[k]) : []
  const contextoInfo = infoKeys.length > 0
    ? "\nInformación ya recopilada: " + JSON.stringify(infoRecopilada) : ""

  const contextoTurno = turnoEnEspera
    ? "\n\nTURNO YA VERIFICADO — ESPERANDO CONFIRMACIÓN DEL CLIENTE:\n" +
      "Fecha:    " + turnoEnEspera.fecha_turno + "\n" +
      "Hora:     " + turnoEnEspera.hora_turno  + "\n" +
      "Servicio: " + turnoEnEspera.tipo_servicio + "\n" +
      "Descripción: " + (turnoEnEspera.descripcion || "-") + "\n\n" +
      "Si el cliente confirma (sí / dale / perfecto / confirmar / btn_si), emitir INMEDIATAMENTE:\n" +
      'AGENDAR_TURNO: {"fecha_turno":"' + turnoEnEspera.fecha_turno +
      '","hora_turno":"' + turnoEnEspera.hora_turno +
      '","tipo_servicio":"' + turnoEnEspera.tipo_servicio +
      '","descripcion":"' + (turnoEnEspera.descripcion || "") + '"}\n' +
      "SIN preguntas adicionales. SIN verificar disponibilidad de nuevo."
    : ""

  return (
    "Sos el asistente virtual de *Fauno Tattoo*, estudio de tatuajes profesional en Mar del Plata, Argentina.\n\n" +
    "FECHA Y HORA ACTUAL EN ARGENTINA: " + fechaLegible + ", " + hora + "\n\n" +
    "CONTEXTO: la agenda del mes está abierta. El objetivo es que el cliente reserve su turno.\n\n" +
    "Próximos 7 días disponibles a partir de mañana (usá estas fechas exactas, NUNCA inventés otras):\n" +
    proximosDiasTabla() + "\n" +
    contextoEstado + contextoInfo + contextoTurno + "\n\n" +
    "FLUJO DE ATENCIÓN — SEGUILO EN ORDEN ESTRICTO\n\n" +
    "PASO 1 — IDENTIFICAR SERVICIO\n" +
    "  El cliente puede haber llegado tocando un botón (btn_agenda, btn_cotizar, btn_fauno).\n" +
    "  Detectá el contexto y actuá en consecuencia.\n" +
    "  a) Tatuaje lineal o chico (hasta 10 cm) → tipo_servicio \"2x1_lineal\". Seña $15.000.\n" +
    "  b) Tatuaje personalizado / realismo → tipo_servicio \"tatuaje_grande\". Precio a convenir. Seña $20.000.\n" +
    "  c) Sesión larga (20 cm o más) → tipo_servicio \"tatuaje_xxl\". 5 horas. Seña $20.000.\n" +
    "  d) Consulta general → tipo_servicio \"consulta\". Sin costo.\n" +
    "  Nunca des un precio total del tatuaje: eso lo define Fauno según el diseño.\n" +
    "  Solo mencionás el monto de la seña cuando el cliente ya va a agendar.\n\n" +
    "PASO 2 — RECOPILAR INFORMACIÓN (no avancés hasta tener todo)\n" +
    "  NO le pidas el nombre al cliente: ya lo tenés (o lo conseguís) desde sus datos de WhatsApp.\n" +
    "  Si no aparece en 'Información ya recopilada', simplemente no lo menciones, no es obligatorio.\n" +
    "  1. Descripción del diseño y zona del cuerpo\n" +
    "  2. Medidas aproximadas en cm\n" +
    '  3. Imagen de referencia — pedila con este texto exacto: "Podés mandarme fotos de referencia del diseño por este mismo chat 📸"\n' +
    "  NO preguntes fecha/horario hasta tener descripción, zona e imagen.\n\n" +
    "PASO 3 — CONFIRMAR REFERENCIA VISUAL\n" +
    "  Al recibir imagen: confirmá brevemente que la recibiste y describí el estilo.\n" +
    "  Luego preguntá fecha y horario preferido.\n\n" +
    "PASO 4 — VERIFICAR DISPONIBILIDAD\n" +
    "  Emitir CONSULTAR_DISPONIBILIDAD cuando el cliente proponga un horario.\n" +
    "  Si está ocupado: sugerí alternativa cercana.\n" +
    "  Si está libre: 'Tengo disponible el [día] a las [hora] hs. ¿Lo reservamos?' y esperá confirmación.\n\n" +
    "PASO 5 — AGENDAR\n" +
    "  Cuando el cliente confirme → emitir AGENDAR_TURNO (directiva interna, nunca visible).\n\n" +
    "PASO 6 — COMPROBANTE\n" +
    "  Solo pedí el comprobante si el cliente dice que ya pagó.\n\n" +
    "ATENCIÓN HUMANA\n" +
    "  Si pide hablar con Fauno/tatuador/persona real o toca btn_fauno:\n" +
    '  Respondé: "Perfecto, te paso con Fauno. Ya te contacta en breve 🙌"\n' +
    "  Emitir: ATENCION_HUMANA: true\n\n" +
    "DIRECTIVAS INTERNAS — NUNCA mostrar al usuario\n" +
    'DATOS_CLIENTE: {"promo_interes":"2x1_lineal|tatuaje_grande|tatuaje_xxl|consulta_general","dia_preferido":"YYYY-MM-DD","estado_flujo":"recopilando_info|esperando_imagen|verificando_agenda|esperando_sena|esperando_comprobante"}\n' +
    'CONSULTAR_DISPONIBILIDAD: {"fecha_turno":"YYYY-MM-DD","hora_turno":"HH:MM:00","tipo_servicio":"2x1_lineal|tatuaje_grande|tatuaje_xxl|consulta"}\n' +
    'AGENDAR_TURNO: {"fecha_turno":"YYYY-MM-DD","hora_turno":"HH:MM:00","tipo_servicio":"2x1_lineal|tatuaje_grande|tatuaje_xxl|consulta","descripcion":"resumen del diseño y zona"}\n' +
    "ATENCION_HUMANA: true\n\n" +
    "REGLAS ESTRICTAS:\n" +
    "- Nunca mostrés las directivas al usuario.\n" +
    "- Nunca repitas el mismo mensaje en la conversación.\n" +
    "- Nunca inventés fechas — usá solo las de la tabla.\n" +
    "- Nunca inventés promociones ni descuentos que no estén acá.\n" +
    "- No respondas temas ajenos al estudio.\n" +
    "- Nunca le preguntes el nombre al cliente.\n" +
    "- Tono argentino cálido y profesional. Emojis con moderación."
  ).trim()
}

async function consultarOpenAI(historial, mensajeUsuario, estadoCliente, infoRecopilada, turnoEnEspera, contextoExtra) {
  let systemContent = buildSystemPrompt(estadoCliente, infoRecopilada, turnoEnEspera)
  if (contextoExtra) systemContent += "\n\n" + contextoExtra

  const messages = [
    { role: "system", content: systemContent },
    ...historial,
    { role: "user",   content: mensajeUsuario }
  ]

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_KEY },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature: 0.35, max_tokens: 700 })
  })
  if (!res.ok) throw new Error("OpenAI " + res.status + ": " + await res.text())
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ""
}

function extraerDirectiva(texto, prefijo) {
  const regex = new RegExp(prefijo + ":\\s*(\\{[\\s\\S]*?\\})(?:\\n|$)")
  const match = texto.match(regex)
  if (!match) return null
  try { return JSON.parse(match[1]) }
  catch (e) { console.error("[directiva " + prefijo + "] JSON inválido:", match[1]); return null }
}

function extraerDirectivaBoolean(texto, prefijo) {
  const regex = new RegExp(prefijo + ":\\s*(true|false)", "i")
  const match = texto.match(regex)
  return match ? match[1].toLowerCase() === "true" : null
}

function limpiarRespuesta(texto) {
  return texto
    .replace(/DATOS_CLIENTE:\s*\{[\s\S]*?\}(?:\n|$)/g,            "")
    .replace(/CONSULTAR_DISPONIBILIDAD:\s*\{[\s\S]*?\}(?:\n|$)/g,  "")
    .replace(/AGENDAR_TURNO:\s*\{[\s\S]*?\}(?:\n|$)/g,             "")
    .replace(/ATENCION_HUMANA:\s*(true|false)(?:\n|$)/gi,          "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function mensajeSena(datosTurno) {
  const LABELS = {
    "2x1_lineal":     "Tatuaje lineal / chico",
    "tatuaje_grande": "Tatuaje personalizado",
    "tatuaje_xxl":    "Sesión larga 20 cm+",
    "consulta":       "Consulta"
  }
  const monto = PRECIOS_SENA[datosTurno.tipo_servicio] ?? 20000
  const hora  = datosTurno.hora_turno.substring(0, 5)

  return "✅ *Turno reservado*\n\n" +
    "📅 Fecha: *" + datosTurno.fecha_turno + "*\n" +
    "🕐 Hora: *" + hora + " hs*\n" +
    "🖊️ Servicio: " + (LABELS[datosTurno.tipo_servicio] || datosTurno.tipo_servicio) + "\n\n" +
    "*Seña para confirmar el turno: $" + monto.toLocaleString("es-AR") + "*\n\n" +
    "Datos para la transferencia:\n" +
    "  • Alias: *faunotattoo*\n" +
    "  • A nombre de: *Jose Lorenzo Argentino Fernandez Caballero*\n" +
    "  • CBU: *0140415303610057041111*\n\n" +
    "Cualquier duda escribime sin problema. ¡Muchas gracias! 🙌\n" +
    "Una vez que transferiste, mandame el comprobante como imagen por acá."
}

async function descargarImagen(client, msg) {
  let imagenB64 = null
  let mimeType  = "image/jpeg"
  try {
    if (msg.body && msg.body.startsWith("data:")) {
      const [meta, data] = msg.body.split(",")
      mimeType  = meta.split(":")[1].split(";")[0]
      imagenB64 = data
    } else if (msg.mediaData) {
      imagenB64 = Buffer.isBuffer(msg.mediaData) ? msg.mediaData.toString("base64") : msg.mediaData
    } else {
      const buffer = await client.downloadMedia(msg)
      imagenB64    = buffer.toString("base64")
    }
  } catch (e) { console.error("[imagen] error descargando:", e.message) }
  return { imagenB64, mimeType }
}

async function procesarImagen(client, msg, telefono) {
  const ahora     = Date.now()
  const ultimaVez = ultimaImagenProcesada.get(telefono) || 0
  if (ahora - ultimaVez < DEBOUNCE_MS) { console.log("[img] debounce", telefono); return }
  ultimaImagenProcesada.set(telefono, ahora)

  const { imagenB64, mimeType } = await descargarImagen(client, msg)
  if (!imagenB64) {
    await sendWithTyping(client, msg.from, "No pude procesar la imagen. Por favor enviala de nuevo.")
    return
  }

  let tipoImagen = "otro"
  try { tipoImagen = await clasificarImagen(imagenB64, mimeType) }
  catch (e) { console.error("[img] clasificar error:", e.message) }
  console.log("[img]", telefono, "tipo:", tipoImagen)

  if (tipoImagen === "comprobante") {
    const sesion  = await obtenerSesion(telefono)
    const estado  = sesion.cliente?.estado_flujo || ESTADO.INICIO

    if (estado !== ESTADO.ESPERANDO_COMPROBANTE) {
      const aviso = "Recibí un comprobante, pero no tenés un turno pendiente de confirmación. Si querés sacar un turno, contame qué servicio te interesa."
      await sendWithTyping(client, msg.from, aviso, BOTONES_MENU)
      await guardarMensaje(telefono, "assistant", aviso)
      return
    }

    await sendWithTyping(client, msg.from, "Recibí el comprobante, lo estoy verificando... ⏳")

    let resultado
    try {
      const turno = await obtenerTurnoPendiente(telefono)
      const monto = turno ? (PRECIOS_SENA[turno.tipo_servicio] ?? 20000) : 20000
      resultado   = await verificarComprobante(imagenB64, mimeType, monto)
    } catch (e) {
      console.error("[img] verificar error:", e.message)
      await sendWithTyping(client, msg.from, "Hubo un error al verificar. Podés reenviar el comprobante o escribirnos directamente.")
      return
    }

    if (resultado.valido || resultado.motivo === "sin_referencias") {
      const turno = await obtenerTurnoPendiente(telefono)
      if (turno) {
        await confirmarSena(turno.id)
        await actualizarCliente(telefono, { estado: "confirmado", sena_enviada: 1, estado_flujo: ESTADO.CONFIRMADO })
        const respuesta = "✅ *Turno confirmado!*\n\nFecha: " + turno.fecha_turno + "\nHora: " + turno.hora_turno.substring(0, 5) + " hs\nServicio: " + turno.tipo_servicio + "\n\nNos vemos ese día. Si necesitás reprogramar o cancelar, avisanos con 48 hs de anticipación. 🙏"
        await sendWithTyping(client, msg.from, respuesta)
        await guardarMensaje(telefono, "assistant", respuesta)
      } else {
        const respuesta = "Comprobante verificado ✅. No encontramos un turno pendiente para tu número. Escribinos y lo revisamos."
        await sendWithTyping(client, msg.from, respuesta, BOTONES_MENU)
        await guardarMensaje(telefono, "assistant", respuesta)
      }
    } else {
      const MOTIVOS = {
        "no_es_comprobante":       "la imagen no parece ser un comprobante de transferencia",
        "monto_incorrecto":        "el monto detectado (" + (resultado.monto_detectado || "no legible") + ") no coincide con lo acordado",
        "destinatario_incorrecto": "el destinatario (" + (resultado.destinatario_detectado || "no legible") + ") no coincide con el alias *faunotattoo*",
        "imagen_ilegible":         "la imagen no es legible. Por favor enviá una captura más clara"
      }
      const detalle   = MOTIVOS[resultado.motivo] || "no pudimos verificarlo"
      const respuesta = "No pudimos validar el comprobante: " + detalle + ".\n\nAsegurate de transferir al alias *faunotattoo* y reenviá el comprobante."
      await sendWithTyping(client, msg.from, respuesta)
      await guardarMensaje(telefono, "assistant", respuesta)
    }
    return
  }

  const sesion    = await obtenerSesion(telefono)
  const cliente   = sesion.cliente || {}
  const estado    = cliente.estado_flujo || ESTADO.INICIO
  const historial = (sesion.mensajes || []).map(m => ({ role: m.rol, content: m.mensaje }))
  const infoActual = {
    nombre:        cliente.nombre        || null,
    promo_interes: cliente.promo_interes || null,
    dia_preferido: cliente.dia_preferido || null
  }
  const turnoEnEspera = turnoPropuesto.get(telefono) || null

  const ctx = tipoImagen === "tatuaje"
    ? "[El cliente envió una imagen de referencia del diseño/tatuaje]"
    : "[El cliente envió una imagen (no es comprobante ni referencia de tatuaje)]"

  await guardarMensaje(telefono, "user", ctx)
  const respuesta    = await consultarOpenAI(historial, ctx, estado, infoActual, turnoEnEspera)
  const textoFinal   = limpiarRespuesta(respuesta)
  const datosCliente = extraerDirectiva(respuesta, "DATOS_CLIENTE")
  if (datosCliente) await actualizarCliente(telefono, datosCliente)

  await guardarMensaje(telefono, "assistant", textoFinal)
  await sendWithTyping(client, msg.from, textoFinal)
}

async function procesarMensajeTexto(client, msg, telefono, textoUsuario) {
  const sesion       = await obtenerSesion(telefono)
  const historial    = (sesion.mensajes || []).map(m => ({ role: m.rol, content: m.mensaje }))
  const cliente      = sesion.cliente || {}
  const estadoActual = cliente.estado_flujo || ESTADO.INICIO
  const infoActual   = {
    nombre:        cliente.nombre        || null,
    promo_interes: cliente.promo_interes || null,
    dia_preferido: cliente.dia_preferido || null
  }
  const turnoEnEspera = turnoPropuesto.get(telefono) || null

  await guardarMensaje(telefono, "user", textoUsuario)

  let respuesta = await consultarOpenAI(historial, textoUsuario, estadoActual, infoActual, turnoEnEspera)
  console.log("[IA 1]", respuesta.substring(0, 300))

  const consultaDisp = extraerDirectiva(respuesta, "CONSULTAR_DISPONIBILIDAD")
  if (consultaDisp) {
    const disp = await consultarDisponibilidad(consultaDisp.fecha_turno, consultaDisp.hora_turno, consultaDisp.tipo_servicio)
    console.log("[disp]", consultaDisp.fecha_turno, consultaDisp.hora_turno, disp.disponible ? "LIBRE" : "OCUPADO")

    if (disp.disponible) {
      turnoPropuesto.set(telefono, {
        fecha_turno:   consultaDisp.fecha_turno,
        hora_turno:    consultaDisp.hora_turno,
        tipo_servicio: consultaDisp.tipo_servicio,
        descripcion:   consultaDisp.descripcion || ""
      })
    } else {
      turnoPropuesto.delete(telefono)
    }

    const ctxDisp = disp.disponible
      ? "RESULTADO_DISPONIBILIDAD: LIBRE — " + consultaDisp.fecha_turno + " " + consultaDisp.hora_turno + " para " + consultaDisp.tipo_servicio + " está disponible. Informale al cliente y preguntale si confirma."
      : "RESULTADO_DISPONIBILIDAD: OCUPADO — " + consultaDisp.fecha_turno + " " + consultaDisp.hora_turno + " para " + consultaDisp.tipo_servicio + " está ocupado. Sugerí otro horario cercano."

    respuesta = await consultarOpenAI(historial, textoUsuario, estadoActual, infoActual, turnoPropuesto.get(telefono) || null, ctxDisp)
    console.log("[IA 2]", respuesta.substring(0, 300))
  }

  const datosCliente   = extraerDirectiva(respuesta, "DATOS_CLIENTE")
  const datosTurno     = extraerDirectiva(respuesta, "AGENDAR_TURNO")
  const atencionHumana = extraerDirectivaBoolean(respuesta, "ATENCION_HUMANA")
  const textoFinal     = limpiarRespuesta(respuesta)

  if (datosCliente) {
    await actualizarCliente(telefono, datosCliente)
    console.log("[cliente]", datosCliente)
  }

  if (atencionHumana) {
    botsDesactivados.add(telefono)
    turnoPropuesto.delete(telefono)
    await actualizarCliente(telefono, { estado_flujo: ESTADO.ATENCION_HUMANA })
    console.log("[BOT OFF]", telefono)
  }

  let turnoCreado = null
  if (datosTurno) {
    const dispFinal = await consultarDisponibilidad(datosTurno.fecha_turno, datosTurno.hora_turno, datosTurno.tipo_servicio)
    if (!dispFinal.disponible) {
      const aviso = "Ese horario acaba de ser tomado por otro cliente. ¿Querés que busquemos el próximo disponible?"
      await guardarMensaje(telefono, "assistant", aviso)
      await sendWithTyping(client, msg.from, aviso)
      turnoPropuesto.delete(telefono)
      return
    }
    turnoCreado = await crearTurno(telefono, {
      ...datosTurno,
      descripcion:    datosTurno.descripcion || turnoEnEspera?.descripcion || null,
      nombre_cliente: datosCliente?.nombre   || cliente.nombre             || null
    })
    console.log("[turno creado]", turnoCreado)
    turnoPropuesto.delete(telefono)
  }

  await guardarMensaje(telefono, "assistant", textoFinal)

  let botonesRespuesta = null
  if (turnoPropuesto.has(telefono) || (textoFinal.match(/lo reservamos|lo agend|ese horario/i) && !datosTurno)) {
    botonesRespuesta = [
      { id: "btn_si", text: "✅ Sí, reservar"   },
      { id: "btn_no", text: "🔄 Otro horario"   }
    ]
  }

  await sendWithTyping(client, msg.from, textoFinal, botonesRespuesta)

  if (datosTurno && !turnoCreado?.error) {
    await sleep(1500)
    const msgS = mensajeSena(datosTurno)
    await sendWithTyping(client, msg.from, msgS)
    await guardarMensaje(telefono, "assistant", msgS)
    await actualizarCliente(telefono, { estado: "agendado", estado_flujo: ESTADO.ESPERANDO_COMPROBANTE })
  }
}

// ============================================================
// REGISTRO DE EVENTOS
// ============================================================
function registrarEventos(client) {
  client.onMessage(async (msg) => {
    try {
      if (msg.fromMe)                      return
      if (msg.isGroupMsg)                  return
      if (msg.type === "e2e_notification") return
      if (msg.type === "notification")     return

      const telefono = extraerTelefono(msg)
      if (!telefono) { console.log("[IGNORADO sin telefono]", msg.from); return }

      console.log("[MSG] tel:", telefono, "| from:", msg.from, "| tipo:", msg.type)

      // ── Modo solo-difusión: no contestamos nada, solo dejamos registro ──
      if (!RESPONDER_AUTOMATICAMENTE) {
        const descripcion = ["image", "document"].includes(msg.type)
          ? "[El cliente envió una imagen/documento]"
          : ((msg.body || "").trim() || "[mensaje sin texto - tipo: " + msg.type + "]")
        await guardarMensaje(telefono, "user", descripcion)
        return
      }

      // ── A partir de acá, motor conversacional completo (solo si RESPONDER_AUTOMATICAMENTE = true) ──
      if (botsDesactivados.has(telefono)) { console.log("[IGNORADO HUMANO]", telefono); return }
      const sesionCheck = await obtenerSesion(telefono)
      if (sesionCheck.cliente?.estado_flujo === ESTADO.ATENCION_HUMANA) {
        botsDesactivados.add(telefono)
        console.log("[IGNORADO HUMANO BD]", telefono)
        return
      }

      if (["image", "document"].includes(msg.type)) {
        await procesarImagen(client, msg, telefono)
        return
      }

      let texto = ""

      if (msg.type === "buttons_response" || msg.type === "template_button_reply") {
        const btnId = msg.selectedButtonId || msg.buttonId || msg.body || ""
        texto = MAPA_BOTONES[btnId] || msg.selectedDisplayText || msg.body || ""
        console.log("[BOTON]", telefono, "id:", btnId, "→", texto.substring(0, 60))

      } else if (msg.type === "list_response") {
        const rowId = msg.listResponse?.singleSelectReply?.selectedRowId || ""
        texto = MAPA_BOTONES[rowId] || msg.selectedRowTitle || msg.body || ""

      } else {
        const btnId = msg.selectedButtonId || ""
        if (btnId && MAPA_BOTONES[btnId]) {
          texto = MAPA_BOTONES[btnId]
        } else {
          texto = (msg.body || "").trim()
        }
      }

      texto = texto.trim()
      if (!texto) { console.log("[IGNORADO vacío] tipo=" + msg.type); return }

      console.log("[TEXTO]", telefono + ":", texto.substring(0, 80))
      await procesarMensajeTexto(client, msg, telefono, texto)

    } catch (err) {
      console.error("[handler] Error:", err.message, err.stack)
    }
  })
}

// ============================================================
// ARRANQUE
// ============================================================
async function startBot() {
  console.log("[CONFIG] RESPONDER_AUTOMATICAMENTE:", RESPONDER_AUTOMATICAMENTE,
    "| key OpenAI:", OPENAI_KEY ? "presente" : "AUSENTE (se usa el mensaje fijo de fallback)")

  const client = await wppconnect.create({
    session:      SESSION,
    headless:     true,
    autoClose:    0,
    waitForLogin: true,
    logQR:        true,
    puppeteerOptions: {
      executablePath: "/data/data/com.termux/files/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"]
    }
  })

  const { fechaLegible, hora } = ahoraArgentina()
  console.log("=== BOT INICIADO ===", fechaLegible, hora)

  registrarEventos(client)

  console.log("Esperando carga completa (30s)...")
  await sleep(30000)

  const jidAviso = await resolverJidNumero(client, NUMERO_PRIMER_AVISO)
  if (jidAviso) {
    try {
      await enviarTextoForzando(client, jidAviso, normalizarNegritas(
        "✅ *Bot Fauno Tattoo iniciado correctamente*\n" +
        "📅 " + fechaLegible + " · " + hora + "\n\n" +
        "Modo: " + (RESPONDER_AUTOMATICAMENTE ? "conversacional (contesta y agenda turnos)" : "SOLO difusión (no contesta mensajes entrantes)") + "\n" +
        "La difusión de la agenda de agosto iniciará en breve."
      ))
      console.log("[aviso] enviado a", jidAviso)
    } catch (e) {
      console.error("[aviso] error al enviar a", jidAviso + ":", e.message)
    }
  } else {
    console.error("[aviso] no se pudo resolver", NUMERO_PRIMER_AVISO)
  }

  iniciarDifusion(client).catch(err => console.error("[difusion] error general:", err.message))
}

startBot()