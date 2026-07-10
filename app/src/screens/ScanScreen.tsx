import { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Linking } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { colors, fonts, radii } from "../theme";

type Props = {
  onScanned: (nonce: string) => void;
  onCancel: () => void;
};

/** Pull the nonce from `diktat://pair?n=<nonce>` (or accept a bare nonce). */
export function extractNonce(data: string): string | null {
  const m = data.match(/[?&]n=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  if (/^[A-Za-z0-9_-]{8,}$/.test(data.trim())) return data.trim();
  return null;
}

export function ScanScreen({ onScanned, onCancel }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [handled, setHandled] = useState(false);
  const asked = useRef(false);

  // Go straight to the system permission prompt the first time (its explanation
  // comes from the Info.plist usage string — no custom pre-prompt with an
  // "Allow"/exit button, per App Store guideline 5.1.1(iv)).
  useEffect(() => {
    if (permission && permission.status === "undetermined" && !asked.current) {
      asked.current = true;
      requestPermission();
    }
  }, [permission, requestPermission]);

  // Waiting on the permission object, or the OS prompt is up — show nothing.
  if (!permission || permission.status === "undetermined") {
    return <View style={styles.container} />;
  }

  // Denied: we can't re-prompt, so point the user to Settings (a Settings link
  // for a feature that needs the camera is explicitly allowed).
  if (!permission.granted) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.permTitle}>Camera access is off</Text>
        <Text style={styles.permDesc}>
          Diktat scans the pairing QR on your Mac with the camera. Turn it on in Settings to continue.
        </Text>
        <TouchableOpacity style={styles.permBtn} onPress={() => Linking.openSettings()}>
          <Text style={styles.permBtnText}>Open Settings</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onCancel} style={{ marginTop: 16 }}>
          <Text style={styles.cancel}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (handled) return;
          const nonce = extractNonce(data);
          if (!nonce) return;
          setHandled(true);
          onScanned(nonce);
        }}
      />
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={styles.reticle} />
        <Text style={styles.hint}>
          On your Mac, run <Text style={styles.mono}>diktat pair</Text> and point here
        </Text>
        <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancel}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  center: { justifyContent: "center", alignItems: "center", padding: 32, backgroundColor: colors.bg },

  overlay: { flex: 1, justifyContent: "center", alignItems: "center" },
  reticle: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: colors.accentBright,
    borderRadius: radii.lg,
    backgroundColor: "transparent",
  },
  hint: {
    fontFamily: fonts.body,
    color: "#fff",
    fontSize: 15,
    textAlign: "center",
    marginTop: 28,
    paddingHorizontal: 32,
  },
  mono: { fontFamily: fonts.mono, color: colors.accentBright },

  cancelBtn: { position: "absolute", bottom: 56 },
  cancel: { fontFamily: fonts.bodyMedium, color: colors.textSub, fontSize: 16 },

  permTitle: { fontFamily: fonts.bodySemi, color: colors.text, fontSize: 18, marginBottom: 8 },
  permDesc: { fontFamily: fonts.body, color: colors.textSub, fontSize: 14, textAlign: "center", lineHeight: 20, marginBottom: 24 },
  permBtn: { backgroundColor: colors.accent, borderRadius: radii.md, paddingVertical: 14, paddingHorizontal: 28 },
  permBtnText: { fontFamily: fonts.bodySemi, color: "#fff", fontSize: 15 },
});
