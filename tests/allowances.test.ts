import { describe, expect, test } from "bun:test";
import {
  createAgency,
  createMemoryAgencyStore,
  type PolicyDecisionPoint,
} from "@absolutejs/agency";
import {
  createAgentWallet,
  createHmacSpendMandateSigner,
  createMemoryAgentWalletStore,
  createMemoryWalletStore,
  createWallet,
  toAp2PaymentMandate,
  toUcpSpendMandateExtension,
} from "../src";

const setup = async (policy?: PolicyDecisionPoint) => {
  const walletStore = createMemoryWalletStore();
  const wallet = createWallet(walletStore);
  await wallet.createAccount("buyer");
  await wallet.createAccount("seller");
  await walletStore.createAccount({
    allowNegative: true,
    createdAt: new Date().toISOString(),
    currency: "USD",
    id: "platform:clearing",
    ownerId: null,
    status: "active",
  });
  await walletStore.createAccount({
    createdAt: new Date().toISOString(),
    currency: "USD",
    id: "platform:revenue",
    ownerId: null,
    status: "active",
  });
  await wallet.fund({
    accountId: "wallet:buyer",
    amountCents: 5_000,
    clearingAccountId: "platform:clearing",
    idempotencyKey: "fund-agent-wallet",
    paymentRef: "payment-1",
  });
  const agentStore = createMemoryAgentWalletStore();
  await agentStore.saveAllowance({
    accountId: "wallet:buyer",
    agentId: "agent-1",
    allowanceId: "allowance-1",
    allowedActions: ["purchase"],
    allowedCategories: ["software"],
    allowedMerchants: ["merchant-1"],
    autoApproveUpToCents: 500,
    currency: "USD",
    dailyLimitCents: 2_000,
    lifetimeLimitCents: 5_000,
    maximumOpenReservations: 2,
    ownerId: "buyer",
    perTransactionLimitCents: 1_500,
    requireRefundable: true,
    status: "active",
    weeklyLimitCents: 3_000,
  });
  const agency = policy
    ? createAgency({ policy, store: createMemoryAgencyStore() })
    : undefined;
  const agentWallet = createAgentWallet({
    agency:
      agency === undefined
        ? undefined
        : {
            actor: (request) => ({
              agentId: request.agentId,
              scopes: ["wallet:spend"],
              userId: "buyer",
            }),
            enforcement: agency,
          },
    signer: createHmacSpendMandateSigner(
      new TextEncoder().encode("test-signing-secret-32-bytes-long"),
    ),
    resolveMerchantAccount: () => "wallet:seller",
    revenueAccountId: "platform:revenue",
    store: agentStore,
    wallet,
  });

  return { agency, agentStore, agentWallet, wallet };
};

const request = (over: Record<string, unknown> = {}) => ({
  action: "purchase",
  agentId: "agent-1",
  allowanceId: "allowance-1",
  amountCents: 400,
  cartHash: "cart-1",
  category: "software",
  currency: "USD",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  idempotencyKey: "spend-1",
  merchantId: "merchant-1",
  refundable: true,
  ...over,
});

const capture = (mandateId: string, over: Record<string, unknown> = {}) => ({
  amountCents: 400,
  assetId: "license-1",
  cartHash: "cart-1",
  currency: "USD",
  mandateId,
  merchantId: "merchant-1",
  ...over,
});

describe("agent spend mandates", () => {
  test("reserves, exactly captures, prevents replay, and refunds", async () => {
    const { agentWallet, wallet } = await setup();
    const { mandate } = await agentWallet.requestSpend(request());
    expect(mandate.status).toBe("active");
    expect((await wallet.snapshot("wallet:buyer"))?.reservedCents).toBe(400);
    await expect(
      agentWallet.captureSpend(
        capture(mandate.mandateId, { cartHash: "other" }),
      ),
    ).rejects.toThrow(/exactly match/);
    const captured = await agentWallet.captureSpend(capture(mandate.mandateId));
    expect(captured.mandate.status).toBe("captured");
    await expect(
      agentWallet.captureSpend(capture(mandate.mandateId)),
    ).rejects.toThrow(/not active/);
    const refunded = await agentWallet.refundSpend(mandate.mandateId);
    expect(refunded.mandate.status).toBe("refunded");
    expect((await wallet.snapshot("wallet:buyer"))?.balanceCents).toBe(5_000);
  });

  test("serializes concurrent cap checks per allowance", async () => {
    const { agentStore, agentWallet } = await setup();
    const allowance = await agentStore.allowance("allowance-1");
    if (!allowance) throw new Error("missing allowance");
    await agentStore.saveAllowance({
      ...allowance,
      autoApproveUpToCents: 1_500,
    });
    const results = await Promise.allSettled([
      agentWallet.requestSpend(
        request({ amountCents: 1_200, idempotencyKey: "a" }),
      ),
      agentWallet.requestSpend(
        request({ amountCents: 1_200, idempotencyKey: "b" }),
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  test("pauses above-threshold spending for agency approval", async () => {
    const policy: PolicyDecisionPoint = {
      evaluate: ({ approval, now }) =>
        approval === undefined
          ? {
              decisionId: "approval-needed",
              evaluatedAt: now,
              kind: "deny",
              prerequisites: [
                {
                  kind: "approval",
                  prerequisiteId: "owner",
                  title: "Owner approval",
                },
              ],
              reason: "approval_required",
              requestable: true,
            }
          : {
              decisionId: "approved",
              evaluatedAt: now,
              kind: "allow",
            },
    };
    const { agency, agentWallet } = await setup(policy);
    if (!agency) throw new Error("missing agency");
    const { decision, mandate } = await agentWallet.requestSpend(
      request({ amountCents: 800, idempotencyKey: "approval-spend" }),
    );
    expect(mandate.status).toBe("pending_approval");
    expect(decision?.kind).toBe("deny");
    await expect(
      agentWallet.captureSpend(
        capture(mandate.mandateId, { amountCents: 800 }),
      ),
    ).rejects.toThrow(/denied/);
    if (!mandate.agencyActionId) throw new Error("missing action id");
    await agency.approve({
      actionId: mandate.agencyActionId,
      approvedBy: "buyer",
      approvedUntil: Date.now() + 60_000,
    });
    const captured = await agentWallet.captureSpend(
      capture(mandate.mandateId, { amountCents: 800 }),
    );
    expect(captured.mandate.status).toBe("captured");
  });

  test("rejects a tampered mandate", async () => {
    const { agentStore, agentWallet } = await setup();
    const { mandate } = await agentWallet.requestSpend(request());
    await agentStore.saveMandate({ ...mandate, merchantId: "attacker" });
    await expect(
      agentWallet.captureSpend(
        capture(mandate.mandateId, { merchantId: "attacker" }),
      ),
    ).rejects.toThrow(/signature/);
  });

  test("exports AP2 and UCP adapter payloads without coupling core state", async () => {
    const { agentWallet } = await setup();
    const { mandate } = await agentWallet.requestSpend(request());
    expect(toAp2PaymentMandate(mandate)).toMatchObject({
      payment_details: { cart_hash: "cart-1", merchant_id: "merchant-1" },
      type: "payment_mandate",
    });
    expect(
      toUcpSpendMandateExtension(mandate)["com.absolutejs.spend_mandate"],
    ).toBeDefined();
  });
});
