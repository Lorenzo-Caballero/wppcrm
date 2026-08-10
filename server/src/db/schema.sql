-- ============================================================
--  wppcrm — esquema multi-cliente (multi-tenant)
--  Todo lo que pertenece a un cliente cuelga de tenants.id.
--  Idempotente: se puede correr en cada arranque sin romper nada.
-- ============================================================

-- ---------- CLIENTES DE LA PLATAFORMA (tenants) -------------
CREATE TABLE IF NOT EXISTS tenants (
  id            SERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  slug          TEXT        NOT NULL UNIQUE,
  status        TEXT        NOT NULL DEFAULT 'active',   -- active | suspended
  plan          TEXT        NOT NULL DEFAULT 'basico',
  max_sessions  INT         NOT NULL DEFAULT 1,
  daily_limit   INT         NOT NULL DEFAULT 300,        -- tope de mensajes de difusión por día
  settings      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- USUARIOS ----------------------------------------
-- role = 'owner'  -> dueño de la plataforma (tenant_id NULL, ve todo)
-- role = 'admin'  -> administrador del cliente
-- role = 'agent'  -> operador del CRM del cliente
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT         REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'admin',
  status        TEXT        NOT NULL DEFAULT 'active',
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

-- ---------- SESIONES DE WHATSAPP ----------------------------
CREATE TABLE IF NOT EXISTS wa_sessions (
  id           SERIAL PRIMARY KEY,
  tenant_id    INT         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_key  TEXT        NOT NULL UNIQUE,  -- nombre de carpeta de tokens en disco
  label        TEXT        NOT NULL DEFAULT 'Principal',
  status       TEXT        NOT NULL DEFAULT 'disconnected',
  phone        TEXT,
  last_qr      TEXT,
  last_error   TEXT,
  autostart    BOOLEAN     NOT NULL DEFAULT TRUE,
  connected_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON wa_sessions(tenant_id);

-- ---------- CONTACTOS ---------------------------------------
-- La geolocalización por prefijo (country / area_code / region)
-- se calcula al guardar, en utils/phone.js
CREATE TABLE IF NOT EXISTS contacts (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        INT         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  jid              TEXT        NOT NULL,
  phone            TEXT,
  name             TEXT,
  push_name        TEXT,
  country          TEXT,
  country_code     TEXT,
  area_code        TEXT,
  region           TEXT,
  province         TEXT,
  is_group         BOOLEAN     NOT NULL DEFAULT FALSE,
  last_campaign_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, jid)
);
CREATE INDEX IF NOT EXISTS idx_contacts_area    ON contacts(tenant_id, area_code);
CREATE INDEX IF NOT EXISTS idx_contacts_country ON contacts(tenant_id, country_code);

-- ---------- CHATS -------------------------------------------
CREATE TABLE IF NOT EXISTS chats (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         INT         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id        INT         REFERENCES wa_sessions(id) ON DELETE SET NULL,
  contact_id        BIGINT      NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  wa_chat_id        TEXT        NOT NULL,
  unread_count      INT         NOT NULL DEFAULT 0,
  last_message_at   TIMESTAMPTZ,
  last_message_text TEXT,
  last_direction    TEXT,                                 -- in | out
  last_inbound_at   TIMESTAMPTZ,                           -- "última vez que el cliente escribió"
  archived          BOOLEAN     NOT NULL DEFAULT FALSE,
  pinned            BOOLEAN     NOT NULL DEFAULT FALSE,
  status            TEXT        NOT NULL DEFAULT 'abierto', -- abierto | pendiente | cerrado
  tags              TEXT[]      NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wa_chat_id)
);
CREATE INDEX IF NOT EXISTS idx_chats_last ON chats(tenant_id, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_chats_inb  ON chats(tenant_id, last_inbound_at DESC NULLS LAST);

-- ---------- MENSAJES ----------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  INT         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chat_id    BIGINT      NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  wa_msg_id  TEXT,
  direction  TEXT        NOT NULL,                 -- in | out
  type       TEXT        NOT NULL DEFAULT 'chat',
  body       TEXT,
  media_url  TEXT,
  status     TEXT,                                  -- sent | delivered | read | error
  author     TEXT,                                  -- nombre del agente que respondió (si direction=out)
  campaign_id INT,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wa_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, sent_at DESC);

