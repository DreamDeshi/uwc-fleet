import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import { useQueryClient } from "@tanstack/react-query";

// Listen for notifications while the app runs. A push almost always means a
// trip/booking changed state (assigned, approved, rejected), so we refresh the
// relevant queries — both when one arrives in the foreground and when the user
// taps one to open the app.
export function usePushNotificationListeners() {
  const qc = useQueryClient();

  useEffect(() => {
    const refresh = (data: { tripId?: string } | undefined) => {
      qc.invalidateQueries({ queryKey: ["trips"] });
      if (data?.tripId) qc.invalidateQueries({ queryKey: ["trip", data.tripId] });
    };

    const receivedSub = Notifications.addNotificationReceivedListener((n) =>
      refresh(n.request.content.data as { tripId?: string } | undefined)
    );
    const responseSub = Notifications.addNotificationResponseReceivedListener((r) =>
      refresh(r.notification.request.content.data as { tripId?: string } | undefined)
    );

    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, [qc]);
}
