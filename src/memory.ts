import { assertBalanced, cents, type WalletAccount, type WalletEntry, type WalletReservation, type WalletSnapshot, type WalletStore, type WalletTransaction } from "./core";

export const createMemoryWalletStore = (): WalletStore => {
  const accounts = new Map<string, WalletAccount>();
  const balances = new Map<string, number>();
  const reservations = new Map<string, WalletReservation>();
  const transactions = new Map<string, WalletTransaction>();
  const ids = new Map<string, string>();
  let sequence = 0;
  let tail = Promise.resolve();
  const locked = async <T>(run: () => T | Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await run(); } finally { release(); }
  };
  const activeReserved = (accountId: string) => [...reservations.values()].filter((row) => row.accountId === accountId && row.status === "active").reduce((sum, row) => sum + row.amountCents, 0);
  const snapshot = (id: string): WalletSnapshot | null => {
    const account = accounts.get(id);
    if (!account) return null;
    const balanceCents = balances.get(id) ?? 0;
    const reservedCents = activeReserved(id);
    return { ...account, balanceCents, reservedCents, availableCents: balanceCents - reservedCents };
  };
  const ensureWritable = (entries: WalletEntry[], captured: Set<string>) => {
    for (const entry of entries) {
      cents(Math.abs(entry.amountCents));
      const account = accounts.get(entry.accountId);
      if (!account) throw new Error(`wallet: account ${entry.accountId} not found`);
      if (account.status !== "active") throw new Error(`wallet: account ${entry.accountId} is ${account.status}`);
      if (entry.amountCents < 0 && !account.allowNegative) {
        const capturedForAccount = [...captured].map((id) => reservations.get(id)).filter((row) => row?.accountId === entry.accountId && row.status === "active").reduce((sum, row) => sum + (row?.amountCents ?? 0), 0);
        const available = (snapshot(entry.accountId)?.availableCents ?? 0) + capturedForAccount;
        if (available < -entry.amountCents) throw new Error("wallet: insufficient available balance");
      }
    }
  };
  return {
    applyFundingEvent: (input) => locked(() => {
      const existingId = ids.get(input.idempotencyKey);
      if (existingId) {
        const transaction = transactions.get(existingId)!;
        const account = snapshot(input.accountId);
        if (!account) throw new Error("wallet: account not found");
        const expectedAmount = input.kind === "funding" || input.kind === "dispute-reversal" ? input.amountCents : -input.amountCents;
        if (transaction.kind !== (input.kind === "dispute" ? "chargeback" : input.kind === "dispute-reversal" ? "adjustment" : input.kind) || transaction.metadata.paymentRef !== input.paymentRef || transaction.entries[0]?.accountId !== input.accountId || transaction.entries[0]?.amountCents !== expectedAmount)
          throw new Error("wallet: funding idempotency key was reused with different input");
        return { account, transaction };
      }
      const account = accounts.get(input.accountId);
      const clearing = accounts.get(input.clearingAccountId);
      if (!account || !clearing) throw new Error("wallet: account not found");
      if (account.status === "closed" || clearing.status !== "active")
        throw new Error("wallet: funding account is unavailable");
      if (input.kind === "funding" && account.status !== "active")
        throw new Error("wallet: funding account is not active");
      const credit = input.kind === "funding" || input.kind === "dispute-reversal";
      const amount = credit ? input.amountCents : -input.amountCents;
      const transaction: WalletTransaction = {
        createdAt: new Date().toISOString(),
        entries: [
          { accountId: input.accountId, amountCents: amount },
          { accountId: input.clearingAccountId, amountCents: -amount },
        ],
        id: `wtx:${++sequence}`,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind === "dispute" ? "chargeback" : input.kind === "dispute-reversal" ? "adjustment" : input.kind,
        metadata: { fundingEventKind: input.kind, paymentRef: input.paymentRef },
      };
      assertBalanced(transaction.entries);
      balances.set(input.accountId, (balances.get(input.accountId) ?? 0) + amount);
      balances.set(input.clearingAccountId, (balances.get(input.clearingAccountId) ?? 0) - amount);
      const balance = balances.get(input.accountId) ?? 0;
      if (input.kind === "dispute" || balance < 0)
        accounts.set(input.accountId, { ...account, status: "frozen" });
      transactions.set(transaction.id, transaction);
      ids.set(transaction.idempotencyKey, transaction.id);
      return { account: snapshot(input.accountId)!, transaction };
    }),
    createAccount: (account) => locked(() => {
      const existing = accounts.get(account.id);
      if (existing) return existing;
      accounts.set(account.id, account); balances.set(account.id, 0); return account;
    }),
    account: async (id) => accounts.get(id) ?? null,
    snapshot: async (id) => snapshot(id),
    history: async (id, limit = 100) => [...transactions.values()].filter((tx) => tx.entries.some((entry) => entry.accountId === id)).slice(-limit).reverse(),
    transactionByIdempotencyKey: async (key) => { const id = ids.get(key); return id ? transactions.get(id) ?? null : null; },
    reservation: async (id) => reservations.get(id) ?? null,
    commit: (input) => locked(() => {
      const existingId = ids.get(input.idempotencyKey);
      if (existingId) return transactions.get(existingId)!;
      assertBalanced(input.entries);
      const captured = new Set(input.captures ?? []);
      for (const id of captured) if (reservations.get(id)?.status !== "active") throw new Error("wallet: reservation is not active");
      ensureWritable(input.entries, captured);
      const tx: WalletTransaction = { ...input, id: `wtx:${++sequence}`, createdAt: new Date().toISOString() };
      for (const entry of input.entries) balances.set(entry.accountId, (balances.get(entry.accountId) ?? 0) + entry.amountCents);
      for (const id of captured) reservations.set(id, { ...reservations.get(id)!, status: "captured" });
      transactions.set(tx.id, tx); ids.set(tx.idempotencyKey, tx.id); return tx;
    }),
    reserve: (input) => locked(() => {
      const existingId = ids.get(`reserve:${input.idempotencyKey}`);
      if (existingId) return reservations.get(existingId)!;
      const account = snapshot(input.accountId);
      if (!account || account.status !== "active") throw new Error("wallet: active account not found");
      if (account.availableCents < input.amountCents) throw new Error("wallet: insufficient available balance");
      const row: WalletReservation = { ...input, id: `wrsv:${++sequence}`, status: "active", createdAt: new Date().toISOString() };
      reservations.set(row.id, row); ids.set(`reserve:${input.idempotencyKey}`, row.id); return row;
    }),
    release: (reservationId) => locked(() => {
      const row = reservations.get(reservationId);
      if (!row) throw new Error("wallet: reservation not found");
      if (row.status !== "active") return row;
      const released = { ...row, status: "released" as const };
      reservations.set(row.id, released); return released;
    }),
    reviewAccountStatus: ({ accountId, status }) => locked(() => {
      const account = accounts.get(accountId);
      if (!account) throw new Error("wallet: account not found");
      if (account.status === "closed") throw new Error("wallet: closed account cannot be reviewed");
      if (status === "active" && (balances.get(accountId) ?? 0) < 0)
        throw new Error("wallet: negative account cannot be reactivated");
      accounts.set(accountId, { ...account, status });
      return snapshot(accountId)!;
    }),
  };
};
