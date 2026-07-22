export type Cents = number;
export type WalletAccountStatus = "active" | "frozen" | "closed";
export type WalletTransactionKind = "funding" | "purchase" | "sale" | "trade-fee" | "refund" | "chargeback" | "adjustment";

export type WalletPolicy = {
  currency: string;
  minimumFundingCents: Cents;
  maximumBalanceCents: Cents;
  maximumTransactionCents: Cents;
  sellerFeeBps: number;
  tradeFeeCents: Cents;
};

export const steamLikeWalletPolicy: WalletPolicy = {
  currency: "USD",
  minimumFundingCents: 500,
  maximumBalanceCents: 200_000,
  maximumTransactionCents: 180_000,
  sellerFeeBps: 1_000,
  tradeFeeCents: 25,
};

export type WalletAccount = {
  id: string;
  ownerId: string | null;
  currency: string;
  status: WalletAccountStatus;
  /** System ledger accounts (for example a payment clearing account) may carry a debit balance. */
  allowNegative?: boolean;
  createdAt: string;
};

export type WalletEntry = { accountId: string; amountCents: Cents };
export type WalletTransaction = {
  id: string;
  idempotencyKey: string;
  kind: WalletTransactionKind;
  entries: WalletEntry[];
  metadata: Record<string, string>;
  createdAt: string;
};

export type WalletReservation = {
  id: string;
  accountId: string;
  amountCents: Cents;
  status: "active" | "captured" | "released" | "expired";
  purpose: string;
  expiresAt: string | null;
  createdAt: string;
};

export type WalletFundingEventKind =
  | "funding"
  | "refund"
  | "dispute"
  | "dispute-reversal";

export type WalletFundingEvent = {
  accountId: string;
  amountCents: Cents;
  clearingAccountId: string;
  idempotencyKey: string;
  kind: WalletFundingEventKind;
  paymentRef: string;
};

export type WalletFundingEventResult = {
  account: WalletSnapshot;
  transaction: WalletTransaction;
};

export type WalletSnapshot = WalletAccount & { balanceCents: Cents; reservedCents: Cents; availableCents: Cents };

export interface WalletStore {
  createAccount(account: WalletAccount): Promise<WalletAccount>;
  account(id: string): Promise<WalletAccount | null>;
  snapshot(id: string): Promise<WalletSnapshot | null>;
  history(id: string, limit?: number): Promise<WalletTransaction[]>;
  listAccounts(input: { limit: number; prefix?: string }): Promise<WalletSnapshot[]>;
  transactionByIdempotencyKey(key: string): Promise<WalletTransaction | null>;
  reservation(id: string): Promise<WalletReservation | null>;
  commit(input: Omit<WalletTransaction, "id" | "createdAt"> & { captures?: string[] }): Promise<WalletTransaction>;
  reserve(input: Omit<WalletReservation, "id" | "status" | "createdAt"> & { idempotencyKey: string }): Promise<WalletReservation>;
  release(reservationId: string): Promise<WalletReservation>;
  applyFundingEvent(input: WalletFundingEvent): Promise<WalletFundingEventResult>;
  reviewAccountStatus(input: { accountId: string; status: "active" | "frozen" }): Promise<WalletSnapshot>;
}

export const cents = (value: number, label = "amount"): Cents => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`wallet: ${label} must be a non-negative safe integer of cents`);
  return value;
};

export const assertBalanced = (entries: WalletEntry[]) => {
  if (entries.length < 2) throw new Error("wallet: a journal transaction needs at least two entries");
  const total = entries.reduce((sum, entry) => sum + entry.amountCents, 0);
  if (total !== 0) throw new Error(`wallet: unbalanced journal transaction (${total} cents)`);
};

export const sellerFee = (grossCents: Cents, bps: number) => {
  cents(grossCents, "gross");
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("wallet: fee basis points must be 0..10000");
  const feeCents = Math.ceil((grossCents * bps) / 10_000);
  return { grossCents, feeCents, sellerNetCents: grossCents - feeCents };
};

export const formatWalletMoney = (amountCents: Cents, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountCents / 100);

