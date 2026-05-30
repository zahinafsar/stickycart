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
  label: string;
  conditions: string[];
};

export function ReferrerRewardEmail({ shop, code, label, conditions }: Props) {
  const storeName = shop.replace(/\.myshopify\.com$/, "");
  return (
    <Html>
      <Head />
      <Preview>{`Your friend used your referral at ${storeName}`}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Text style={brand}>{storeName}</Text>
          <Hr style={hr} />
          <Text style={heading}>Your friend used your referral</Text>
          <Text style={p}>
            Hi, your friend just used your referral link and completed their order. Your next order
            at {storeName} gets <strong style={pct}>{label}</strong> with code{" "}
            <strong style={pct}>{code}</strong>.
          </Text>
          {conditions.length > 0 && (
            <Section style={termsBox}>
              <Text style={termsTitle}>Terms &amp; conditions</Text>
              {conditions.map((c) => (
                <Text key={c} style={termsItem}>
                  • {c}
                </Text>
              ))}
            </Section>
          )}
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
const termsBox = { margin: "0 0 16px" };
const termsTitle = { fontSize: 12, fontWeight: 600, color: "#6b7280", margin: "0 0 6px" };
const termsItem = { fontSize: 12, color: "#6b7280", margin: "0 0 2px", lineHeight: "18px" };

export default ReferrerRewardEmail;
