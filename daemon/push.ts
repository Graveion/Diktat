export async function sendPushNotification(token: string, title: string, body: string, data?: Record<string, string>): Promise<void> {
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ to: token, title, body, sound: "default", priority: "high", data: data ?? {} }),
    });
  } catch (e) {
    console.error("Push notification failed:", e);
  }
}
