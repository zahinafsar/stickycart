import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, useActionData, useLoaderData } from "react-router";
import { verifyAppProxySignature } from "../lib/proxy.server";
import prisma from "../db.server";
import { claimReferral } from "../lib/referral.server";
import { getReferralConfig } from "../lib/feature.server";
import { parseDiscountConfig, formatDiscountLabel } from "../lib/discount-config";

type LoaderData = {
  shop: string;
  code: string;
  brandName: string;
  discountLabel: string;
  conditions: string[];
};

function buildConditions(
  d: ReturnType<typeof parseDiscountConfig>,
): string[] {
  const conditions: string[] = [];
  const days = Math.max(1, Math.round(d.validity_seconds / 86400));
  conditions.push(`Valid for ${days} day${days === 1 ? "" : "s"}`);
  if (d.min_order_amount > 0) conditions.push(`Minimum order $${d.min_order_amount.toFixed(2)}`);
  if (d.max_uses === 1) conditions.push("Single use");
  else if (d.max_uses && d.max_uses > 1) conditions.push(`Up to ${d.max_uses} uses`);
  conditions.push("One per customer");
  conditions.push("New customers only");
  return conditions;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (!verifyAppProxySignature(url)) {
    throw new Response("Invalid signature", { status: 401 });
  }
  const shop = url.searchParams.get("shop") ?? "";
  const code = url.searchParams.get("c") ?? url.searchParams.get("code") ?? "";
  if (!shop || !code) throw new Response("Missing shop or code", { status: 400 });

  const brand = await prisma.brand.findUnique({ where: { shop } });
  if (!brand) throw new Response("Referral program not active", { status: 404 });
  const config = await getReferralConfig(brand);
  if (!config.enabled) throw new Response("Referral program not active", { status: 404 });

  const referrer = await prisma.referrer.findUnique({ where: { code } });
  if (!referrer || referrer.referralConfigId !== config.id)
    throw new Response("Unknown referral code", { status: 404 });

  const refereeDiscount = parseDiscountConfig(config.refereeDiscount);

  return data<LoaderData>({
    shop,
    code,
    brandName: shop.replace(/\.myshopify\.com$/, ""),
    discountLabel: formatDiscountLabel(refereeDiscount),
    conditions: buildConditions(refereeDiscount),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  if (!verifyAppProxySignature(url)) {
    throw new Response("Invalid signature", { status: 401 });
  }
  const shop = url.searchParams.get("shop") ?? "";
  const form = await request.formData();
  const code = String(form.get("code") ?? "");

  const result = await claimReferral({ shop, referrerCode: code });

  if (!result.ok) {
    return data({ ok: false as const, reason: result.reason, message: result.message }, { status: 400 });
  }

  return data({
    ok: true as const,
    redirectUrl: result.redirectUrl,
    discountLabel: result.discountLabel,
    refereeCode: result.refereeCode,
  });
};

export default function ReferralProxyPage() {
  const view = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const claimed = actionData?.ok ? actionData : null;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{`${view.discountLabel} at ${view.brandName}`}</title>
        <style>{baseCss}</style>
      </head>
      <body>
        <main className="card">
          {claimed ? (
            <>
              <div className="badge">✓ Added</div>
              <h1>{`Happy shopping — ${claimed.discountLabel}!`}</h1>
              <p>
                Your discount is ready. Tap below and we&rsquo;ll apply{" "}
                <strong>{claimed.discountLabel}</strong> automatically at <strong>{view.brandName}</strong>.
              </p>
              <p className="code">{claimed.refereeCode}</p>
              <a className="button" href={claimed.redirectUrl}>
                Shop now
              </a>
            </>
          ) : (
            <>
              <h1>{`Get ${view.discountLabel}`}</h1>
              <p>
                A friend invited you to shop at <strong>{view.brandName}</strong>. Tap below to unlock
                your discount.
              </p>
              {actionData && !actionData.ok && <div className="error">{actionData.message}</div>}
              <form method="post">
                <input type="hidden" name="code" value={view.code} />
                <button type="submit">{`Use discount — ${view.discountLabel}`}</button>
              </form>
              <p className="conditions">{view.conditions.join(" · ")}</p>
            </>
          )}
        </main>
      </body>
    </html>
  );
}

const baseCss = `
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f6f6;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;padding:32px;border-radius:12px;max-width:420px;width:100%;box-shadow:0 6px 24px rgba(0,0,0,.06)}
  h1{margin:0 0 8px;font-size:28px}
  p{color:#555;line-height:1.5}
  .badge{display:inline-block;background:#e7f7ec;color:#0a7a33;font-size:13px;font-weight:700;padding:4px 10px;border-radius:999px;margin-bottom:12px}
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:18px;font-weight:700;letter-spacing:1px;background:#f3f3f3;border:1px dashed #bbb;border-radius:8px;padding:12px;text-align:center;color:#111}
  button,.button{display:block;text-align:center;text-decoration:none;margin-top:16px;width:100%;padding:14px;background:#111;color:#fff;border:0;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer}
  button:hover,.button:hover{background:#000}
  .error{margin-top:12px;padding:10px 12px;background:#fde2e2;color:#7a0f0f;border-radius:8px;font-size:14px}
  .conditions{font-size:12px;color:#888;margin:16px 0 0;line-height:1.5}
`;
