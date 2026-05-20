import { useEffect, useState } from "react";
import * as Notifications from "expo-notifications";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export function usePushToken() {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== "granted") return;
      const t = await Notifications.getExpoPushTokenAsync({
        projectId: "b7b6c69b-e870-4470-9944-daef2f579bf6",
      });
      setToken(t.data);
    })();
  }, []);

  return token;
}
