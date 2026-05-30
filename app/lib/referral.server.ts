import type { Brand, ReferralConfig } from "@prisma/client";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { sendEmail } from "./resend.server";
import { generateDiscountCode } from "./code.server";
import { createDiscountCode } from "./shopify-admin.server";
import { ReferrerRewardEmail } from "../emails/ReferrerRewardEmail";
import { ReferrerInviteEmail } from "../emails/ReferrerInviteEmail";
import {
  getOrCreateBrand,
  getOrCreateCustomer,
  getOrCreateReferee,
  getOrCreateReferrer,
} from "./customer.server";
import { getReferralConfig } from "./feature.server";
import { parseDiscountConfig, formatDiscountLabel, describeDiscountConditions } from "./discount-config";

const norm = (s: string) => s.trim().toLowerCase();

const toOrderCount = (v: number | string | null | undefined): number => {
  if (typeof v === "string") return parseInt(v, 10) || 1;
  return v ?? 1;
};

export type ClaimResult =
  | { ok: true; refereeCode: string; redirectUrl: string; discountLabel: string }
  | {
      ok: false;
      reason: "invalid_code" | "program_off" | "limit_reached" | "error";
      message: string;
    };

export async function claimReferral(args: {
  shop: string;
  referrerCode: string;
}): Promise<ClaimResult> {
  const brand = await getOrCreateBrand(args.shop);
  const config = await getReferralConfig(brand);
  if (!config.enabled)
    return { ok: false, reason: "program_off", message: "Referral program not active" };

  const referrer = await prisma.referrer.findUnique({
    where: { code: args.referrerCode },
  });
  if (!referrer || referrer.referralConfigId !== config.id)
    return { ok: false, reason: "invalid_code", message: "Unknown referral code" };

  if (config.maxReferralsPerUser != null) {
    const convertedCount = await prisma.referral.count({
      where: { referrerId: referrer.id, status: "CONVERTED" },
    });
    if (convertedCount >= config.maxReferralsPerUser)
      return {
        ok: false,
        reason: "limit_reached",
        message: "This referrer has reached their referral limit",
      };
  }

  const d = parseDiscountConfig(config.refereeDiscount);
  const code = generateDiscountCode("REF");
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + d.validity_seconds * 1000);

  const { admin } = await unauthenticated.admin(args.shop);
  const { nodeId } = await createDiscountCode(admin.graphql, {
    title: `Referral discount (${args.referrerCode})`,
    code,
    type: d.type,
    amount: d.amount,
    startsAt,
    endsAt,
    usageLimit: d.max_uses,
    minOrderAmount: d.min_order_amount,
    appliesOncePerCustomer: true,
  });

  const discount = await prisma.discount.create({
    data: { shopifyCodeId: nodeId, code },
  });

  await prisma.referral.create({
    data: {
      referralConfigId: config.id,
      referrerId: referrer.id,
      refereeDiscountId: discount.id,
      status: "CLAIMED",
    },
  });

  const redirectUrl = `https://${args.shop}/discount/${encodeURIComponent(code)}?redirect=/`;
  return { ok: true, refereeCode: code, redirectUrl, discountLabel: formatDiscountLabel(d) };
}

export type ProcessReferralOrder = {
  id: string;
  email?: string | null;
  customer?: { id?: string | null; numberOfOrders?: number | string | null } | null;
  discount_codes?: Array<{ code: string }>;
};

export async function processReferral(args: {
  shop: string;
  brand: Brand;
  config: ReferralConfig;
  order: ProcessReferralOrder;
}): Promise<void> {
  const { shop, brand, config, order } = args;

  const discountCode = order.discount_codes?.[0]?.code ?? null;
  if (discountCode) {
    const matched = await convertClaim({ shop, brand, config, order, discountCode });
    if (matched) return;
  }

  await sendReferrerInvite({ shop, brand, config, order });
}

