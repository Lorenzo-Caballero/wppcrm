// ============================================================
//  Generador de variantes de mensaje (anti-spam / anti-baneo)
//
//  Mismo objetivo que generarMensajeDifusion() de fau.js — que dos
//  contactos nunca reciban un texto idéntico — pero en 3 capas
//  independientes, para que funcione aun sin OpenAI:
//
//    1. SPINTAX     {Hola|Buenas|Qué tal}  -> elige una al azar
//    2. SINÓNIMOS   diccionario es-AR aplicado con probabilidad
//    3. IA          reescritura opcional con OpenAI (si hay API key)
//
//  Además reemplaza variables: {{nombre}} {{saludo}} {{ciudad}} ...
// ============================================================
const fetch = require("node-fetch")
const env   = require("../config/env")
const log   = require("../utils/logger")
const { pick, chance, randomInt } = require("../utils/random")
const { ahoraArgentina } = require("../utils/time")

// ---------- Diccionario de sinónimos (español rioplatense) ----------
// Cada grupo es intercambiable. Se aplica al azar palabra por palabra,
// respetando mayúscula inicial.
const SINONIMOS = [
  ["hola", "buenas", "qué tal", "holaa"],
  ["genial", "buenísimo", "excelente", "bárbaro"],
  ["rápido", "enseguida", "en poco tiempo", "a la brevedad"],
  ["consultá", "preguntá", "escribinos", "contactanos"],
  ["ahora", "en este momento", "por estos días", "en estos días"],
  ["oferta", "promoción", "propuesta", "oportunidad"],
  ["descuento", "rebaja", "beneficio", "precio especial"],
  ["turno", "cita", "reserva", "horario"],
  ["gracias", "muchas gracias", "mil gracias"],
  ["disponible", "libre", "abierto"],
  ["podés", "tenés la opción de", "vas a poder"],
  ["querés", "te interesa", "tenés ganas de"],
  ["contame", "decime", "avisame"],
  ["novedad", "noticia", "novedad importante"],
  ["cliente", "persona", "vos"],
  ["mensaje", "mensajito", "aviso"],
  ["hoy", "en el día de hoy", "durante el día"],
  ["importante", "clave", "fundamental"]
]

const SALUDOS = [
  "Hola!", "Buenas!", "Qué tal!", "Buen día!", "Cómo andás!", "Hola, cómo va!"
]

const CIERRES = [
  "Cualquier cosa escribime 🙌",
  "Quedo atento a tu mensaje 🙌",
  "Escribime y lo vemos 👍",
  "Avisame cualquier duda 🙌",
  "Estoy a disposición 👍"
]

// ============================================================
//  1. SPINTAX
// ============================================================
/**
 * Expande {opcion a|opcion b|opcion c}, incluso anidados:
 *   "{Hola|{Buenas|Qué tal}} {{nombre}}"
 */
function expandirSpintax(texto) {
  if (!texto) return ""
  let out = String(texto)
  let guard = 0

  // Se resuelve siempre el grupo más interno (sin llaves adentro).
  while (/\{[^{}]*\|[^{}]*\}/.test(out) && guard++ < 200) {
    out = out.replace(/\{([^{}]*)\}/g, (match, contenido) => {
      if (!contenido.includes("|")) return match
      const opciones = contenido.split("|")
      return opciones[randomInt(0, opciones.length - 1)]
    })
  }
  return out
}

/** Valida el spintax de una plantilla antes de guardarla. */
function validarSpintax(texto) {
  let abiertas = 0
  for (const ch of String(texto || "")) {
    if (ch === "{") abiertas++
    if (ch === "}") abiertas--
    if (abiertas < 0) return { ok: false, error: "Hay una llave '}' de más" }
  }
  if (abiertas !== 0) return { ok: false, error: "Falta cerrar " + abiertas + " llave(s) '{'" }
  return { ok: true }
}

// ============================================================
//  2. SINÓNIMOS
// ============================================================
function conservarMayuscula(original, reemplazo) {
  if (original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) {
    return reemplazo.charAt(0).toUpperCase() + reemplazo.slice(1)
  }
  return reemplazo
}

/**
 * Cambia algunas palabras por sinónimos.
 * @param intensidad 0 = no toca nada, 1 = intenta cambiar todo lo que puede
 */
