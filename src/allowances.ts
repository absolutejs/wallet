import {
  digest,
  type ActionDecision,
  type Agency,
  type AgentActor,
} from "@absolutejs/agency";
import type { Wallet, WalletTransaction } from "./core";

export type AgentAllowanceStatus = "active" | "paused" | "revoked";

export type AgentAllowance = {
  accountId: string;
  agentId: string;
  allowanceId: string;
  allowedActions?: string[];
  allowedCategories?: string[];
  allowedMerchants?: string[];
  autoApproveUpToCents: number;
  currency: string;
  dailyLimitCents: number;
  lifetimeLimitCents?: number;
  maximumOpenReservations: number;
  ownerId: string;
  perTransactionLimitCents: number;
  requireRefundable?: boolean;
  status: AgentAllowanceStatus;
  validFrom?: string;
  validUntil?: string;
  weeklyLimitCents: number;
};

export type AgentSpendRequest = {
  action: string;
  agentId: string;
  allowanceId: string;
  amountCents: number;
  cartHash: string;
  category?: string;
  currency: string;
  expiresAt: string;
  idempotencyKey: string;
  merchantId: string;
  refundable?: boolean;
};

export type SpendMandateStatus =
  | "active"
  | "cancelled"
  | "captured"
  | "expired"
  | "pending_approval"
  | "refunded";

export type SpendMandate = AgentSpendRequest & {
  agencyActionId?: string;
  allowanceId: string;
  bindingDigest: string;
  capturedTransactionId?: string;
  createdAt: string;
  mandateId: string;
  reservationId: string;
  signature: string;
  status: SpendMandateStatus;
};

export type AgentWalletStore = {
  allowance: (allowanceId: string) => Promise<AgentAllowance | null>;
  mandate: (mandateId: string) => Promise<SpendMandate | null>;
  mandateByIdempotencyKey: (
    allowanceId: string,
    key: string,
  ) => Promise<SpendMandate | null>;
  mandatesForAllowance: (allowanceId: string) => Promise<SpendMandate[]>;
  saveAllowance: (allowance: AgentAllowance) => Promise<void>;
  saveMandate: (mandate: SpendMandate) => Promise<void>;
  /** Serialize cap checks and mandate creation for one allowance. Production
   *  stores implement this with a row/advisory lock in a transaction. */
  withAllowanceLock: <Value>(
    allowanceId: string,
    run: () => Promise<Value>,
  ) => Promise<Value>;
};

export type SpendMandateSigner = {
  sign: (bindingDigest: string) => Promise<string>;
  verify: (bindingDigest: string, signature: string) => Promise<boolean>;
};

export type AgentWalletAgency = {
  actor: (request: AgentSpendRequest) => Promise<AgentActor> | AgentActor;
  enforcement: Agency;
};

export type AgentWalletOptions = {
  agency?: AgentWalletAgency;
  now?: () => Date;
  resolveMerchantAccount: (merchantId: string) => Promise<string> | string;
  revenueAccountId: string;
  signer: SpendMandateSigner;
  store: AgentWalletStore;
  wallet: Wallet;
};

const terminalSpend = new Set<SpendMandateStatus>([
  "cancelled",
  "expired",
  "refunded",
]);

const mandateBinding = (input: AgentSpendRequest & { reservationId: string }) =>
  digest({
    action: input.action,
    agentId: input.agentId,
    allowanceId: input.allowanceId,
    amountCents: input.amountCents,
    cartHash: input.cartHash,
    category: input.category,
    currency: input.currency,
    expiresAt: input.expiresAt,
    merchantId: input.merchantId,
    reservationId: input.reservationId,
  });

const sumSince = (mandates: SpendMandate[], since: number) =>
  mandates
    .filter(
      (mandate) =>
        !terminalSpend.has(mandate.status) &&
        new Date(mandate.createdAt).getTime() >= since,
    )
    .reduce((sum, mandate) => sum + mandate.amountCents, 0);

