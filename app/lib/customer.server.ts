import type { Brand, Customer, Referee, ReferralConfig, Referrer } from "@prisma/client";
import prisma from "../db.server";
import { generateReferralCode } from "./code.server";
import { getShopName, type AdminClient } from "./shopify-admin.server";

const norm = (s: string) => s.trim().toLowerCase();

export async function getOrCreateBrand(shop: string, graphql?: AdminClient): Promise<Brand> {
  const existing = await prisma.brand.findUnique({ where: { shop } });
  if (existing) return existing;
  const name = graphql ? await getShopName(graphql).catch(() => null) : null;
  return prisma.brand.create({ data: { shop, name } });
}

export async function getOrCreateCustomer(
  brand: Brand,
  input: { email: string; shopifyCustomerId?: string | null },
): Promise<Customer> {
  const email = norm(input.email);
  return prisma.customer.upsert({
    where: { brandId_email: { brandId: brand.id, email } },
    create: {
      brandId: brand.id,
      email,
      shopifyCustomerId: input.shopifyCustomerId ?? undefined,
    },
    update: {
      shopifyCustomerId: input.shopifyCustomerId ?? undefined,
    },
  });
}

export async function getOrCreateReferrer(
  config: ReferralConfig,
  customer: Customer,
): Promise<Referrer> {
  return prisma.referrer.upsert({
    where: { customerId: customer.id },
    create: {
      referralConfigId: config.id,
      customerId: customer.id,
      code: generateReferralCode(12),
    },
    update: {},
  });
}

export async function getOrCreateReferee(
  config: ReferralConfig,
  customer: Customer,
): Promise<Referee> {
  return prisma.referee.upsert({
    where: { customerId: customer.id },
    create: {
      referralConfigId: config.id,
      customerId: customer.id,
    },
    update: {},
  });
}
