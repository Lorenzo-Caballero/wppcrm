// Logger mínimo con marca de tiempo local y scope. Sin dependencias.
const COLORS = {
  reset: "\x1b[0m", gray: "\x1b[90m", red: "\x1b[31m",
  yellow: "\x1b[33m", green: "\x1b[32m", cyan: "\x1b[36m"
}

function stamp() {
  return new Date().toLocaleString("es-AR", { hour12: false })
}

function emit(color, level, scope, args) {
  const prefix = COLORS.gray + stamp() + COLORS.reset + " " + color + "[" + scope + "]" + COLORS.reset
  console.log(prefix, ...args)
}

module.exports = {
  info:  (scope, ...a) => emit(COLORS.cyan,   "info",  scope, a),
  ok:    (scope, ...a) => emit(COLORS.green,  "ok",    scope, a),
  warn:  (scope, ...a) => emit(COLORS.yellow, "warn",  scope, a),
  error: (scope, ...a) => emit(COLORS.red,    "error", scope, a),
  debug: (scope, ...a) => { if (process.env.DEBUG) emit(COLORS.gray, "debug", scope, a) }
}
