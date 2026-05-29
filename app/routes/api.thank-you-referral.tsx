import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import {
  getOrCreateBrand,
  getOrCreateCustomer,
  getOrCreateReferrer,
} from "../lib/customer.server";
import { getReferralConfig } from "../lib/feature.server";
import { buildShareLink } from "../lib/referral.server";
import { getOrderContact } from "../lib/shopify-admin.server";
import {
  parseDiscountConfig,
  formatDiscountLabel,
  describeDiscountConditions,
} from "../lib/discount-config";

// Credentialed CORS: must echo the exact Origin (not "*") and allow credentials.
function corsHeaders(request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": request.headers.get("Origin") ?? "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    Vary: "Origin",
  };
}

function preflight(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

async function handle(request: Request) {
  try {
    return await run(request);
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[gluesale] thank-you-referral failed", error);
    return new Response(
      JSON.stringify({ active: false, error: String((error as Error)?.message ?? error) }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders(request) },
      },
    );
  }
}

async function run(request: Request) {
  const { sessionToken } = await authenticate.public.checkout(request);
  const shop = String(sessionToken.dest ?? "").replace(/^https?:\/\//, "");
  const orderId = new URL(request.url).searchParams.get("orderId");
  if (!shop || !orderId) return json(request, { active: false });

  const brand = await getOrCreateBrand(shop);
  const config = await getReferralConfig(brand);
  if (!config.enabled) return json(request, { active: false });

  const { admin } = await unauthenticated.admin(shop);
  const contact = await getOrderContact(admin.graphql, orderId);
  if (!contact?.email) return json(request, { active: false });
  if (config.firstPurchaseOnly && contact.numberOfOrders > 1) {
    return json(request, { active: false });
  }

  const customer = await getOrCreateCustomer(brand, { email: contact.email });
  const referrer = await getOrCreateReferrer(config, customer);

  const refereeDiscount = parseDiscountConfig(config.refereeDiscount);
  const referrerDiscount = parseDiscountConfig(config.referrerDiscount);

  return json(request, {
    active: true,
    code: referrer.code,
    shareUrl: buildShareLink({ shop, code: referrer.code }),
    refereeLabel: formatDiscountLabel(refereeDiscount),
    refererLabel: formatDiscountLabel(referrerDiscount),
    conditions: describeDiscountConditions(refereeDiscount),
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return handle(request);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return preflight(request);
  return handle(request);
};
