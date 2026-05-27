import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { convertReferral, getOrCreateBrand, getOrCreateReferrer, buildShareLink } from "../lib/referral.server";
import { sendEmail } from "../lib/resend.server";
import { ReferrerInviteEmail } from "../emails/ReferrerInviteEmail";

type OrderPayload = {
  id: number;
  admin_graphql_api_id?: string;
  email?: string | null;
  customer?: {
    id?: number | null;
    admin_graphql_api_id?: string;
    email?: string | null;
    orders_count?: number | string | null;
    number_of_orders?: number | string | null;
  } | null;
  note_attributes?: Array<{ name: string; value: string }>;
  discount_codes?: Array<{ code: string }>;
  cart_token?: string | null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);
  if (!webhookId) return new Response("Missing webhook id", { status: 400 });

  try {
    await prisma.processedWebhook.create({
      data: { id: webhookId, topic, shop },
    });
  } catch {
    return new Response();
  }

  const order = payload as OrderPayload;
  const customerOrdersCount =
    order.customer?.orders_count ?? order.customer?.number_of_orders ?? 1;

  const orderId = order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`;

  const conv = await convertReferral({
    shop,
    order: {
      id: orderId,
      email: order.email,
      customer: {
        id: order.customer?.admin_graphql_api_id ?? null,
        numberOfOrders: customerOrdersCount,
      },
      note_attributes: order.note_attributes,
      discount_codes: order.discount_codes,
      cart_token: order.cart_token,
    },
  }).catch((e) => {
    console.error("[webhook orders/paid] convertReferral failed", e);
    return { rewarded: false, reason: "exception" };
  });

  const isFirstOrder = Number(customerOrdersCount) <= 1;
  if (isFirstOrder && order.email) {
    try {
      const brand = await getOrCreateBrand(shop);
      if (brand.programActive) {
        const referrer = await getOrCreateReferrer(brand, {
          email: order.email,
          shopifyCustomerId: order.customer?.admin_graphql_api_id,
        });
        if (!referrer.firstOrderId) {
          await prisma.referrer.update({
            where: { id: referrer.id },
            data: { firstOrderId: orderId },
          });
          const shareUrl = buildShareLink({ shop, code: referrer.code });
          const storeName = shop.replace(/\.myshopify\.com$/, "");
          await sendEmail({
            to: referrer.email,
            subject: `Your referral link for ${storeName}`,
            entityRefId: String(order.id),
            react: ReferrerInviteEmail({
              shop,
              shareUrl,
              refereePercent: brand.refereePercent,
              refererPercent: brand.refererPercent,
            }),
          });
        }
      }
    } catch (e) {
      console.error("[webhook orders/paid] new-referrer email failed", e);
    }
  }

  void conv;
  return new Response();
};
