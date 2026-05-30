import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { DiscountType } from "./discount-config";

export type AdminClient = AdminApiContext["graphql"];

export async function getShopName(graphql: AdminClient): Promise<string | null> {
  const resp = await graphql(
    `#graphql
    query ShopName {
      shop { name }
    }`,
  );
  const json = (await resp.json()) as { data?: { shop?: { name?: string } } };
  return json.data?.shop?.name?.trim() || null;
}

export async function findCustomerByEmail(
  graphql: AdminClient,
  email: string,
): Promise<{ id: string; numberOfOrders: number; email: string } | null> {
  const resp = await graphql(
    `#graphql
    query FindCustomer($q: String!) {
      customers(first: 1, query: $q) {
        nodes { id email numberOfOrders }
      }
    }`,
    { variables: { q: `email:${email}` } },
  );
  const json = (await resp.json()) as {
    data?: { customers?: { nodes?: Array<{ id: string; email: string; numberOfOrders: string | number }> } };
  };
  const node = json.data?.customers?.nodes?.[0];
  if (!node) return null;
  const count =
    typeof node.numberOfOrders === "string"
      ? parseInt(node.numberOfOrders, 10)
      : node.numberOfOrders;
  return { id: node.id, email: node.email, numberOfOrders: Number.isFinite(count) ? count : 0 };
}

export async function createDiscountCode(
  graphql: AdminClient,
  opts: {
    title: string;
    code: string;
    type: DiscountType;
    amount: number;
    startsAt: Date;
    endsAt: Date;
    usageLimit: number | null;
    minOrderAmount: number;
    appliesOncePerCustomer?: boolean;
  },
): Promise<{ nodeId: string }> {
  const customerGets =
    opts.type === "PERCENT"
      ? { value: { percentage: opts.amount / 100 }, items: { all: true } }
      : {
        value: {
          discountAmount: { amount: opts.amount.toFixed(2), appliesOnEachItem: false },
        },
        items: { all: true },
      };

  const input: Record<string, unknown> = {
    title: opts.title,
    code: opts.code,
    startsAt: opts.startsAt.toISOString(),
    endsAt: opts.endsAt.toISOString(),
    appliesOncePerCustomer: opts.appliesOncePerCustomer ?? true,
    customerSelection: { all: true },
    customerGets,
    combinesWith: {
      orderDiscounts: false,
      productDiscounts: true,
      shippingDiscounts: true,
    },
  };

  if (opts.usageLimit !== null) input.usageLimit = opts.usageLimit;
  if (opts.minOrderAmount > 0) {
    input.minimumRequirement = {
      subtotal: { greaterThanOrEqualToSubtotal: opts.minOrderAmount.toFixed(2) },
    };
  }

  const resp = await graphql(
    `#graphql
    mutation CreateBasicCode($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) {
        codeDiscountNode { id }
        userErrors { field message code }
      }
    }`,
    { variables: { input } },
  );
  const json = (await resp.json()) as {
    data?: {
      discountCodeBasicCreate?: {
        codeDiscountNode?: { id: string };
        userErrors?: Array<{ field?: string[]; message: string; code?: string }>;
      };
    };
  };
  const errs = json.data?.discountCodeBasicCreate?.userErrors ?? [];
  if (errs.length) throw new Error(`Discount create failed: ${errs.map((e) => e.message).join("; ")}`);
  const id = json.data?.discountCodeBasicCreate?.codeDiscountNode?.id;
  if (!id) throw new Error("Discount create returned no id");
  return { nodeId: id };
}
