// Manejo de hora argentina (UTC-3) — portado de fau.js, incluido el fix de
// msecsHastaProximaApertura (antes siempre sumaba un día entero).

const AR_OFFSET_HOURS = -3

const DIAS  = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"]
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
               "agosto", "septiembre", "octubre", "noviembre", "diciembre"]

function pad(n) { return String(n).padStart(2, "0") }

function ahoraArgentina() {
  const now   = new Date()
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000
  const d     = new Date(utcMs + AR_OFFSET_HOURS * 3600000)
  return {
    date:         d,
    fecha:        d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()),
    hora:         pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()),
    fechaLegible: DIAS[d.getDay()] + " " + d.getDate() + " de " + MESES[d.getMonth()] + " de " + d.getFullYear(),
    diaSemana:    d.getDay(),
    horaNum:      d.getHours(),
    minutoNum:    d.getMinutes()
  }
}

/** "07:00" -> 420 (minutos desde medianoche) */
function hhmmAMinutos(hhmm) {
  const [h, m] = String(hhmm || "00:00").split(":").map(Number)
  return (h || 0) * 60 + (m || 0)
}

/**
 * ¿Estamos dentro de la ventana horaria de difusión?
 * ventana = { inicio: "07:00", fin: "23:30", dias: [1,2,3,4,5,6,0] }
 */
function dentroDeVentana(ventana) {
  const { horaNum, minutoNum, diaSemana } = ahoraArgentina()

  if (Array.isArray(ventana.dias) && ventana.dias.length && !ventana.dias.includes(diaSemana)) {
    return false
  }
  const totalMin = horaNum * 60 + minutoNum
  const inicio   = hhmmAMinutos(ventana.inicio || "07:00")
  const fin      = hhmmAMinutos(ventana.fin    || "23:30")

  // Ventana que cruza medianoche (ej. 22:00 -> 02:00)
  if (fin <= inicio) return totalMin >= inicio || totalMin < fin
  return totalMin >= inicio && totalMin < fin
}

/**
 * Milisegundos hasta la próxima apertura de la ventana.
 * FIX heredado de fau.js: si la apertura de HOY todavía no pasó, espera
 * hasta hoy; solo salta al día siguiente cuando ya pasó.
 * Además respeta los días habilitados (salta hasta 7 días si hace falta).
 */
function msHastaProximaApertura(ventana) {
  const dias   = Array.isArray(ventana.dias) && ventana.dias.length ? ventana.dias : [0, 1, 2, 3, 4, 5, 6]
  const inicio = hhmmAMinutos(ventana.inicio || "07:00")
  const now    = new Date()

  for (let offset = 0; offset <= 7; offset++) {
    const apertura = new Date(now)
    apertura.setUTCDate(apertura.getUTCDate() + offset)
    // AR = UTC-3  =>  las 07:00 AR son las 10:00 UTC
    apertura.setUTCHours(Math.floor(inicio / 60) - AR_OFFSET_HOURS, inicio % 60, 0, 0)

    if (apertura.getTime() <= now.getTime()) continue

    const diaAr = new Date(apertura.getTime() + AR_OFFSET_HOURS * 3600000).getUTCDay()
    if (!dias.includes(diaAr)) continue

    return apertura.getTime() - now.getTime()
  }
  return 60_000 // fallback defensivo: reintentar en un minuto
}

module.exports = { ahoraArgentina, dentroDeVentana, msHastaProximaApertura, hhmmAMinutos, DIAS, MESES }
