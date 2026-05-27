import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { sendEmail } from "./resend.server";
import { generateDiscountCode, generateReferralCode, hashIp } from "./code.server";
import {
  createPercentDiscountCode,
  findCustomerByEmail,
} from "./shopify-admin.server";
import { RefereeCodeEmail } from "../emails/RefereeCodeEmail";
import { ReferrerRewardEmail } from "../emails/ReferrerRewardEmail";
import type { Brand, Referrer, Referral } from "@prisma/client";

const norm = (s: string) => s.trim().toLowerCase();

export async function getOrCreateBrand(shop: string): Promise<Brand> {
  return prisma.brand.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });
}

export async function getOrCreateReferrer(
  brand: Brand,
  input: { email: string; shopifyCustomerId?: string | null },
): Promise<Referrer> {
  const email = norm(input.email);
  return prisma.referrer.upsert({
    where: { brandId_email: { brandId: brand.id, email } },
    create: {
      brandId: brand.id,
      email,
      shopifyCustomerId: input.shopifyCustomerId ?? undefined,
      code: generateReferralCode(12),
    },
    update: {
      shopifyCustomerId: input.shopifyCustomerId ?? undefined,
    },
  });
}

export type ClaimResult =
  | { ok: true; refereeCode: string; redirectUrl: string }
  | { ok: false; reason: "self" | "existing" | "duplicate" | "invalid_code" | "program_off" | "error"; message: string };