export const createWallet = (store: WalletStore, policy: WalletPolicy = steamLikeWalletPolicy) => ({
  policy,
  store,

  createAccount: async (ownerId: string, id = `wallet:${ownerId}`) => store.createAccount({ id, ownerId, currency: policy.currency, status: "active", createdAt: new Date().toISOString() }),
  snapshot: (accountId: string) => store.snapshot(accountId),
  history: (accountId: string, limit?: number) => store.history(accountId, limit),
  listAccounts: (input: { limit: number; prefix?: string }) => store.listAccounts(input),

  async fund(input: { accountId: string; clearingAccountId: string; amountCents: Cents; idempotencyKey: string; paymentRef: string }) {
    const retry = await store.transactionByIdempotencyKey(input.idempotencyKey);
    if (retry) return retry;
    if (cents(input.amountCents) < policy.minimumFundingCents) throw new Error("wallet: funding is below the configured minimum");
    const current = await store.snapshot(input.accountId);
    if (!current) throw new Error("wallet: account not found");
    if (current.balanceCents + input.amountCents > policy.maximumBalanceCents) throw new Error("wallet: maximum balance would be exceeded");
    return store.commit({ idempotencyKey: input.idempotencyKey, kind: "funding", metadata: { paymentRef: input.paymentRef }, entries: [
      { accountId: input.accountId, amountCents: input.amountCents },
      { accountId: input.clearingAccountId, amountCents: -input.amountCents },
    ] });
  },

  async applyFundingEvent(input: WalletFundingEvent) {
    cents(input.amountCents, "funding event amount");
    if (input.amountCents === 0)
      throw new Error("wallet: funding event amount must be positive");
    if (input.kind === "funding") {
      if (input.amountCents < policy.minimumFundingCents)
        throw new Error("wallet: funding is below the configured minimum");
      const current = await store.snapshot(input.accountId);
      if (!current) throw new Error("wallet: account not found");
      if (current.balanceCents + input.amountCents > policy.maximumBalanceCents)
        throw new Error("wallet: maximum balance would be exceeded");
    }
    return store.applyFundingEvent(input);
  },

  reviewAccountStatus: (accountId: string, status: "active" | "frozen") =>
    store.reviewAccountStatus({ accountId, status }),

  async reserve(input: { accountId: string; amountCents: Cents; idempotencyKey: string; purpose: string; expiresAt?: string | null }) {
    if (cents(input.amountCents) === 0) throw new Error("wallet: reservation must be positive");
    return store.reserve({ ...input, expiresAt: input.expiresAt ?? null });
  },

  async settleSale(input: { buyerAccountId: string; sellerAccountId: string; revenueAccountId: string; grossCents: Cents; idempotencyKey: string; assetId: string; reservationId?: string }) {
    const retry = await store.transactionByIdempotencyKey(input.idempotencyKey);
    if (retry) return retry;
    if (input.grossCents > policy.maximumTransactionCents) throw new Error("wallet: maximum transaction would be exceeded");
    const fee = sellerFee(input.grossCents, policy.sellerFeeBps);
    const seller = await store.snapshot(input.sellerAccountId);
    if (!seller) throw new Error("wallet: seller account not found");
    if (seller.balanceCents + fee.sellerNetCents > policy.maximumBalanceCents) throw new Error("wallet: seller maximum balance would be exceeded");
    if (input.reservationId) {
      const reservation = await store.reservation(input.reservationId);
      if (!reservation || reservation.status !== "active" || reservation.accountId !== input.buyerAccountId || reservation.amountCents !== input.grossCents) throw new Error("wallet: reservation does not exactly cover this buyer and sale");
    }
    return store.commit({ idempotencyKey: input.idempotencyKey, kind: "sale", metadata: { assetId: input.assetId }, ...(input.reservationId ? { captures: [input.reservationId] } : {}), entries: [
      { accountId: input.buyerAccountId, amountCents: -fee.grossCents },
      { accountId: input.sellerAccountId, amountCents: fee.sellerNetCents },
      { accountId: input.revenueAccountId, amountCents: fee.feeCents },
    ] });
  },

  async captureExternalSpend(input: { accountId: string; clearingAccountId: string; amountCents: Cents; idempotencyKey: string; paymentRef: string; provider: string; reservationId: string }) {
    cents(input.amountCents, "external spend");
    if (input.amountCents === 0) throw new Error("wallet: external spend must be positive");
    if (input.amountCents > policy.maximumTransactionCents) throw new Error("wallet: maximum transaction would be exceeded");
    const expectedEntries = [
      { accountId: input.accountId, amountCents: -input.amountCents },
      { accountId: input.clearingAccountId, amountCents: input.amountCents },
    ];
    const retry = await store.transactionByIdempotencyKey(input.idempotencyKey);
    if (retry) {
      if (
        retry.kind !== "purchase" ||
        retry.metadata.paymentRef !== input.paymentRef ||
        retry.metadata.provider !== input.provider ||
        JSON.stringify(retry.entries) !== JSON.stringify(expectedEntries)
      )
        throw new Error("wallet: external spend idempotency key was reused with different input");
      return retry;
    }
    const reservation = await store.reservation(input.reservationId);
    if (!reservation || reservation.status !== "active" || reservation.accountId !== input.accountId || reservation.amountCents !== input.amountCents)
      throw new Error("wallet: reservation does not exactly cover this external spend");
    return store.commit({
      captures: [input.reservationId],
      entries: expectedEntries,
      idempotencyKey: input.idempotencyKey,
      kind: "purchase",
      metadata: { paymentRef: input.paymentRef, provider: input.provider },
    });
  },

  async refundExternalSpend(input: { accountId: string; clearingAccountId: string; amountCents: Cents; idempotencyKey: string; originalPurchaseId: string; paymentRef: string; provider: string }) {
    cents(input.amountCents, "external refund");
    if (input.amountCents === 0) throw new Error("wallet: external refund must be positive");
    const expectedEntries = [
      { accountId: input.accountId, amountCents: input.amountCents },
      { accountId: input.clearingAccountId, amountCents: -input.amountCents },
    ];
    const retry = await store.transactionByIdempotencyKey(input.idempotencyKey);
    if (retry) {
      if (
        retry.kind !== "refund" ||
        retry.metadata.originalPurchaseId !== input.originalPurchaseId ||
        retry.metadata.paymentRef !== input.paymentRef ||
        retry.metadata.provider !== input.provider ||
        JSON.stringify(retry.entries) !== JSON.stringify(expectedEntries)
      )
        throw new Error("wallet: external refund idempotency key was reused with different input");
      return retry;
    }
    return store.commit({
      entries: expectedEntries,
      idempotencyKey: input.idempotencyKey,
      kind: "refund",
      metadata: {
        originalPurchaseId: input.originalPurchaseId,
        paymentRef: input.paymentRef,
        provider: input.provider,
      },
    });
  },

  async chargeTradeFees(input: { accountIds: string[]; revenueAccountId: string; idempotencyKey: string; tradeId: string }) {
    const retry = await store.transactionByIdempotencyKey(input.idempotencyKey);
    if (retry) return retry;
    if (input.accountIds.length === 0) throw new Error("wallet: trade needs at least one paying participant");
    if (new Set(input.accountIds).size !== input.accountIds.length) throw new Error("wallet: each trade participant may be charged only once");
    const total = policy.tradeFeeCents * input.accountIds.length;
    return store.commit({ idempotencyKey: input.idempotencyKey, kind: "trade-fee", metadata: { tradeId: input.tradeId }, entries: [
      ...input.accountIds.map((accountId) => ({ accountId, amountCents: -policy.tradeFeeCents })),
      { accountId: input.revenueAccountId, amountCents: total },
    ] });
  },

  async refundSale(input: { buyerAccountId: string; sellerAccountId: string; revenueAccountId: string; grossCents: Cents; idempotencyKey: string; originalSaleId: string }) {
    const retry = await store.transactionByIdempotencyKey(input.idempotencyKey);
    if (retry) return retry;
    const fee = sellerFee(input.grossCents, policy.sellerFeeBps);
    return store.commit({ idempotencyKey: input.idempotencyKey, kind: "refund", metadata: { originalSaleId: input.originalSaleId }, entries: [
      { accountId: input.buyerAccountId, amountCents: fee.grossCents },
      { accountId: input.sellerAccountId, amountCents: -fee.sellerNetCents },
      { accountId: input.revenueAccountId, amountCents: -fee.feeCents },
    ] });
  },
});

export type Wallet = ReturnType<typeof createWallet>;
