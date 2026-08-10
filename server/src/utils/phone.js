// ============================================================
//  Geolocalización de números por prefijo
//  54           -> Argentina
//  54 9 223 ... -> Mar del Plata, Buenos Aires
//  El criterio es "prefijo más largo gana": primero se buscan
//  códigos de área de 4 dígitos, después 3 y por último 2 (el 11).
// ============================================================
const fs   = require("fs")
const path = require("path")
const log  = require("./logger")

const DATA_DIR = path.join(__dirname, "..", "data")

function cargarJson(archivo) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, archivo), "utf8"))
    delete raw._comment
    return raw
  } catch (e) {
    log.error("phone", "no pude leer " + archivo + ": " + e.message)
    return {}
  }
}

const AR_AREAS  = cargarJson("ar-area-codes.json")
const COUNTRIES = cargarJson("country-codes.json")

/** Deja solo dígitos. */
function soloDigitos(v) {
  return String(v || "").replace(/\D/g, "")
}

/** "5492234567890@c.us" -> "5492234567890" */
function jidANumero(jid) {
  return soloDigitos(String(jid || "").replace(/@.*$/, ""))
}

/** Busca el prefijo más largo presente en `tabla` dentro de `digits`. */
function matchPrefijo(digits, tabla, longitudes) {
  for (const len of longitudes) {
    const p = digits.slice(0, len)
    if (tabla[p]) return p
  }
  return null
}

/**
 * Analiza un número y devuelve su origen geográfico.
 * @returns {{
 *   phone: string, countryCode: string|null, country: string|null,
 *   areaCode: string|null, region: string|null, province: string|null,
 *   label: string, e164: string
 * }}
 */
function analizarNumero(numeroOJid) {
  const bruto  = String(numeroOJid || "")
  const digits = /@/.test(bruto) ? jidANumero(bruto) : soloDigitos(bruto)

  const vacio = {
    phone: digits, countryCode: null, country: null,
    areaCode: null, region: null, province: null,
    label: "Desconocido", e164: digits ? "+" + digits : ""
  }

  // Los JID @lid no son teléfonos: son identificadores internos de WhatsApp.
  // Como son puros dígitos, sin este corte matchean cualquier prefijo de país
  // (uno que empieza con 1 se reporta como Estados Unidos, con 7 como Rusia…)
  // y ensucian el listado de países con lugares que no existen en la agenda.
  if (/@lid$/i.test(bruto)) return vacio

  // E.164: un número real tiene entre 8 y 15 dígitos contando el país.
  // Fuera de ese rango no intentamos adivinar el origen.
  if (!digits || digits.length < 8 || digits.length > 15) return vacio

  const cc = matchPrefijo(digits, COUNTRIES, [4, 3, 2, 1])
  if (!cc) return vacio

  // El número nacional que queda tiene que ser plausible: al menos 6 dígitos.
  // Esto descarta prefijos de 1 dígito que matchearon de casualidad.
  if (digits.length - cc.length < 6) return vacio

  const country = COUNTRIES[cc]

  // ---------- Argentina: además desglosamos el código de área ----------
  if (cc === "54") {
    let resto = digits.slice(2)
    // El "9" de los móviles argentinos no es parte del código de área.
    // Ningún código de área argentino empieza con 9, así que es seguro sacarlo.
    if (resto.startsWith("9")) resto = resto.slice(1)

    const area = matchPrefijo(resto, AR_AREAS, [4, 3, 2])
    if (area) {
      const [region, province] = AR_AREAS[area]
      return {
        phone: digits,
        countryCode: cc,
        country,
        areaCode: area,
        region,
        province,
        identificada: true,
        label: region + ", " + province,
        e164: "+" + digits
      }
    }

    // Código de área que no está en la tabla: guardamos los dígitos para
    // poder agrupar internamente, pero region y province quedan en NULL.
    // Así el selector de zonas muestra solo localidades reconocidas y no
    // se llena de entradas tipo "Área 2657" que no significan nada.
    return {
      phone: digits,
      countryCode: cc,
      country,
      areaCode: resto.slice(0, 3),
      region: null,
      province: null,
      identificada: false,
      label: "Argentina",
      e164: "+" + digits
    }
  }

  return {
    phone: digits,
    countryCode: cc,
    country,
    areaCode: null,
    region: null,
    province: null,
    label: country,
    e164: "+" + digits
  }
}

/**
 * Normaliza un número argentino al formato que espera WhatsApp.
 * Portado tal cual de fau.js.
 */
function normalizarNumeroArgentino(raw) {
  if (!raw) return null
  const d = soloDigitos(raw)
  if (d.length < 10) return null
  if (d.startsWith("54") && d.length === 13) return d
  if (d.startsWith("54") && d.length === 12) return "549" + d.slice(2)
  if (d.startsWith("54") && d.length === 11) return d
  if (d.length === 10) return "549" + d
  if (d.length === 11) return "54" + d
  return d
}

/** Formato lindo para la UI: +54 9 223 407-7440 */
function formatearParaMostrar(numeroOJid) {
  const d = /@/.test(String(numeroOJid)) ? jidANumero(numeroOJid) : soloDigitos(numeroOJid)
  if (!d) return ""
  const info = analizarNumero(d)
  if (info.countryCode !== "54" || !info.areaCode) return "+" + d

  let resto = d.slice(2)
  const movil = resto.startsWith("9")
  if (movil) resto = resto.slice(1)
  const local = resto.slice(info.areaCode.length)
  const corte = local.length > 6 ? 4 : 3
  return "+54 " + (movil ? "9 " : "") + info.areaCode + " " +
         local.slice(0, corte) + (local.length > corte ? "-" + local.slice(corte) : "")
}

/** Catálogo completo, para poblar los filtros del CRM. */
function catalogoAreas() {
  return Object.entries(AR_AREAS).map(([code, [region, province]]) => ({ code, region, province }))
}

function catalogoPaises() {
  return Object.entries(COUNTRIES).map(([code, name]) => ({ code, name }))
}

module.exports = {
  analizarNumero,
  normalizarNumeroArgentino,
  formatearParaMostrar,
  jidANumero,
  soloDigitos,
  catalogoAreas,
  catalogoPaises
}