function aplicarSinonimos(texto, intensidad = 0.35) {
  if (!texto || intensidad <= 0) return texto
  let out = texto

  for (const grupo of SINONIMOS) {
    for (const palabra of grupo) {
      // \b no funciona bien con acentos: usamos lookarounds sobre letras Unicode.
      const re = new RegExp("(?<![\\p{L}])(" + escapeRegex(palabra) + ")(?![\\p{L}])", "giu")
      out = out.replace(re, (m) => {
        if (!chance(intensidad)) return m
        const alternativas = grupo.filter(p => p.toLowerCase() !== m.toLowerCase())
        if (!alternativas.length) return m
        return conservarMayuscula(m, pick(alternativas))
      })
    }
  }
  return out
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ============================================================
//  3. VARIABLES
// ============================================================
function reemplazarVariables(texto, contacto = {}) {
  const { fechaLegible, fecha } = ahoraArgentina()
  const nombre = limpiarNombre(contacto.name || contacto.push_name || "")

  const mapa = {
    nombre:    nombre || "",
    saludo:    nombre ? pick(SALUDOS) + " " + nombre + "!" : pick(SALUDOS),
    ciudad:    contacto.region   || "",
    provincia: contacto.province || "",
    pais:      contacto.country  || "",
    telefono:  contacto.phone    || "",
    fecha:     fecha,
    fecha_larga: fechaLegible,
    cierre:    pick(CIERRES)
  }

  let out = String(texto || "")
  for (const [clave, valor] of Object.entries(mapa)) {
    out = out.replace(new RegExp("\\{\\{\\s*" + clave + "\\s*\\}\\}", "gi"), valor)
  }
  // Limpieza si quedó un saludo sin nombre: "Hola , " -> "Hola, "
  return out.replace(/\s+,/g, ",").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim()
}

/** Portado de extraerNombre() de fau.js: saca emojis y se queda con el primer nombre. */
function limpiarNombre(pushname) {
  if (!pushname || typeof pushname !== "string") return null
  const limpio = pushname
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

/** WhatsApp usa un solo asterisco para negrita; ** o *** rompen el formato. */
function normalizarNegritas(texto) {
  return texto ? texto.replace(/\*{2,}/g, "*") : texto
}

// ============================================================
//  4. REESCRITURA CON IA (opcional)
// ============================================================
async function reescribirConIA(texto, contacto = {}) {
  if (!env.openaiKey) return null

  const nombre = limpiarNombre(contacto.name || contacto.push_name || "")
  const ctxNombre = nombre
    ? "El destinatario se llama " + nombre + ". Saludalo por su nombre al inicio, de forma natural."
    : "No tenés el nombre del destinatario. Usá un saludo genérico argentino."

  const prompt =
`Reformulá el siguiente mensaje de WhatsApp cambiando el orden de las frases y algunas
palabras por sinónimos, para que no quede idéntico cada vez, PERO manteniendo
EXACTAMENTE la misma información y la misma intención comercial.

${ctxNombre}

REGLAS ESTRICTAS:
- No inventes datos, precios, fechas, promociones, descuentos ni direcciones que no estén en el original.
- Si el original no menciona precios, vos tampoco.
- No agregues preguntas nuevas ni pidas datos que el original no pide.
- Tono argentino, cálido y profesional.
- Usá UN SOLO asterisco para negrita (*texto*), nunca doble.
- Respetá aproximadamente el mismo largo (máximo 6 líneas).
- No uses listas ni viñetas.
- No menciones que sos un bot ni un sistema automático.

Mensaje original:
${texto}

Respondé ÚNICAMENTE con el mensaje reformulado, sin comillas ni explicaciones.`

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.openaiKey },
      body: JSON.stringify({
        model: env.openaiModel,
        temperature: 1.0,
        max_tokens: 400,
        messages: [
          { role: "system", content: "Sos un redactor experto en comunicación informal argentina para WhatsApp. Cada mensaje que producís es único." },
          { role: "user",   content: prompt }
        ]
      })
    })
    if (!res.ok) { log.warn("ia", "OpenAI respondió " + res.status); return null }

    const data  = await res.json()
    const salida = (data.choices?.[0]?.message?.content || "").trim()
    if (!salida || salida.length < 20) return null

    // Guarda defensiva heredada de fau.js: si el original no tenía precios
    // y la IA inventó uno, descartamos la reescritura.
    if (!/\$\s?\d/.test(texto) && /\$\s?\d/.test(salida)) {
      log.warn("ia", "la reescritura inventó un precio, uso la versión local")
      return null
    }
    return salida
  } catch (e) {
    log.warn("ia", "excepción: " + e.message)
    return null
  }
}

// ============================================================
//  API PÚBLICA
// ============================================================
/**
 * Genera la versión final del mensaje para un contacto concreto.
 * @param {string} plantilla  texto base (puede tener spintax y {{variables}})
 * @param {object} contacto   fila de la tabla contacts
 * @param {object} opciones   { sinonimos:0..1, usarIA:boolean }
 */
async function renderizarMensaje(plantilla, contacto = {}, opciones = {}) {
  const intensidad = typeof opciones.sinonimos === "number" ? opciones.sinonimos : 0.35

  let texto = expandirSpintax(plantilla)
  texto = reemplazarVariables(texto, contacto)
  texto = aplicarSinonimos(texto, intensidad)

  if (opciones.usarIA && env.openaiKey) {
    const iaTexto = await reescribirConIA(texto, contacto)
    if (iaTexto) texto = iaTexto
  }

  return normalizarNegritas(texto).trim()
}

/** Vista previa sincrónica (sin IA) para el panel: N variantes distintas. */
function previsualizar(plantilla, cantidad = 3, contactoDemo = {}) {
  const demo = Object.assign(
    { name: "Sofía", push_name: "Sofía", region: "Mar del Plata", province: "Buenos Aires", country: "Argentina", phone: "5492234077440" },
    contactoDemo
  )
  const out = []
  for (let i = 0; i < cantidad; i++) {
    let t = expandirSpintax(plantilla)
    t = reemplazarVariables(t, demo)
    t = aplicarSinonimos(t, 0.35)
    out.push(normalizarNegritas(t).trim())
  }
  return out
}

module.exports = {
  renderizarMensaje,
  previsualizar,
  expandirSpintax,
  validarSpintax,
  aplicarSinonimos,
  reemplazarVariables,
  normalizarNegritas,
  limpiarNombre,
  SALUDOS,
  CIERRES
}
