import { describe, expect, test } from "bun:test";
import { createMemoryWalletStore, createWallet, walletPostgresSchemaSql } from "../src";

const setup = async () => {
  const store = createMemoryWalletStore();
  const wallet = createWallet(store);
  await wallet.createAccount("buyer");
  await wallet.createAccount("seller");
  await store.createAccount({ id: "platform:clearing", ownerId: null, currency: "USD", status: "active", allowNegative: true, createdAt: new Date().toISOString() });
  await store.createAccount({ id: "platform:revenue", ownerId: null, currency: "USD", status: "active", createdAt: new Date().toISOString() });
  return { store, wallet };
};

describe("double-entry wallet", () => {
  test("funding is idempotent and enforces the $5 minimum", async () => {
    const { wallet } = await setup();
    await expect(wallet.fund({ accountId: "wallet:buyer", clearingAccountId: "platform:clearing", amountCents: 499, idempotencyKey: "bad", paymentRef: "pi_bad" })).rejects.toThrow(/minimum/);
    const input = { accountId: "wallet:buyer", clearingAccountId: "platform:clearing", amountCents: 1_000, idempotencyKey: "pi_1", paymentRef: "pi_1" };
    const first = await wallet.fund(input), retry = await wallet.fund(input);
    expect(retry.id).toBe(first.id);
    expect((await wallet.snapshot("wallet:buyer"))?.balanceCents).toBe(1_000);
  });

  test("applies provider reversals atomically and freezes liabilities", async () => {
    const { wallet } = await setup();
    const funding = {
      accountId: "wallet:buyer",
      amountCents: 1_000,
      clearingAccountId: "platform:clearing",
      idempotencyKey: "stripe:fund:1",
      kind: "funding" as const,
      paymentRef: "pi_1",
    };
    const first = await wallet.applyFundingEvent(funding);
    const retry = await wallet.applyFundingEvent(funding);
    expect(retry.transaction.id).toBe(first.transaction.id);
    await wallet.applyFundingEvent({
      ...funding,
      amountCents: 1_500,
      idempotencyKey: "stripe:dispute:1",
      kind: "dispute",
      paymentRef: "dp_1",
    });
    const liable = await wallet.snapshot("wallet:buyer");
    expect(liable).toMatchObject({ balanceCents: -500, status: "frozen" });
    await expect(wallet.reviewAccountStatus("wallet:buyer", "active")).rejects.toThrow(/negative/);
    await wallet.applyFundingEvent({
      ...funding,
      amountCents: 1_500,
      idempotencyKey: "stripe:dispute:1:won",
      kind: "dispute-reversal",
      paymentRef: "dp_1",
    });
    expect(await wallet.reviewAccountStatus("wallet:buyer", "active")).toMatchObject({ balanceCents: 1_000, status: "active" });
  });

  test("rejects changed input under a provider idempotency key", async () => {
    const { wallet } = await setup();
    const input = {
      accountId: "wallet:buyer",
      amountCents: 1_000,
      clearingAccountId: "platform:clearing",
      idempotencyKey: "stripe:fund:bound",
      kind: "funding" as const,
      paymentRef: "pi_bound",
    };
    await wallet.applyFundingEvent(input);
    await expect(wallet.applyFundingEvent({ ...input, amountCents: 1_001 })).rejects.toThrow(/different input/);
  });

  test("lists funded accounts independently of agent allowances", async () => {
    const { wallet } = await setup();
    expect(await wallet.listAccounts({ limit: 10, prefix: "wallet:" })).toHaveLength(2);
    expect(await wallet.listAccounts({ limit: 10, prefix: "missing:" })).toHaveLength(0);
  });

  test("seller-paid 10% sale captures a reserved bid atomically", async () => {
    const { wallet } = await setup();
    await wallet.fund({ accountId: "wallet:buyer", clearingAccountId: "platform:clearing", amountCents: 1_000, idempotencyKey: "fund", paymentRef: "pi" });
    const bid = await wallet.reserve({ accountId: "wallet:buyer", amountCents: 1_000, idempotencyKey: "bid", purpose: "auction:a" });
    expect((await wallet.snapshot("wallet:buyer"))?.availableCents).toBe(0);
    await wallet.settleSale({ buyerAccountId: "wallet:buyer", sellerAccountId: "wallet:seller", revenueAccountId: "platform:revenue", grossCents: 1_000, idempotencyKey: "sale", assetId: "pet:1", reservationId: bid.id });
    expect((await wallet.snapshot("wallet:buyer"))?.balanceCents).toBe(0);
    expect((await wallet.snapshot("wallet:seller"))?.balanceCents).toBe(900);
    expect((await wallet.snapshot("platform:revenue"))?.balanceCents).toBe(100);
  });

  test("a reservation cannot authorize a different amount", async () => {
    const { wallet } = await setup();
    await wallet.fund({ accountId: "wallet:buyer", clearingAccountId: "platform:clearing", amountCents: 1_000, idempotencyKey: "fund-mismatch", paymentRef: "pi" });
    const bid = await wallet.reserve({ accountId: "wallet:buyer", amountCents: 500, idempotencyKey: "bid-mismatch", purpose: "offer" });
    await expect(wallet.settleSale({ buyerAccountId: "wallet:buyer", sellerAccountId: "wallet:seller", revenueAccountId: "platform:revenue", grossCents: 600, idempotencyKey: "sale-mismatch", assetId: "pet:x", reservationId: bid.id })).rejects.toThrow(/exactly cover/);
  });

  test("captures and refunds an external spend with exact replay binding", async () => {
    const { wallet } = await setup();
    await wallet.fund({ accountId: "wallet:buyer", clearingAccountId: "platform:clearing", amountCents: 1_000, idempotencyKey: "external-fund", paymentRef: "pi" });
    const reservation = await wallet.reserve({ accountId: "wallet:buyer", amountCents: 400, idempotencyKey: "external-reserve", purpose: "provider:effect-1" });
    const purchase = await wallet.captureExternalSpend({ accountId: "wallet:buyer", clearingAccountId: "platform:clearing", amountCents: 400, idempotencyKey: "external-capture", paymentRef: "provider-resource-1", provider: "provider.example", reservationId: reservation.id });
    expect((await wallet.captureExternalSpend({ accountId: "wallet:buyer", clearingAccountId: "platform:clearing", amountCents: 400, idempotencyKey: "external-capture", paymentRef: "provider-resource-1", provider: "provider.example", reservationId: reservation.id })).id).toBe(purchase.id);
    await expect(wallet.captureExternalSpend({ accountId: "wallet:buyer", clearingAccountId: "platform:clearing", amountCents: 400, idempotencyKey: "external-capture", paymentRef: "changed", provider: "provider.example", reservationId: reservation.id })).rejects.toThrow(/different input/);
    const refund = await wallet.refundExternalSpend({ accountId: "wallet:buyer", clearingAccountId: "platform:clearing", amountCents: 400, idempotencyKey: "external-refund", originalPurchaseId: purchase.id, paymentRef: "provider-refund-1", provider: "provider.example" });
    expect((await wallet.refundExternalSpend({ accountId: "wallet:buyer", clearingAccountId: "platform:clearing", amountCents: 400, idempotencyKey: "external-refund", originalPurchaseId: purchase.id, paymentRef: "provider-refund-1", provider: "provider.example" })).id).toBe(refund.id);
    expect((await wallet.snapshot("wallet:buyer"))?.balanceCents).toBe(1_000);
  });

  test("a guaranteed trade charges each participant exactly 25 cents", async () => {
    const { wallet } = await setup();
    for (const owner of ["buyer", "seller"]) await wallet.fund({ accountId: `wallet:${owner}`, clearingAccountId: "platform:clearing", amountCents: 500, idempotencyKey: `fund:${owner}`, paymentRef: owner });
    await wallet.chargeTradeFees({ accountIds: ["wallet:buyer", "wallet:seller"], revenueAccountId: "platform:revenue", idempotencyKey: "trade", tradeId: "t1" });
    expect((await wallet.snapshot("wallet:buyer"))?.balanceCents).toBe(475);
    expect((await wallet.snapshot("wallet:seller"))?.balanceCents).toBe(475);
    expect((await wallet.snapshot("platform:revenue"))?.balanceCents).toBe(50);
    await expect(wallet.chargeTradeFees({ accountIds: ["wallet:buyer", "wallet:buyer"], revenueAccountId: "platform:revenue", idempotencyKey: "bad-trade", tradeId: "t2" })).rejects.toThrow(/only once/);
  });
});

test("PostgreSQL schema enforces a balanced journal", () => {
  const sql = walletPostgresSchemaSql("renown_wallet");
  expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
  expect(sql).toContain("SUM(amount_cents)");
  expect(() => walletPostgresSchemaSql("bad; DROP TABLE pets")).toThrow(/identifier/);
});
