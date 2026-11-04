-- Twelve Issues database schema (Cloudflare D1)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  company TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',          -- user | admin
  signup_source TEXT,                          -- utm / referrer captured at signup
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                          -- author | business
  title TEXT NOT NULL,
  source_files TEXT,                           -- JSON array of {name, chars}
  source_text TEXT,                            -- extracted text (capped)
  source_chars INTEGER NOT NULL DEFAULT 0,
  questionnaire TEXT,                          -- JSON
  settings TEXT,                               -- JSON: tone, cadence, cta_url, audience
  status TEXT NOT NULL DEFAULT 'awaiting_payment', -- awaiting_payment | paid | generating | complete | failed
  price_cents INTEGER NOT NULL DEFAULT 1200,
  stripe_session_id TEXT,
  paid_at TEXT,
  comped INTEGER NOT NULL DEFAULT 0,
  brief TEXT,                                  -- JSON content brief + 12-issue plan
  progress INTEGER NOT NULL DEFAULT 0,         -- 0 = not started, 1 = brief done, 2..4 = issue batches done
  locked_until TEXT,
  error TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  rating INTEGER,                              -- customer feedback 1..5
  feedback TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  month_label TEXT,
  subject TEXT NOT NULL,
  subject_alt TEXT,                            -- second subject line for A/B tests
  preview_text TEXT,
  headline TEXT,
  body TEXT NOT NULL,                          -- markdown
  cta TEXT,
  image_idea TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (submission_id, number)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,                        -- paid | comped | refunded
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  submission_id TEXT,
  type TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
