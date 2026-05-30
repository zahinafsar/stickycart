import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processReferral } from "../lib/referral.server";
import { getOrCreateBrand } from "../lib/customer.server";
import { getReferralConfig } from "../lib/feature.server";
import { recordWebhook } from "../lib/webhook.server";

type OrderPayload = {
  id: number;
  admin_graphql_api_id?: string;
  email?: string | null;
  customer?: {
    admin_graphql_api_id?: string;
  } | null;
  discount_codes?: Array<{ code: string }>;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId, apiVersion } = await authenticate.webhook(request);
  if (!webhookId) return new Response("Missing webhook id", { status: 400 });

  const { duplicate } = await recordWebhook({ webhookId, topic, shop, apiVersion, payload });
  if (duplicate) return new Response();

  const brand = await getOrCreateBrand(shop);
  const config = await getReferralConfig(brand);
  if (!config.enabled) return new Response();

  const order = payload as OrderPayload;

  try {
    await processReferral({
      shop,
      brand,
      config,
      order: {
        id: order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`,
        email: order.email,
        customer: {
          id: order.customer?.admin_graphql_api_id ?? null,
        },
        discount_codes: order.discount_codes,
      },
    });
  } catch (e) {
    console.error("[webhook orders/paid] processReferral failed", e);
  }

  return new Response();
};
