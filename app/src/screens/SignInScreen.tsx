import { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import * as AppleAuthentication from "expo-apple-authentication";
import Animated, { FadeIn, FadeInUp } from "react-native-reanimated";
import { colors, fonts } from "../theme";
import { APP_VERSION, UPDATE_LABEL } from "../constants";

type Props = {
  appleAvailable: boolean;
  error: string | null;
  onApple: () => Promise<void>;
  onGoogle: () => Promise<void>;
};

export function SignInScreen({ appleAvailable, error, onApple, onGoogle }: Props) {
  const [busy, setBusy] = useState(false);

  const run = (fn: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={["#120d1f", colors.bg, colors.bg]}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.6 }}
      />

      <View style={styles.hero}>
        <Animated.Text entering={FadeIn.delay(80).duration(900)} style={styles.wordmark}>
          diktat
        </Animated.Text>
        <Animated.Text entering={FadeIn.delay(240).duration(700)} style={styles.tagline}>
          say it. ship it.
        </Animated.Text>
      </View>

      <View style={styles.actions}>
        <Animated.Text entering={FadeInUp.delay(360).duration(500)} style={styles.prompt}>
          Sign in to connect your machines
        </Animated.Text>

        {error ? (
          <Animated.View entering={FadeIn.duration(250)} style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </Animated.View>
        ) : null}

        {appleAvailable ? (
          <Animated.View entering={FadeInUp.delay(420).duration(500)}>
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
              cornerRadius={14}
              style={styles.appleBtn}
              onPress={run(onApple)}
            />
          </Animated.View>
        ) : null}

        <Animated.View entering={FadeInUp.delay(500).duration(500)}>
          <TouchableOpacity style={styles.googleBtn} onPress={run(onGoogle)} disabled={busy}>
            <Text style={styles.googleG}>G</Text>
            <Text style={styles.googleText}>Continue with Google</Text>
          </TouchableOpacity>
        </Animated.View>

        {busy ? <ActivityIndicator color={colors.accent} style={{ marginTop: 8 }} /> : null}

        <Animated.Text entering={FadeIn.delay(620).duration(500)} style={styles.version}>
          {APP_VERSION} · {UPDATE_LABEL}
        </Animated.Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  hero: { flex: 1, alignItems: "center", justifyContent: "center", paddingBottom: 24 },
  wordmark: {
    fontFamily: fonts.display,
    fontSize: 64,
    color: colors.text,
    letterSpacing: -2,
    marginBottom: 10,
  },
  tagline: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.textSub,
    letterSpacing: 2,
    textTransform: "uppercase",
  },

  actions: { paddingHorizontal: 20, paddingBottom: 56, gap: 12 },
  prompt: {
    fontFamily: fonts.bodyMedium,
    color: colors.textSub,
    fontSize: 14,
    textAlign: "center",
    marginBottom: 4,
  },

  appleBtn: { height: 52, width: "100%" },

  googleBtn: {
    height: 52,
    borderRadius: 14,
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  googleG: { fontFamily: fonts.bodyBold, color: "#4285F4", fontSize: 20 },
  googleText: { fontFamily: fonts.bodySemi, color: "#1f1f1f", fontSize: 16 },

  errorBanner: {
    backgroundColor: "#1f0a0a",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#7f1d1d",
  },
  errorText: { fontFamily: fonts.body, color: colors.error, fontSize: 13, lineHeight: 18 },

  version: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: colors.textSub,
    opacity: 0.6,
    letterSpacing: 0.5,
    textAlign: "center",
    marginTop: 8,
  },
});