async function convertClaim(args: {
  shop: string;
  brand: Brand;
  config: ReferralConfig;
  order: ProcessReferralOrder;
  discountCode: string;
}): Promise<boolean> {
  const { shop, brand, config, order, discountCode } = args;

  const discount = await prisma.discount.findUnique({
    where: { code: discountCode },
    include: {
      refereeFor: { include: { referrer: { include: { customer: true } } } },
    },
  });
  const referral = discount?.refereeFor ?? null;
  if (!referral) return false;

  if (referral.status !== "CLAIMED") return true;

  const referrer = referral.referrer;
  const orderEmail = norm(order.email ?? "");

  if (norm(referrer.customer.email) === orderEmail) {
    await prisma.referral.update({
      where: { id: referral.id },
      data: { status: "REJECTED_SELF" },
    });
    return true;
  }

  if (config.firstPurchaseOnly && toOrderCount(order.customer?.numberOfOrders) > 1) {
    await prisma.referral.update({
      where: { id: referral.id },
      data: { status: "REJECTED_EXISTING" },
    });
    return true;
  }

  const d = parseDiscountConfig(config.referrerDiscount);

  const { admin } = await unauthenticated.admin(shop);
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + d.validity_seconds * 1000);
  const rewardCode = generateDiscountCode("THANKS");

  const { nodeId } = await createDiscountCode(admin.graphql, {
    title: `Referrer reward for ${referrer.customer.email}`,
    code: rewardCode,
    type: d.type,
    amount: d.amount,
    startsAt,
    endsAt,
    usageLimit: d.max_uses,
    minOrderAmount: d.min_order_amount,
    appliesOncePerCustomer: true,
  });

  const rewardDiscount = await prisma.discount.create({
    data: { shopifyCodeId: nodeId, code: rewardCode },
  });

  await prisma.referral.update({
    where: { id: referral.id },
    data: {
      status: "CONVERTED",
      convertedAt: new Date(),
      orderId: order.id,
      referrerDiscountId: rewardDiscount.id,
    },
  });

  await linkReferee({ brand, config, referral, orderEmail, order });

  const rewardConditions: string[] = [];
  if (d.min_order_amount > 0)
    rewardConditions.push(`Minimum order $${d.min_order_amount.toFixed(2)}`);
  if (d.max_uses === 1) rewardConditions.push("One-time use");
  else if (d.max_uses && d.max_uses > 1) rewardConditions.push(`Up to ${d.max_uses} uses`);
  rewardConditions.push(`Expires ${endsAt.toLocaleDateString()}`);

  try {
    await sendEmail({
      to: referrer.customer.email,
      from: "referral@gluesale.com",
      subject: `Your friend used your referral at ${shop.replace(/\.myshopify\.com$/, "")}`,
      entityRefId: order.id,
      react: ReferrerRewardEmail({
        shop,
        code: rewardCode,
        label: formatDiscountLabel(d),
        conditions: rewardConditions,
      }),
    });
    await prisma.discount.update({
      where: { id: rewardDiscount.id },
      data: { emailedAt: new Date() },
    });
  } catch (e) {
    console.error("[referral] send referrer reward email failed", e);
  }

  return true;
}

// Best-effort: attach a Referee (from the buyer's email) to an anonymous claim.
// Never blocks the conversion/reward — a failure here is logged and ignored.
async function linkReferee(args: {
  brand: Brand;
  config: ReferralConfig;
  referral: { id: string; refereeId: string | null };
  orderEmail: string;
  order: ProcessReferralOrder;
}): Promise<void> {
  const { brand, config, referral, orderEmail, order } = args;
  if (referral.refereeId || !orderEmail) return;
  try {
    const customer = await getOrCreateCustomer(brand, {
      email: orderEmail,
      shopifyCustomerId: order.customer?.id ?? null,
    });
    const referee = await getOrCreateReferee(config, customer);
    await prisma.referral.update({
      where: { id: referral.id },
      data: { refereeId: referee.id },
    });
  } catch (e) {
    console.error("[referral] link referee failed", e);
  }
}

async function sendReferrerInvite(args: {
  shop: string;
  brand: Brand;
  config: ReferralConfig;
  order: ProcessReferralOrder;
}): Promise<void> {
  const { shop, brand, config, order } = args;

  const email = norm(order.email ?? "");
  if (!email) return;
  if (toOrderCount(order.customer?.numberOfOrders) > 1) return;

  const customer = await getOrCreateCustomer(brand, {
    email,
    shopifyCustomerId: order.customer?.id ?? null,
  });
  const referrer = await getOrCreateReferrer(config, customer);
  if (referrer.welcomeEmailedAt) return;

  const shareUrl = buildShareLink({ shop, code: referrer.code });
  const storeName = shop.replace(/\.myshopify\.com$/, "");
  const refereeDiscount = parseDiscountConfig(config.refereeDiscount);
  const referrerDiscount = parseDiscountConfig(config.referrerDiscount);

  const conditions: string[] = [];
  if (config.firstPurchaseOnly) conditions.push("Friends must be new customers");
  conditions.push("One reward per referred customer");
  conditions.push(
    `Friend's ${formatDiscountLabel(refereeDiscount)}: ${describeDiscountConditions(refereeDiscount).join(", ")}`,
  );
  conditions.push(
    `Your ${formatDiscountLabel(referrerDiscount)} reward: ${describeDiscountConditions(referrerDiscount).join(", ")}`,
  );

  try {
    await sendEmail({
      to: customer.email,
      subject: `Your referral link for ${storeName}`,
      entityRefId: order.id,
      react: ReferrerInviteEmail({
        shop,
        shareUrl,
        refereeLabel: formatDiscountLabel(refereeDiscount),
        refererLabel: formatDiscountLabel(referrerDiscount),
        conditions,
      }),
    });
    await prisma.referrer.update({
      where: { id: referrer.id },
      data: { welcomeEmailedAt: new Date() },
    });
  } catch (e) {
    console.error("[referral] referrer invite email failed", e);
  }
}

export function buildShareLink(opts: { shop: string; code: string }): string {
  return `https://${opts.shop}/apps/referral?c=${encodeURIComponent(opts.code)}`;
}
