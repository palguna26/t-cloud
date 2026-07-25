import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { Database } from "./db.js";
import { ConflictError, ForbiddenError, NotFoundError } from "./work.js";

export async function createCheckout(
  db: Database,
  stripe: Stripe,
  userId: string,
  workspaceId: string,
  priceId: string,
  appUrl: string,
) {
  await requireAdmin(db, userId, workspaceId);
  let customerId = (await db.query<{ stripe_customer_id: string }>(`
    SELECT stripe_customer_id FROM stripe_customers WHERE workspace_id = $1
  `, [workspaceId])).rows[0]?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { termyte_workspace_id: workspaceId },
    });
    customerId = customer.id;
    await db.query(`
      INSERT INTO stripe_customers (workspace_id, stripe_customer_id)
      VALUES ($1, $2)
      ON CONFLICT (workspace_id) DO NOTHING
    `, [workspaceId, customerId]);
    customerId = (await db.query<{ stripe_customer_id: string }>(`
      SELECT stripe_customer_id FROM stripe_customers WHERE workspace_id = $1
    `, [workspaceId])).rows[0]!.stripe_customer_id;
  }
  const checkout = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: workspaceId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { metadata: { termyte_workspace_id: workspaceId } },
    success_url: new URL("/billing?checkout=success", appUrl).toString(),
    cancel_url: new URL("/billing?checkout=cancelled", appUrl).toString(),
  });
  if (!checkout.url) throw new ConflictError("Stripe did not return a checkout URL");
  return { url: checkout.url };
}

export async function createPortal(
  db: Database,
  stripe: Stripe,
  userId: string,
  workspaceId: string,
  appUrl: string,
) {
  await requireAdmin(db, userId, workspaceId);
  const customer = (await db.query<{ stripe_customer_id: string }>(`
    SELECT stripe_customer_id FROM stripe_customers WHERE workspace_id = $1
  `, [workspaceId])).rows[0];
  if (!customer) throw new NotFoundError();
  const portal = await stripe.billingPortal.sessions.create({
    customer: customer.stripe_customer_id,
    return_url: new URL("/billing", appUrl).toString(),
  });
  return { url: portal.url };
}

export async function enqueueStripeEvent(db: Database, event: Stripe.Event) {
  await db.query(`
    INSERT INTO jobs (id, kind, dedupe_key, payload_json, state)
    VALUES ($1, 'stripe_event', $2, $3, 'pending')
    ON CONFLICT (kind, dedupe_key) DO NOTHING
  `, [randomUUID(), event.id, event]);
  return { received: true };
}

export async function processStripeEvent(db: Database, event: Stripe.Event): Promise<void> {
  const object = event.data.object as unknown as Record<string, unknown>;
  const customerId = idValue(object["customer"]);
  const subscriptionId = event.type.startsWith("customer.subscription.")
    ? idValue(object["id"])
    : idValue(object["subscription"]);
  let workspaceId = metadata(object)["termyte_workspace_id"];
  if (!workspaceId && customerId) {
    workspaceId = (await db.query<{ workspace_id: string }>(`
      SELECT workspace_id FROM stripe_customers WHERE stripe_customer_id = $1
    `, [customerId])).rows[0]?.workspace_id;
  }
  if (!workspaceId || !customerId) return;
  const state = subscriptionState(event.type, object["status"]);
  const periodEnd = unixSeconds(object["current_period_end"]);
  await db.query(`
    INSERT INTO stripe_customers (
      workspace_id, stripe_customer_id, stripe_subscription_id,
      subscription_state, current_period_end, updated_at
    ) VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (workspace_id) DO UPDATE SET
      stripe_customer_id = COALESCE(excluded.stripe_customer_id, stripe_customers.stripe_customer_id),
      stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, stripe_customers.stripe_subscription_id),
      subscription_state = excluded.subscription_state,
      current_period_end = COALESCE(excluded.current_period_end, stripe_customers.current_period_end),
      updated_at = now()
  `, [
    workspaceId,
    customerId,
    subscriptionId,
    state,
    periodEnd ? new Date(periodEnd * 1_000) : null,
  ]);
  await db.query(`
    UPDATE workspaces SET subscription_state = $1 WHERE id = $2
  `, [state, workspaceId]);
}

function subscriptionState(type: string, rawStatus: unknown): string {
  if (type === "customer.subscription.deleted") return "cancelled";
  if (type === "invoice.payment_failed") return "past_due";
  if (type === "invoice.paid" || type === "checkout.session.completed") return "active";
  if (rawStatus === "active" || rawStatus === "trialing") return "active";
  if (rawStatus === "past_due" || rawStatus === "unpaid") return "past_due";
  if (rawStatus === "canceled" || rawStatus === "incomplete_expired") return "cancelled";
  return "trial";
}

function metadata(value: Record<string, unknown>): Record<string, string | undefined> {
  const candidate = value["metadata"];
  return candidate && typeof candidate === "object"
    ? candidate as Record<string, string | undefined>
    : {};
}

function idValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

function unixSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function requireAdmin(db: Database, userId: string, workspaceId: string) {
  const membership = (await db.query<{ role: string }>(`
    SELECT m.role FROM workspace_memberships m
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL
      AND w.deletion_requested_at IS NULL
  `, [workspaceId, userId])).rows[0];
  if (!membership || membership.role === "member") throw new ForbiddenError();
}
