const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/i.test(value))
    throw new Error("wallet: PostgreSQL namespace must be a simple identifier");
  return value;
};

/** Production append-only journal schema. PostgreSQL refuses to commit an unbalanced transaction. */
export const walletPostgresSchemaSql = (namespace = "wallet") => {
  const n = identifier(namespace);
  return `
CREATE SCHEMA IF NOT EXISTS ${n};
CREATE TABLE IF NOT EXISTS ${n}.accounts (
  id text PRIMARY KEY, owner_id text, currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  allow_negative boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${n}.transactions (
  id text PRIMARY KEY, idempotency_key text NOT NULL UNIQUE, kind text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${n}.entries (
  transaction_id text NOT NULL REFERENCES ${n}.transactions(id) ON DELETE RESTRICT,
  position smallint NOT NULL CHECK (position >= 0),
  account_id text NOT NULL REFERENCES ${n}.accounts(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0), PRIMARY KEY (transaction_id, position)
);
CREATE INDEX IF NOT EXISTS wallet_entries_account_idx ON ${n}.entries(account_id, transaction_id);
CREATE TABLE IF NOT EXISTS ${n}.reservations (
  id text PRIMARY KEY, idempotency_key text NOT NULL UNIQUE,
  account_id text NOT NULL REFERENCES ${n}.accounts(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'captured', 'released', 'expired')),
  purpose text NOT NULL, capture_transaction_id text REFERENCES ${n}.transactions(id) ON DELETE RESTRICT,
  expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_reservations_active_idx ON ${n}.reservations(account_id, expires_at) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS ${n}.agent_allowances (
  allowance_id text PRIMARY KEY, agent_id text NOT NULL, owner_id text NOT NULL,
  account_id text NOT NULL REFERENCES ${n}.accounts(id) ON DELETE RESTRICT,
  currency text NOT NULL, status text NOT NULL CHECK (status IN ('active', 'paused', 'revoked')),
  policy jsonb NOT NULL, valid_from timestamptz, valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_agent_allowances_agent_idx ON ${n}.agent_allowances(agent_id, status);
CREATE TABLE IF NOT EXISTS ${n}.spend_mandates (
  mandate_id text PRIMARY KEY, allowance_id text NOT NULL REFERENCES ${n}.agent_allowances(allowance_id) ON DELETE RESTRICT,
  reservation_id text NOT NULL UNIQUE REFERENCES ${n}.reservations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL, agent_id text NOT NULL, merchant_id text NOT NULL,
  cart_hash text NOT NULL, amount_cents bigint NOT NULL CHECK (amount_cents > 0), currency text NOT NULL,
  binding_digest text NOT NULL, signature text NOT NULL, agency_action_id text,
  status text NOT NULL CHECK (status IN ('active', 'pending_approval', 'captured', 'cancelled', 'expired', 'refunded')),
  captured_transaction_id text REFERENCES ${n}.transactions(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_spend_mandates_idempotency_idx ON ${n}.spend_mandates(allowance_id, idempotency_key);
CREATE INDEX IF NOT EXISTS wallet_spend_mandates_allowance_idx ON ${n}.spend_mandates(allowance_id, created_at);
CREATE OR REPLACE FUNCTION ${n}.assert_transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_total bigint;
BEGIN
  SELECT COALESCE(SUM(amount_cents), 0) INTO entry_total FROM ${n}.entries
    WHERE transaction_id = COALESCE(NEW.transaction_id, OLD.transaction_id);
  IF entry_total <> 0 THEN
    RAISE EXCEPTION 'wallet transaction % is unbalanced by % cents', COALESCE(NEW.transaction_id, OLD.transaction_id), entry_total;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS wallet_entries_balanced ON ${n}.entries;
CREATE CONSTRAINT TRIGGER wallet_entries_balanced AFTER INSERT OR UPDATE OR DELETE ON ${n}.entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${n}.assert_transaction_balanced();
`.trim();
};

/** Parameterized snapshot query; bind the account id as $1. */
export const walletPostgresSnapshotSql = (namespace = "wallet") => {
  const n = identifier(namespace);
  return `SELECT a.*,
  COALESCE((SELECT SUM(e.amount_cents) FROM ${n}.entries e WHERE e.account_id = a.id), 0)::bigint AS balance_cents,
  COALESCE((SELECT SUM(r.amount_cents) FROM ${n}.reservations r WHERE r.account_id = a.id AND r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at > now())), 0)::bigint AS reserved_cents
FROM ${n}.accounts a WHERE a.id = $1`.trim();
};