export async function claimReferral(args: {
  shop: string;
  referrerCode: string;
  friendEmail: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<ClaimResult> {
  const friendEmail = norm(args.friendEmail);
  if (!/^.+@.+\..+$/.test(friendEmail))
    return { ok: false, reason: "error", message: "Invalid email" };

  const brand = await prisma.brand.findUnique({ where: { shop: args.shop } });
  if (!brand || !brand.programActive)
    return { ok: false, reason: "program_off", message: "Referral program not active" };

  const referrer = await prisma.referrer.findUnique({ where: { code: args.referrerCode } });
  if (!referrer || referrer.brandId !== brand.id)
    return { ok: false, reason: "invalid_code", message: "Unknown referral code" };

  if (norm(referrer.email) === friendEmail)
    return { ok: false, reason: "self", message: "You can't refer yourself" };

  const existingClaim = await prisma.referral.findUnique({
    where: { brandId_friendEmail: { brandId: brand.id, friendEmail } },
  });
  if (existingClaim)
    return {
      ok: false,
      reason: "duplicate",
      message: "This email has already claimed a referral",
    };

  const { admin } = await unauthenticated.admin(args.shop);
  const existingCustomer = await findCustomerByEmail(admin.graphql, friendEmail);
  if (existingCustomer && existingCustomer.numberOfOrders > 0) {
    await prisma.referral.create({
      data: {
        brandId: brand.id,
        referrerId: referrer.id,
        friendEmail,
        status: "REJECTED_EXISTING",
        ipHash: hashIp(args.ip),
        userAgent: args.userAgent ?? undefined,
      },
    });
    return {
      ok: false,
      reason: "existing",
      message: "This email belongs to an existing customer",
    };
  }

  const code = generateDiscountCode("REF");
  const startsAt = new Date();
  const endsAt = new Date(Date.now() + brand.rewardExpiryDays * 24 * 60 * 60 * 1000);

  const { nodeId } = await createPercentDiscountCode(admin.graphql, {
    title: `Referral discount for ${friendEmail}`,
    code,
    percent: brand.refereePercent,
    startsAt,
    endsAt,
    usageLimit: brand.refereeMaxUses,
    appliesOncePerCustomer: true,
  });

  await prisma.referral.create({
    data: {
      brandId: brand.id,
      referrerId: referrer.id,
      friendEmail,
      refereeCodeId: nodeId,
      refereeCode: code,
      status: "CLAIMED",
      ipHash: hashIp(args.ip),
      userAgent: args.userAgent ?? undefined,
    },
  });

  try {
    await sendEmail({
      to: friendEmail,
      subject: `Your referral code for ${args.shop.replace(/\.myshopify\.com$/, "")}`,
      react: RefereeCodeEmail({
        shop: args.shop,
        code,
        percent: brand.refereePercent,
        expiresAt: endsAt,
      }),
    });
  } catch (e) {
    console.error("[referral] send referee email failed", e);
  }

  const redirectUrl = `https://${args.shop}/discount/${encodeURIComponent(code)}?redirect=/`;
  return { ok: true, refereeCode: code, redirectUrl };
}

export async function convertReferral(args: {
  shop: string;
  order: {
    id: string;
    email?: string | null;
    customer?: { id?: string | null; numberOfOrders?: number | string | null } | null;
    note_attributes?: Array<{ name: string; value: string }>;
    discount_codes?: Array<{ code: string }>;
    cart_token?: string | null;
  };
}): Promise<{ rewarded: boolean; reason?: string }> {
  const orderEmail = norm(args.order.email ?? "");
  if (!orderEmail) return { rewarded: false, reason: "no_email" };

  const attrCode = args.order.note_attributes?.find(
    (a) => a.name === "_referral_code" || a.name === "referral_code",
  )?.value;
  const codeFromAttr = attrCode ? attrCode.trim() : null;
  const codeFromDiscount = args.order.discount_codes?.[0]?.code ?? null;

  const referral = await prisma.referral.findFirst({
    where: {
      brand: { shop: args.shop },
      friendEmail: orderEmail,
      status: "CLAIMED",
      ...(codeFromAttr || codeFromDiscount
        ? {
            OR: [
              codeFromAttr ? { refereeCode: codeFromAttr } : undefined,
              codeFromDiscount ? { refereeCode: codeFromDiscount } : undefined,
            ].filter(Boolean) as { refereeCode: string }[],
          }
        : {}),
    },
    include: { referrer: { include: { brand: true } } },
  });
  if (!referral) return { rewarded: false, reason: "no_match" };

  const referrer = referral.referrer;
  const brand = referrer.brand;

  if (norm(referrer.email) === orderEmail) {
    await prisma.referral.update({
      where: { id: referral.id },
      data: { status: "REJECTED_SELF" },
    });
    return { rewarded: false, reason: "self_referral" };
  }

  const customerOrderCount =
    typeof args.order.customer?.numberOfOrders === "string"
      ? parseInt(args.order.customer.numberOfOrders, 10)
      : args.order.customer?.numberOfOrders ?? 1;
  if (customerOrderCount > 1) {
    await prisma.referral.update({
      where: { id: referral.id },
      data: { status: "REJECTED_EXISTING" },
    });
    return { rewarded: false, reason: "not_first_order" };
  }

  const { admin } = await unauthenticated.admin(args.shop);
  const startsAt = new Date();
  const endsAt = new Date(Date.now() + brand.rewardExpiryDays * 24 * 60 * 60 * 1000);
  const rewardCode = generateDiscountCode("THANKS");

  const { nodeId } = await createPercentDiscountCode(admin.graphql, {
    title: `Referrer reward for ${referrer.email}`,
    code: rewardCode,
    percent: brand.refererPercent,
    startsAt,
    endsAt,
    usageLimit: 1,
    appliesOncePerCustomer: true,
  });

  const reward = await prisma.reward.create({
    data: {
      referrerId: referrer.id,
      referralId: referral.id,
      shopifyCodeId: nodeId,
      code: rewardCode,
    },
  });

  await prisma.referral.update({
    where: { id: referral.id },
    data: { status: "CONVERTED", convertedAt: new Date(), orderId: args.order.id },
  });

  try {
    await sendEmail({
      to: referrer.email,
      subject: `Your referral reward at ${args.shop.replace(/\.myshopify\.com$/, "")}`,
      entityRefId: args.order.id,
      react: ReferrerRewardEmail({
        shop: args.shop,
        code: rewardCode,
        percent: brand.refererPercent,
        expiresAt: endsAt,
      }),
    });
    await prisma.reward.update({
      where: { id: reward.id },
      data: { emailedAt: new Date() },
    });
  } catch (e) {
    console.error("[referral] send referrer reward email failed", e);
  }

  return { rewarded: true };
}

export function buildShareLink(opts: { shop: string; code: string }): string {
  return `https://${opts.shop}/apps/referral?c=${encodeURIComponent(opts.code)}`;
}
