// Utilidades de aleatoriedad — mismo criterio que fau.js:
// nunca dos envíos separados por el mismo intervalo.

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pick(arr) {
  return arr[randomInt(0, arr.length - 1)]
}

function chance(prob) {
  return Math.random() < prob
}

/**
 * Espera un tiempo aleatorio entre minMs y maxMs, pero cortable:
 * si el objeto `signal` pasa a { aborted: true } la espera termina antes.
 * Lo usa el motor de difusión para que "pausar" no tarde 5 minutos en responder.
 */
function sleepRandomAbortable(minMs, maxMs, signal) {
  const ms = randomInt(minMs, maxMs)
  return new Promise(resolve => {
    const started = Date.now()
    const tick = () => {
      if (signal && signal.aborted)     return resolve({ ms, aborted: true })
      if (Date.now() - started >= ms)   return resolve({ ms, aborted: false })
      setTimeout(tick, Math.min(1000, ms - (Date.now() - started)))
    }
    tick()
  })
}

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

module.exports = { sleep, randomInt, pick, chance, sleepRandomAbortable, shuffle }
