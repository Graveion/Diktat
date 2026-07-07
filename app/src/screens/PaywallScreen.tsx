import { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Alert,
  Linking,
} from "react-native";
import { PRIVACY_URL, TERMS_URL } from "../constants";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import type { PurchasesPackage } from "react-native-purchases";
import Animated, { FadeIn, FadeInUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, fonts, radii, space } from "../theme";

type Props = {
  packages: PurchasesPackage[];
  onPurchase: (pkg: PurchasesPackage) => Promise<boolean>;
  onRestore: () => Promise<boolean>;
  onRedeem: (code: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
  onUnlocked: () => void;
};

function periodLabel(pkg: PurchasesPackage): string {
  const t = pkg.packageType;
  if (t === "ANNUAL") return "per year";
  if (t === "MONTHLY") return "per month";
  return pkg.product.title;
}

export function PaywallScreen({ packages, onPurchase, onRestore, onRedeem, onClose, onUnlocked }: Props) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<string | null>(null);
  const [showRedeem, setShowRedeem] = useState(false);
  const [code, setCode] = useState("");
  const [redeemError, setRedeemError] = useState<string | null>(null);

  const buy = async (pkg: PurchasesPackage) => {
    if (busy) return;
    setBusy(pkg.identifier);
    try {
      if (await onPurchase(pkg)) onUnlocked();
    } catch (e: any) {
      Alert.alert("Purchase failed", e?.message ?? "Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    if (busy) return;
    setBusy("restore");
    try {
      if (await onRestore()) onUnlocked();
      else Alert.alert("Nothing to restore", "No active subscription found for this account.");
    } catch (e: any) {
      Alert.alert("Restore failed", e?.message ?? "Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const redeem = async () => {
    if (busy || !code.trim()) return;
    setBusy("redeem");
    setRedeemError(null);
    try {
      const res = await onRedeem(code);
      if (res.ok) onUnlocked();
      else setRedeemError(res.error ?? "Invalid code");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={["#1a1033", colors.bg, colors.bg]}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.6 }}
      />
      <TouchableOpacity
        style={[styles.close, { top: insets.top + 12 }]}
        onPress={onClose}
        hitSlop={14}
        accessibilityRole="button"
        accessibilityLabel="Close paywall"
      >
        <Ionicons name="close" size={24} color={colors.textSub} />
      </TouchableOpacity>

      <View style={styles.body}>
        <Animated.Text entering={FadeIn.duration(500)} style={styles.title}>
          Diktat Pro
        </Animated.Text>
        <Animated.Text entering={FadeIn.delay(120).duration(500)} style={styles.subtitle}>
          One app for Claude Code, Cursor, Codex, Copilot & Kiro — running on your
          own Mac, with your own logins.
        </Animated.Text>

        <Animated.View entering={FadeIn.delay(180).duration(500)} style={styles.benefits}>
          {[
            "Every agent in one place — switch CLIs without switching apps",
            "Runs on your Mac: your code, your subscriptions, nothing in our cloud",
            "Voice or type, with live diffs and push when a run finishes",
          ].map((b) => (
            <View key={b} style={styles.benefitRow}>
              <Ionicons name="checkmark-circle" size={16} color={colors.accent} />
              <Text style={styles.benefitText}>{b}</Text>
            </View>
          ))}
        </Animated.View>

        <View style={styles.packages}>
          {packages.length === 0 ? (
            <Text style={styles.unavailable}>Subscriptions are temporarily unavailable.</Text>
          ) : (
            packages.map((pkg, i) => (
              <Animated.View key={pkg.identifier} entering={FadeInUp.delay(200 + i * 80).duration(400)}>
                <TouchableOpacity
                  style={[styles.pkg, pkg.packageType === "ANNUAL" && styles.pkgFeatured]}
                  onPress={() => buy(pkg)}
                  disabled={!!busy}
                >
                  {pkg.packageType === "ANNUAL" ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>BEST VALUE</Text>
                    </View>
                  ) : null}
                  <Text style={styles.pkgPrice}>{pkg.product.priceString}</Text>
                  <Text style={styles.pkgPeriod}>{periodLabel(pkg)}</Text>
                  {busy === pkg.identifier ? (
                    <ActivityIndicator color={colors.accent} style={{ marginTop: 6 }} />
                  ) : null}
                </TouchableOpacity>
              </Animated.View>
            ))
          )}
        </View>

        {packages.length > 0 ? (
          <Text style={styles.reassure}>Cancel anytime · less than a coffee a month</Text>
        ) : null}

        {showRedeem ? (
          <View style={styles.redeemBox}>
            <TextInput
              style={styles.redeemInput}
              value={code}
              onChangeText={setCode}
              placeholder="Enter code"
              placeholderTextColor={colors.textSub}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <TouchableOpacity style={styles.redeemBtn} onPress={redeem} disabled={!!busy}>
              {busy === "redeem" ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.redeemBtnText}>Redeem</Text>
              )}
            </TouchableOpacity>
          </View>
        ) : null}
        {redeemError ? <Text style={styles.redeemError}>{redeemError}</Text> : null}

        <View style={styles.footer}>
          <TouchableOpacity onPress={() => setShowRedeem((s) => !s)} disabled={!!busy}>
            <Text style={styles.footerLink}>Have a code?</Text>
          </TouchableOpacity>
          <Text style={styles.footerDot}>·</Text>
          <TouchableOpacity onPress={restore} disabled={!!busy}>
            <Text style={styles.footerLink}>Restore</Text>
          </TouchableOpacity>
        </View>

        {/* Auto-renewable subscription — Apple requires functional Terms (EULA)
            and Privacy links at the point of purchase (App Store 3.1.2). */}
        <View style={styles.legalRow}>
          <TouchableOpacity onPress={() => Linking.openURL(TERMS_URL)} accessibilityRole="link">
            <Text style={styles.legalLink}>Terms of Use</Text>
          </TouchableOpacity>
          <Text style={styles.footerDot}>·</Text>
          <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_URL)} accessibilityRole="link">
            <Text style={styles.legalLink}>Privacy Policy</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  close: { position: "absolute", left: 20, zIndex: 2 },

  body: { flex: 1, justifyContent: "center", paddingHorizontal: space.lg },
  title: { fontFamily: fonts.display, fontSize: 40, color: colors.text, textAlign: "center", letterSpacing: -1 },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.textSub,
    textAlign: "center",
    lineHeight: 21,
    marginTop: 12,
    marginBottom: 20,
  },

  benefits: { gap: 10, marginBottom: 26, paddingHorizontal: 4 },
  benefitRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  benefitText: { flex: 1, fontFamily: fonts.body, fontSize: 13.5, color: colors.textSub, lineHeight: 19 },

  packages: { gap: 12 },
  pkg: {
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    paddingVertical: space.lg,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  pkgFeatured: { borderColor: colors.accent },
  badge: {
    position: "absolute",
    top: -9,
    backgroundColor: colors.accent,
    borderRadius: radii.full,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  badgeText: { fontFamily: fonts.bodyBold, fontSize: 10, color: "#fff", letterSpacing: 0.5 },
  pkgPrice: { fontFamily: fonts.display, fontSize: 26, color: colors.text },
  pkgPeriod: { fontFamily: fonts.body, fontSize: 13, color: colors.textSub, marginTop: 2 },
  unavailable: { fontFamily: fonts.body, fontSize: 14, color: colors.textSub, textAlign: "center" },
  reassure: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, textAlign: "center", marginTop: 14 },

  redeemBox: { flexDirection: "row", gap: 8, marginTop: 20 },
  redeemInput: {
    flex: 1,
    backgroundColor: colors.input,
    color: colors.text,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: fonts.mono,
    fontSize: 15,
    borderWidth: 1,
    borderColor: colors.border,
  },
  redeemBtn: {
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: 18,
    justifyContent: "center",
    alignItems: "center",
  },
  redeemBtnText: { fontFamily: fonts.bodySemi, color: "#fff", fontSize: 15 },
  redeemError: { fontFamily: fonts.body, fontSize: 13, color: colors.error, textAlign: "center", marginTop: 10 },

  footer: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 12, marginTop: 28 },
  footerLink: { fontFamily: fonts.bodyMedium, fontSize: 14, color: colors.accent },
  footerDot: { color: colors.textMuted },

  legalRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 10, marginTop: 14 },
  legalLink: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, textDecorationLine: "underline" },
});
