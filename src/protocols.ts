import type {
  AgentAllowance,
  AgentSpendRequest,
  SpendMandate,
} from "./allowances";

/** Structural AP2 intent mandate adapter. AP2 remains isolated from core types. */
export const toAp2IntentMandate = (
  allowance: AgentAllowance,
  request: AgentSpendRequest,
) => ({
  constraints: {
    allowed_categories: allowance.allowedCategories,
    allowed_merchants: allowance.allowedMerchants,
    currency: allowance.currency,
    expires_at: request.expiresAt,
    maximum_amount_minor: Math.min(
      allowance.perTransactionLimitCents,
      request.amountCents,
    ),
  },
  mandate_id: request.idempotencyKey,
  type: "intent_mandate",
});

/** Structural AP2 payment mandate adapter with tamper-evident proof. */
export const toAp2PaymentMandate = (mandate: SpendMandate) => ({
  mandate_id: mandate.mandateId,
  payment_details: {
    amount_minor: mandate.amountCents,
    cart_hash: mandate.cartHash,
    currency: mandate.currency,
    merchant_id: mandate.merchantId,
  },
  proof: {
    digest: mandate.bindingDigest,
    signature: mandate.signature,
  },
  type: "payment_mandate",
});

/** UCP extension payload referencing the same host-enforced spend mandate. */
export const toUcpSpendMandateExtension = (mandate: SpendMandate) => ({
  "com.absolutejs.spend_mandate": {
    amount_minor: mandate.amountCents,
    currency: mandate.currency,
    expires_at: mandate.expiresAt,
    mandate_id: mandate.mandateId,
    merchant_id: mandate.merchantId,
    proof: mandate.signature,
  },
});
