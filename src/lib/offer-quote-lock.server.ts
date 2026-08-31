/**
 * OFFER QUOTE LOCK — the offers that were really QUOTED to the customer.
 *
 * Rules enforced here (see db/2026-09-07_offer_quote_lock.sql):
 *  1. An offer is locked at the exact moment the deterministic engine priced it
 *     for the customer (`calculate_offer_price`). Liveness is judged THEN.
 *  2. `create_order` prices the order with the LOCKED offers only, so a quoted
 *     discount survives the offer ending between the quote and the order, and a
 *     discount that was never quoted can never appear on the order.
 *  3. Once the order exists, its own `applied_offer_ids` are the truth: the
 *     discount is never re-evaluated afterwards (payment confirmation included).
 *
 * Server-only (service-role client).
 */
import { mapOfferRow, type OfferRow } from "@/lib/offers.server";

/** Union of two id lists, order preserved, blanks dropped. */
export function mergeOfferIds(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      const id = String(v ?? "").trim();
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * Which offers may price a basket.
 * Locked ids present → those offers ONLY (even if no longer live).
 * No lock at all → the live offers, i.e. today's behaviour.
 */
export function pricingOffers(opts: {
  lockedIds: string[];
  lockedOffers: OfferRow[];
  liveOffers: OfferRow[];
}): OfferRow[] {
  if (!opts.lockedIds.length) return opts.liveOffers;
  const byId = new Map(opts.lockedOffers.map((o) => [String(o.id), o]));
  return opts.lockedIds.map((id) => byId.get(id)).filter(Boolean) as OfferRow[];
}

/** Records the offers that were just quoted to this conversation. */
export async function lockQuotedOffers(
  admin: any,
  opts: {
    conversationId: string | null | undefined;
    merchantId?: string | null;
    offers: Array<{ offer_id: string; discount_amount?: number }>;
  },
): Promise<void> {
  const conversationId = opts.conversationId ? String(opts.conversationId) : "";
  const rows = (opts.offers ?? []).filter((o) => o?.offer_id);
  if (!conversationId || !rows.length) return;
  try {
    await admin.from("offer_quotes").upsert(
      rows.map((o) => ({
        conversation_id: conversationId,
        merchant_id: opts.merchantId ?? null,
        offer_id: String(o.offer_id),
        discount_amount: o.discount_amount ?? null,
      })),
      { onConflict: "conversation_id,offer_id" },
    );
  } catch {
    /* the lock table may not exist yet — pricing then falls back to live offers */
  }
}

/** Offer ids locked for this conversation. */
export async function lockedOfferIds(
  admin: any,
  conversationId: string | null | undefined,
): Promise<string[]> {
  if (!conversationId) return [];
  try {
    const { data } = await admin
      .from("offer_quotes")
      .select("offer_id")
      .eq("conversation_id", String(conversationId));
    return mergeOfferIds((data ?? []).map((r: any) => r.offer_id), []);
  } catch {
    return [];
  }
}

/** Loads offer rows by id, regardless of whether they are still live. */
export async function offersByIds(admin: any, ids: string[]): Promise<OfferRow[]> {
  const wanted = mergeOfferIds(ids, []);
  if (!wanted.length) return [];
  try {
    const { data } = await admin.from("offers").select("*").in("id", wanted);
    return ((data ?? []) as Record<string, unknown>[]).map(mapOfferRow);
  } catch {
    return [];
  }
}

/**
 * The offer set that must price an order right now.
 * An EXISTING order keeps the offers it was created with (its own
 * `applied_offer_ids`), plus anything newly quoted for the same conversation.
 */
export async function offersForOrderPricing(
  admin: any,
  opts: {
    conversationId: string | null | undefined;
    liveOffers: OfferRow[];
    existingOrder?: Record<string, unknown> | null;
  },
): Promise<OfferRow[]> {
  const locked = await lockedOfferIds(admin, opts.conversationId);
  const already = Array.isArray(opts.existingOrder?.applied_offer_ids)
    ? (opts.existingOrder!.applied_offer_ids as unknown[])
    : [];
  const ids = mergeOfferIds(already, locked);
  if (!ids.length) return opts.liveOffers;
  const rows = await offersByIds(admin, ids);
  return pricingOffers({ lockedIds: ids, lockedOffers: rows, liveOffers: opts.liveOffers });
}
