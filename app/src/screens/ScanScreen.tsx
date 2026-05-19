import { useState, useEffect } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

type Props = {
  onScanned: (host: string, port: number) => void;
  onCancel: () => void;
};

export function ScanScreen({ onScanned, onCancel }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    if (!permission?.granted) requestPermission();
  }, []);

  const handleBarcode = ({ data }: { data: string }) => {
    if (scanned) return;
    // Expects diktat://100.x.x.x:9000
    const match = data.match(/^diktat:\/\/([\d.]+):(\d+)$/);
    if (!match) return;
    setScanned(true);
    onScanned(match[1], parseInt(match[2]));
  };

  if (!permission?.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>Camera permission is needed to scan the QR code.</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Grant permission</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onCancel}>
          <Text style={styles.cancel}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        onBarcodeScanned={handleBarcode}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
      />
      <View style={styles.overlay}>
        <View style={styles.finder} />
        <Text style={styles.hint}>Point at the QR code shown in your terminal</Text>
        <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
          <Text style={styles.cancel}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000", justifyContent: "center", alignItems: "center" },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center", alignItems: "center",
  },
  finder: {
    width: 240, height: 240,
    borderWidth: 2, borderColor: "#4f8ef7", borderRadius: 16,
    backgroundColor: "transparent",
  },
  hint: { color: "#fff", marginTop: 24, fontSize: 15, textAlign: "center", paddingHorizontal: 32 },
  cancelButton: { marginTop: 32 },
  cancel: { color: "#4f8ef7", fontSize: 16 },
  message: { color: "#fff", textAlign: "center", marginBottom: 24, paddingHorizontal: 32, fontSize: 15 },
  button: { backgroundColor: "#4f8ef7", borderRadius: 8, padding: 14, marginBottom: 16 },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
