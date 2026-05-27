import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

type Props = {
  shop: string;
  code: string;
  percent: number;
  expiresAt: Date;
};

export function RefereeCodeEmail({ shop, code, percent, expiresAt }: Props) {
  const url = `https://${shop}/discount/${encodeURIComponent(code)}?redirect=/`;
  const storeName = shop.replace(/\.myshopify\.com$/, "");
  return (
    <Html>
      <Head />
      <Preview>{`Your referral code for ${storeName}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Text style={brand}>{storeName}</Text>
          <Hr style={hr} />
          <Text style={heading}>A friend sent you a gift</Text>
          <Text style={p}>
            You got <strong style={pct}>{percent}%</strong> off your first order at {storeName} with
            code <strong style={pct}>{code}</strong>.
          </Text>
          <Section style={linkBox}>
            <Text style={linkLabel}>Your link</Text>
            <Text style={linkText}>{url}</Text>
          </Section>
          <Text style={muted}>Expires {expiresAt.toLocaleDateString()}. One per customer.</Text>
        </Container>
      </Body>
    </Html>
  );
}

const body = { fontFamily: "Arial, sans-serif", background: "#ffffff", padding: 24, color: "#1f2328", margin: 0 };
const container = { maxWidth: 560, margin: "0 auto" };
const brand = { fontSize: 16, fontWeight: 700, margin: 0, color: "#1f2328" };
const hr = { borderColor: "#e5e7eb", margin: "12px 0 16px" };
const heading = { fontSize: 18, fontWeight: 600, color: "#1f2328", margin: "0 0 12px" };
const p = { fontSize: 15, lineHeight: "22px", margin: "0 0 16px" };
const pct = { color: "#1f2328", fontWeight: 700 };
const linkBox = { background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 6, padding: 12, margin: "0 0 16px" };
const linkLabel = { fontSize: 12, color: "#6b7280", margin: "0 0 4px" };
const linkText = { fontSize: 14, color: "#0a58ca", margin: 0, wordBreak: "break-all" as const };
const muted = { color: "#6b7280", fontSize: 12, margin: 0, lineHeight: "18px" };

export default RefereeCodeEmail;
