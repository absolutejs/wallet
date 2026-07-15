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