-- ---------- DIFUSIONES --------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id           SERIAL PRIMARY KEY,
  tenant_id    INT         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id   INT         REFERENCES wa_sessions(id) ON DELETE SET NULL,
  name         TEXT        NOT NULL,
  base_message TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'draft', -- draft|running|paused|done|cancelled|error
  filters      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  settings     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  total        INT         NOT NULL DEFAULT 0,
  sent         INT         NOT NULL DEFAULT 0,
  failed       INT         NOT NULL DEFAULT 0,
  skipped      INT         NOT NULL DEFAULT 0,
  created_by   INT         REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id, created_at DESC);

-- Equivalente moderno de difusion-agosto.json: nadie recibe dos veces
CREATE TABLE IF NOT EXISTS campaign_targets (
  id          BIGSERIAL PRIMARY KEY,
  campaign_id INT         NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id  BIGINT      REFERENCES contacts(id) ON DELETE CASCADE,
  jid         TEXT        NOT NULL,
  name        TEXT,
  status      TEXT        NOT NULL DEFAULT 'pending', -- pending|sent|failed|skipped
  rendered    TEXT,
  error       TEXT,
  sent_at     TIMESTAMPTZ,
  UNIQUE (campaign_id, jid)
);
CREATE INDEX IF NOT EXISTS idx_targets_pend ON campaign_targets(campaign_id, status);

-- ---------- PLANTILLAS DE MENSAJE ---------------------------
CREATE TABLE IF NOT EXISTS templates (
  id         SERIAL PRIMARY KEY,
  tenant_id  INT         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_templates_tenant ON templates(tenant_id);

-- ---------- AUDITORÍA ---------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  INT,
  user_id    INT,
  action     TEXT        NOT NULL,
  detail     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- RESPUESTAS RÁPIDAS ------------------------------
-- Se insertan en el chat escribiendo /atajo
CREATE TABLE IF NOT EXISTS quick_replies (
  id         SERIAL PRIMARY KEY,
  tenant_id  INT         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shortcut   TEXT        NOT NULL,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, shortcut)
);

-- ---------- ESTADOS PUBLICADOS ------------------------------
CREATE TABLE IF NOT EXISTS statuses (
  id         SERIAL PRIMARY KEY,
  tenant_id  INT         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id INT         REFERENCES wa_sessions(id) ON DELETE SET NULL,
  tipo       TEXT        NOT NULL,          -- texto | imagen | video
  contenido  TEXT,                          -- texto del estado o epígrafe
  media_url  TEXT,
  opciones   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by INT         REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_statuses_tenant ON statuses(tenant_id, created_at DESC);

-- ============================================================
--  AMPLIACIONES DE COLUMNAS
--  Van con ADD COLUMN IF NOT EXISTS para que este archivo se
--  siga pudiendo correr entero en cada arranque sin romper nada.
-- ============================================================
ALTER TABLE chats    ADD COLUMN IF NOT EXISTS notes         TEXT;
ALTER TABLE chats    ADD COLUMN IF NOT EXISTS follow_up_at  TIMESTAMPTZ;
ALTER TABLE chats    ADD COLUMN IF NOT EXISTS muted_until   TIMESTAMPTZ;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime    TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_name    TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS quoted_id     TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS starred       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reaction      TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted       BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_chats_followup ON chats(tenant_id, follow_up_at)
  WHERE follow_up_at IS NOT NULL;

-- ============================================================
--  ÍNDICES DE BÚSQUEDA Y RENDIMIENTO
-- ============================================================
-- pg_trgm permite que un LIKE '%texto%' use índice en vez de recorrer
-- toda la tabla. Sin esto, buscar dentro de los mensajes se arrastra
-- apenas pasás de unos miles.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_messages_body_trgm
  ON messages USING gin (body gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contacts_nombre_trgm
  ON contacts USING gin ((COALESCE(name, '') || ' ' || COALESCE(push_name, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(tenant_id, phone);

-- El orden por defecto del listado: activos, más recientes primero.
CREATE INDEX IF NOT EXISTS idx_chats_listado
  ON chats(tenant_id, archived, pinned DESC, last_message_at DESC NULLS LAST);