const requireAllowed = (
  allowance: AgentAllowance,
  request: AgentSpendRequest,
  mandates: SpendMandate[],
  now: Date,
) => {
  if (allowance.status !== "active")
    throw new Error("wallet: allowance is not active");
  if (allowance.agentId !== request.agentId)
    throw new Error("wallet: allowance belongs to another agent");
  if (allowance.currency !== request.currency)
    throw new Error("wallet: allowance currency mismatch");
  if (allowance.validFrom && new Date(allowance.validFrom) > now)
    throw new Error("wallet: allowance is not valid yet");
  if (allowance.validUntil && new Date(allowance.validUntil) <= now)
    throw new Error("wallet: allowance has expired");
  if (new Date(request.expiresAt) <= now)
    throw new Error("wallet: spend request has expired");
  if (request.amountCents <= 0 || !Number.isSafeInteger(request.amountCents))
    throw new Error("wallet: spend must be positive integer cents");
  if (request.amountCents > allowance.perTransactionLimitCents)
    throw new Error("wallet: per-transaction allowance exceeded");
  if (
    allowance.allowedMerchants &&
    !allowance.allowedMerchants.includes(request.merchantId)
  )
    throw new Error("wallet: merchant is not allowed");
  if (
    allowance.allowedCategories &&
    (!request.category ||
      !allowance.allowedCategories.includes(request.category))
  )
    throw new Error("wallet: category is not allowed");
  if (
    allowance.allowedActions &&
    !allowance.allowedActions.includes(request.action)
  )
    throw new Error("wallet: action is not allowed");
  if (allowance.requireRefundable && request.refundable !== true)
    throw new Error("wallet: purchase must be refundable");
  const currentTime = now.getTime();
  if (
    sumSince(mandates, currentTime - 86_400_000) + request.amountCents >
    allowance.dailyLimitCents
  )
    throw new Error("wallet: daily allowance exceeded");
  if (
    sumSince(mandates, currentTime - 604_800_000) + request.amountCents >
    allowance.weeklyLimitCents
  )
    throw new Error("wallet: weekly allowance exceeded");
  if (
    allowance.lifetimeLimitCents !== undefined &&
    sumSince(mandates, 0) + request.amountCents > allowance.lifetimeLimitCents
  )
    throw new Error("wallet: lifetime allowance exceeded");
  const open = mandates.filter(
    (mandate) =>
      mandate.status === "active" || mandate.status === "pending_approval",
  ).length;
  if (open >= allowance.maximumOpenReservations)
    throw new Error("wallet: too many open agent reservations");
};

export const createMemoryAgentWalletStore = (): AgentWalletStore => {
  const allowances = new Map<string, AgentAllowance>();
  const mandates = new Map<string, SpendMandate>();
  const tails = new Map<string, Promise<void>>();

  return {
    allowance: async (allowanceId) => allowances.get(allowanceId) ?? null,
    mandate: async (mandateId) => mandates.get(mandateId) ?? null,
    mandateByIdempotencyKey: async (allowanceId, key) =>
      [...mandates.values()].find(
        (mandate) =>
          mandate.allowanceId === allowanceId && mandate.idempotencyKey === key,
      ) ?? null,
    mandatesForAllowance: async (allowanceId) =>
      [...mandates.values()].filter(
        (mandate) => mandate.allowanceId === allowanceId,
      ),
    saveAllowance: async (allowance) => {
      allowances.set(allowance.allowanceId, structuredClone(allowance));
    },
    saveMandate: async (mandate) => {
      mandates.set(mandate.mandateId, structuredClone(mandate));
    },
    withAllowanceLock: async (allowanceId, run) => {
      const previous = tails.get(allowanceId) ?? Promise.resolve();
      let release = () => {};
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(
        allowanceId,
        previous.then(() => next),
      );
      await previous;
      try {
        return await run();
      } finally {
        release();
      }
    },
  };
};

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const fromBase64Url = (value: string) => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");

  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

