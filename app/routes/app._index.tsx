import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getOrCreateBrand } from "../lib/customer.server";
import { getReferralConfig } from "../lib/feature.server";
import {
  parseDiscountConfig,
  type DiscountConfig,
  type DiscountType,
} from "../lib/discount-config";

type LoaderData = {
  brand: { id: string; shop: string };
  config: {
    enabled: boolean;
    maxReferralsPerUser: number | null;
    refereeDiscount: DiscountConfig;
    referrerDiscount: DiscountConfig;
  };
  stats: { total: number; claimed: number; converted: number };
  recent: Array<{
    id: string;
    friendEmail: string | null;
    referrerEmail: string;
    status: string;
    createdAt: string;
  }>;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const brand = await getOrCreateBrand(session.shop);
  const config = await getReferralConfig(brand);

  const [total, claimed, converted, recent] = await Promise.all([
    prisma.referral.count({ where: { referralConfigId: config.id } }),
    prisma.referral.count({ where: { referralConfigId: config.id, status: "CLAIMED" } }),
    prisma.referral.count({ where: { referralConfigId: config.id, status: "CONVERTED" } }),
    prisma.referral.findMany({
      where: { referralConfigId: config.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        referrer: { include: { customer: true } },
        referee: { include: { customer: true } },
      },
    }),
  ]);

  const data: LoaderData = {
    brand: { id: brand.id, shop: brand.shop },
    config: {
      enabled: config.enabled,
      maxReferralsPerUser: config.maxReferralsPerUser,
      refereeDiscount: parseDiscountConfig(config.refereeDiscount),
      referrerDiscount: parseDiscountConfig(config.referrerDiscount),
    },
    stats: { total, claimed, converted },
    recent: recent.map((r) => ({
      id: r.id,
      friendEmail: r.referee?.customer.email ?? null,
      referrerEmail: r.referrer.customer.email,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  };
  return data;
};

function numOr(v: FormDataEntryValue | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function intOr(v: FormDataEntryValue | null, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

function nullableInt(v: FormDataEntryValue | null, fallback: number | null): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const brand = await getOrCreateBrand(session.shop);
  const current = await getReferralConfig(brand);
  const form = await request.formData();

  const currentReferee = parseDiscountConfig(current.refereeDiscount);
  const currentReferrer = parseDiscountConfig(current.referrerDiscount);

  const refereeType: DiscountType =
    String(form.get("refereeType")) === "FIXED_AMOUNT" ? "FIXED_AMOUNT" : "PERCENT";
  const refereeAmount = Math.max(0.01, numOr(form.get("refereeAmount"), currentReferee.amount));

  const referrerType: DiscountType =
    String(form.get("referrerType")) === "FIXED_AMOUNT" ? "FIXED_AMOUNT" : "PERCENT";
  const referrerAmount = Math.max(0.01, numOr(form.get("referrerAmount"), currentReferrer.amount));

  const refereeDiscount: DiscountConfig = {
    type: refereeType,
    amount: refereeType === "PERCENT" ? Math.min(100, Math.max(1, refereeAmount)) : refereeAmount,
    validity_seconds:
      Math.max(1, intOr(form.get("refereeValidityDays"), Math.round(currentReferee.validity_seconds / 86400))) * 86400,
    max_uses: 1,
    min_order_amount:
      form.get("refereeMinOrderOn") === "on"
        ? Math.max(0, numOr(form.get("refereeMinOrder"), currentReferee.min_order_amount))
        : 0,
  };

  const referrerDiscount: DiscountConfig = {
    type: referrerType,
    amount: referrerType === "PERCENT" ? Math.min(100, Math.max(1, referrerAmount)) : referrerAmount,
    validity_seconds:
      Math.max(1, intOr(form.get("referrerValidityDays"), Math.round(currentReferrer.validity_seconds / 86400))) * 86400,
    max_uses: 1,
    min_order_amount:
      form.get("referrerMinOrderOn") === "on"
        ? Math.max(0, numOr(form.get("referrerMinOrder"), currentReferrer.min_order_amount))
        : 0,
  };

  await prisma.referralConfig.update({
    where: { id: current.id },
    data: {
      enabled: String(form.get("enabled")) === "true",
      maxReferralsPerUser:
        form.get("limitReferralsOn") === "on"
          ? nullableInt(form.get("maxReferralsPerUser"), current.maxReferralsPerUser)
          : null,
      refereeDiscount: refereeDiscount as unknown as object,
      referrerDiscount: referrerDiscount as unknown as object,
    },
  });
  return { ok: true };
};

export default function ReferralAdmin() {
  const data = useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Settings saved");
  }, [fetcher.data, shopify]);

  const [refereeType, setRefereeType] = useState<DiscountType>(data.config.refereeDiscount.type);
  const [referrerType, setReferrerType] = useState<DiscountType>(data.config.referrerDiscount.type);
  const [refereeMinOrderOn, setRefereeMinOrderOn] = useState(data.config.refereeDiscount.min_order_amount > 0);
  const [referrerMinOrderOn, setReferrerMinOrderOn] = useState(data.config.referrerDiscount.min_order_amount > 0);
  const [limitReferralsOn, setLimitReferralsOn] = useState(data.config.maxReferralsPerUser != null);

  const resetUiState = () => {
    setRefereeType(data.config.refereeDiscount.type);
    setReferrerType(data.config.referrerDiscount.type);
    setRefereeMinOrderOn(data.config.refereeDiscount.min_order_amount > 0);
    setReferrerMinOrderOn(data.config.referrerDiscount.min_order_amount > 0);
    setLimitReferralsOn(data.config.maxReferralsPerUser != null);
  };

  return (
    <fetcher.Form method="post" data-save-bar onReset={resetUiState}>
      <s-page heading="Referral" inlineSize="base">
        <s-stack direction="block" gap="base" paddingBlockEnd="large">
          <s-section heading="Referral widget">
            <s-choice-list
              name="enabled"
              label="Status"
              labelAccessibilityVisibility="exclusive"
            >
              <s-choice value="true" {...(data.config.enabled ? { selected: true } : {})}>
                Enable
              </s-choice>
              <s-choice value="false" {...(!data.config.enabled ? { selected: true } : {})}>
                Disable
              </s-choice>
            </s-choice-list>
          </s-section>

          <s-section heading="Friend reward">
            <s-stack direction="block" gap="base">
              <s-paragraph>Choose the reward for friends who receive the link</s-paragraph>
              <s-grid gridTemplateColumns="2fr 1fr" gap="base">
                <s-select
                  name="refereeType"
                  label="Reward type"
                  labelAccessibilityVisibility="exclusive"
                  value={refereeType}
                  onChange={(e: Event) => {
                    const v = (e.currentTarget as HTMLSelectElement).value;
                    if (v === "FIXED_AMOUNT" || v === "PERCENT") setRefereeType(v);
                  }}
                >
                  <s-option value="PERCENT">Percentage off</s-option>
                  <s-option value="FIXED_AMOUNT">Fixed amount</s-option>
                </s-select>
                {refereeType === "PERCENT" ? (
                  <s-number-field
                    name="refereeAmount"
                    label="Amount"
                    labelAccessibilityVisibility="exclusive"
                    defaultValue={String(data.config.refereeDiscount.amount)}
                    min={1}
                    max={100}
                    step={1}
                    inputMode="numeric"
                    suffix="%"
                  />
                ) : (
                  <s-money-field
                    name="refereeAmount"
                    label="Amount"
                    labelAccessibilityVisibility="exclusive"
                    defaultValue={data.config.refereeDiscount.amount.toFixed(2)}
                    min={0.01}
                  />
                )}
              </s-grid>
              <s-number-field
                name="refereeValidityDays"
                label="Discount validity"
                defaultValue={String(Math.max(1, Math.round(data.config.refereeDiscount.validity_seconds / 86400)))}
                min={1}
                step={1}
                inputMode="numeric"
                suffix="days"
              />
              <s-stack direction="block" gap="small-200">
                <s-checkbox
                  name="refereeMinOrderOn"
                  value="on"
                  label="Set minimum order amount"
                  {...(refereeMinOrderOn ? { checked: true } : {})}
                  onChange={(e: Event) =>
                    setRefereeMinOrderOn((e.currentTarget as HTMLInputElement).checked)
                  }
                />
                {refereeMinOrderOn && (
                  <s-money-field
                    name="refereeMinOrder"
                    label="Minimum order amount"
                    labelAccessibilityVisibility="exclusive"
                    defaultValue={(data.config.refereeDiscount.min_order_amount || 0).toFixed(2)}
                    min={0}
                  />
                )}
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Customer reward">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Choose the reward for customers whose friends have made a purchase
              </s-paragraph>
              <s-grid gridTemplateColumns="2fr 1fr" gap="base">
                <s-select
                  name="referrerType"
                  label="Reward type"
                  labelAccessibilityVisibility="exclusive"
                  value={referrerType}
                  onChange={(e: Event) => {
                    const v = (e.currentTarget as HTMLSelectElement).value;
                    if (v === "FIXED_AMOUNT" || v === "PERCENT") setReferrerType(v);
                  }}
                >
                  <s-option value="PERCENT">Percentage off</s-option>
                  <s-option value="FIXED_AMOUNT">Fixed amount</s-option>
                </s-select>
                {referrerType === "PERCENT" && (
                  <s-number-field
                    name="referrerAmount"
                    label="Amount"
                    labelAccessibilityVisibility="exclusive"
                    defaultValue={String(data.config.referrerDiscount.amount)}
                    min={1}
                    max={100}
                    step={1}
                    inputMode="numeric"
                    suffix="%"
                  />
                )}
                {referrerType === "FIXED_AMOUNT" && (
                  <s-money-field
                    name="referrerAmount"
                    label="Amount"
                    labelAccessibilityVisibility="exclusive"
                    defaultValue={data.config.referrerDiscount.amount.toFixed(2)}
                    min={0.01}
                  />
                )}
              </s-grid>
              <s-number-field
                name="referrerValidityDays"
                label="Discount validity"
                defaultValue={String(Math.max(1, Math.round(data.config.referrerDiscount.validity_seconds / 86400)))}
                min={1}
                step={1}
                inputMode="numeric"
                suffix="days"
              />
              <s-stack direction="block" gap="small-200">
                <s-checkbox
                  name="referrerMinOrderOn"
                  value="on"
                  label="Set minimum order amount"
                  {...(referrerMinOrderOn ? { checked: true } : {})}
                  onChange={(e: Event) =>
                    setReferrerMinOrderOn((e.currentTarget as HTMLInputElement).checked)
                  }
                />
                {referrerMinOrderOn && (
                  <s-money-field
                    name="referrerMinOrder"
                    label="Minimum order amount"
                    labelAccessibilityVisibility="exclusive"
                    defaultValue={(data.config.referrerDiscount.min_order_amount || 0).toFixed(2)}
                    min={0}
                  />
                )}
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Limits">
            <s-stack direction="block" gap="small-200">
              <s-checkbox
                name="limitReferralsOn"
                value="on"
                label="Limit successful referrals per customer"
                {...(limitReferralsOn ? { checked: true } : {})}
                onChange={(e: Event) =>
                  setLimitReferralsOn((e.currentTarget as HTMLInputElement).checked)
                }
              />
              {limitReferralsOn && (
                <s-number-field
                  name="maxReferralsPerUser"
                  label="Max successful referrals per customer"
                  labelAccessibilityVisibility="exclusive"
                  defaultValue={
                    data.config.maxReferralsPerUser == null
                      ? ""
                      : String(data.config.maxReferralsPerUser)
                  }
                  min={1}
                  inputMode="numeric"
                />
              )}
            </s-stack>
          </s-section>

          <s-section heading="Recent referrals">
            {data.recent.length === 0 ? (
              <s-paragraph>No referrals yet.</s-paragraph>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header>Friend</s-table-header>
                  <s-table-header>Referrer</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Created</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.recent.map((r) => (
                    <s-table-row key={r.id}>
                      <s-table-cell>{r.friendEmail ?? "—"}</s-table-cell>
                      <s-table-cell>{r.referrerEmail}</s-table-cell>
                      <s-table-cell>{r.status}</s-table-cell>
                      <s-table-cell>{new Date(r.createdAt).toLocaleString()}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
          </s-section>
        </s-stack>

        <s-box slot="aside">
          <s-section heading="Stats">
            <s-unordered-list>
              <s-list-item>Total: {data.stats.total}</s-list-item>
              <s-list-item>Claimed: {data.stats.claimed}</s-list-item>
              <s-list-item>Converted: {data.stats.converted}</s-list-item>
            </s-unordered-list>
          </s-section>

          <s-section heading="Details">
            <s-unordered-list>
              <s-list-item>
                Friend reward: {formatDiscount(data.config.refereeDiscount)}
              </s-list-item>
              <s-list-item>
                Customer reward: {formatDiscount(data.config.referrerDiscount)}
              </s-list-item>
              <s-list-item>First-time customers only</s-list-item>
            </s-unordered-list>
          </s-section>
        </s-box>
      </s-page>
    </fetcher.Form>
  );
}

function formatDiscount(d: DiscountConfig): string {
  const amount = d.type === "PERCENT" ? `${d.amount}%` : `$${d.amount.toFixed(2)}`;
  return `${amount} off`;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
