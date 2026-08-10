require("dotenv").config()

const path = require("path")

function bool(v, def = false) {
  if (v === undefined || v === null || v === "") return def
  return String(v).toLowerCase() === "true" || v === "1"
}

function int(v, def) {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : def
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  isProd:  (process.env.NODE_ENV || "development") === "production",
  port:    int(process.env.PORT, 3000),
  appUrl:  process.env.APP_URL || "http://localhost:3000",

  databaseUrl: process.env.DATABASE_URL || "postgres://wppcrm:wppcrm@localhost:5432/wppcrm",

  jwtSecret:   process.env.JWT_SECRET || "dev-secret-cambiar-en-produccion",
  cookieName:  "wppcrm_token",
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 24 * 7),

  owner: {
    email:    process.env.OWNER_EMAIL    || "admin@localhost",
    password: process.env.OWNER_PASSWORD || "admin1234",
    name:     process.env.OWNER_NAME     || "Owner"
  },

  openaiKey:   process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "",
  openaiModel: process.env.OPENAI_MODEL   || "gpt-4o-mini",

  maxActiveSessions: int(process.env.MAX_ACTIVE_SESSIONS, 4),
  chromePath: process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || undefined,

  dataDir:   process.env.DATA_DIR   || path.join(__dirname, "..", "..", "data"),
  tokensDir: process.env.TOKENS_DIR || path.join(__dirname, "..", "..", "data", "tokens"),
  mediaDir:  process.env.MEDIA_DIR  || path.join(__dirname, "..", "..", "data", "media")
}

if (env.isProd && env.jwtSecret === "dev-secret-cambiar-en-produccion") {
  console.error("[CONFIG] FATAL: definí JWT_SECRET en el .env antes de levantar en producción.")
  process.exit(1)
}

module.exports = env