export const createHmacSpendMandateSigner = (
  secret: Uint8Array,
): SpendMandateSigner => {
  const key = crypto.subtle.importKey(
    "raw",
    new Uint8Array(secret).buffer,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );

  return {
    sign: async (bindingDigest) => {
      const signature = await crypto.subtle.sign(
        "HMAC",
        await key,
        new TextEncoder().encode(bindingDigest),
      );

      return base64Url(new Uint8Array(signature));
    },
    verify: async (bindingDigest, signature) => {
      try {
        return await crypto.subtle.verify(
          "HMAC",
          await key,
          fromBase64Url(signature),
          new TextEncoder().encode(bindingDigest),
        );
      } catch {
        return false;
      }
    },
  };
};

export type SpendRequestResult = {
  decision?: ActionDecision;
  mandate: SpendMandate;
};

export const createAgentWallet = ({
  agency,
  now = () => new Date(),
  resolveMerchantAccount,
  revenueAccountId,
  signer,
  store,
  wallet,
}: AgentWalletOptions) => {
  const quoteSpend = async (request: AgentSpendRequest) => {
    const allowance = await store.allowance(request.allowanceId);
    if (!allowance) throw new Error("wallet: allowance not found");
    const mandates = await store.mandatesForAllowance(request.allowanceId);
    requireAllowed(allowance, request, mandates, now());

    return {
      allowanceId: allowance.allowanceId,
      amountCents: request.amountCents,
      autoApproved: request.amountCents <= allowance.autoApproveUpToCents,
      currency: request.currency,
      requiresApproval: request.amountCents > allowance.autoApproveUpToCents,
    };
  };

  const requestSpendUnlocked = async (
    request: AgentSpendRequest,
  ): Promise<SpendRequestResult> => {
    const retry = await store.mandateByIdempotencyKey(
      request.allowanceId,
      request.idempotencyKey,
    );
    if (retry) return { mandate: retry };
    const allowance = await store.allowance(request.allowanceId);
    if (!allowance) throw new Error("wallet: allowance not found");
    const mandates = await store.mandatesForAllowance(request.allowanceId);
    requireAllowed(allowance, request, mandates, now());
    const reservation = await wallet.reserve({
      accountId: allowance.accountId,
      amountCents: request.amountCents,
      expiresAt: request.expiresAt,
      idempotencyKey: `agent:${request.idempotencyKey}`,
      purpose: `agent:${request.agentId}:${request.merchantId}:${request.cartHash}`,
    });
    try {
      const bindingDigest = await mandateBinding({
        ...request,
        reservationId: reservation.id,
      });
      const mandate: SpendMandate = {
        ...request,
        bindingDigest,
        createdAt: now().toISOString(),
        mandateId: `mandate:${crypto.randomUUID()}`,
        reservationId: reservation.id,
        signature: await signer.sign(bindingDigest),
        status: "active",
      };
      if (request.amountCents > allowance.autoApproveUpToCents) {
        if (!agency) {
          throw new Error("wallet: agency approval is not configured");
        }
        const requested = await agency.enforcement.request({
          action: "wallet.spend",
          actor: await agency.actor(request),
          effects: ["purchase", "transfer", "external-network"],
          expiresAt: new Date(request.expiresAt).getTime(),
          idempotencyKey: request.idempotencyKey,
          input: {
            cartHash: request.cartHash,
            category: request.category,
            merchantId: request.merchantId,
            refundable: request.refundable,
          },
          resource: { id: request.merchantId, type: "merchant" },
          spend: {
            amountMinor: request.amountCents,
            currency: request.currency,
          },
        });
        mandate.agencyActionId = requested.action.actionId;
        if (
          requested.decision.kind === "deny" &&
          !requested.decision.requestable
        ) {
          throw new Error(
            `wallet: spend denied (${requested.decision.reason})`,
          );
        }
        mandate.status =
          requested.decision.kind === "allow" ? "active" : "pending_approval";
        await store.saveMandate(mandate);

        return { decision: requested.decision, mandate };
      }
      await store.saveMandate(mandate);

      return { mandate };
    } catch (error) {
      await wallet.store.release(reservation.id);
      throw error;
    }
  };

  const requestSpend = (request: AgentSpendRequest) =>
    store.withAllowanceLock(request.allowanceId, () =>
      requestSpendUnlocked(request),
    );

  const loadValidMandate = async (mandateId: string) => {
    const mandate = await store.mandate(mandateId);
    if (!mandate) throw new Error("wallet: spend mandate not found");
    if (!["active", "pending_approval"].includes(mandate.status))
      throw new Error("wallet: spend mandate is not active");
    if (new Date(mandate.expiresAt) <= now())
      throw new Error("wallet: spend mandate has expired");
    const expected = await mandateBinding(mandate);
    if (
      expected !== mandate.bindingDigest ||
      !(await signer.verify(expected, mandate.signature))
    )
      throw new Error("wallet: invalid spend mandate signature");

    return mandate;
  };

  const captureSpend = async (input: {
    amountCents: number;
    assetId: string;
    cartHash: string;
    currency: string;
    mandateId: string;
    merchantId: string;
  }) => {
    const mandate = await loadValidMandate(input.mandateId);
    if (
      input.amountCents !== mandate.amountCents ||
      input.cartHash !== mandate.cartHash ||
      input.currency !== mandate.currency ||
      input.merchantId !== mandate.merchantId
    ) {
      throw new Error(
        "wallet: capture does not exactly match the spend mandate",
      );
    }
    const allowance = await store.allowance(mandate.allowanceId);
    if (!allowance) throw new Error("wallet: allowance not found");
    const sellerAccountId = await resolveMerchantAccount(mandate.merchantId);
    const executeSettlement = () =>
      wallet.settleSale({
        assetId: input.assetId,
        buyerAccountId: allowance.accountId,
        grossCents: mandate.amountCents,
        idempotencyKey: `capture:${mandate.idempotencyKey}`,
        reservationId: mandate.reservationId,
        revenueAccountId,
        sellerAccountId,
      });
    let transaction: WalletTransaction;
    if (mandate.agencyActionId) {
      if (!agency) throw new Error("wallet: agency approval is not configured");
      const lease = await agency.enforcement.issueLease(mandate.agencyActionId);
      transaction = (
        await agency.enforcement.execute({
          executor: `wallet:${mandate.merchantId}`,
          leaseId: lease.leaseId,
          run: executeSettlement,
        })
      ).result;
    } else {
      transaction = await executeSettlement();
    }
    const captured = {
      ...mandate,
      capturedTransactionId: transaction.id,
      status: "captured" as const,
    };
    await store.saveMandate(captured);

    return { mandate: captured, transaction };
  };

  const cancelSpend = async (mandateId: string) => {
    const mandate = await loadValidMandate(mandateId);
    const reservation = await wallet.store.release(mandate.reservationId);
    const cancelled = { ...mandate, status: "cancelled" as const };
    await store.saveMandate(cancelled);

    return { mandate: cancelled, reservation };
  };

  const refundSpend = async (mandateId: string) => {
    const mandate = await store.mandate(mandateId);
    if (
      !mandate ||
      mandate.status !== "captured" ||
      !mandate.capturedTransactionId
    )
      throw new Error("wallet: mandate is not captured");
    const allowance = await store.allowance(mandate.allowanceId);
    if (!allowance) throw new Error("wallet: allowance not found");
    const transaction = await wallet.refundSale({
      buyerAccountId: allowance.accountId,
      grossCents: mandate.amountCents,
      idempotencyKey: `refund:${mandate.idempotencyKey}`,
      originalSaleId: mandate.capturedTransactionId,
      revenueAccountId,
      sellerAccountId: await resolveMerchantAccount(mandate.merchantId),
    });
    const refunded = { ...mandate, status: "refunded" as const };
    await store.saveMandate(refunded);

    return { mandate: refunded, transaction };
  };

  return {
    cancelSpend,
    captureSpend,
    quoteSpend,
    refundSpend,
    requestSpend,
    store,
    wallet,
  };
};

export type AgentWallet = ReturnType<typeof createAgentWallet>;
