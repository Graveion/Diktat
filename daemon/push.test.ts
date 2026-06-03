import { test, expect, afterEach } from "bun:test";
import { sendPushNotification } from "./push";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("sendPushNotification: POSTs the correct Expo payload shape", async () => {
  let captured: { url: any; init: any } | undefined;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url, init };
    return new Response("{}", { status: 200 });
  }) as any;

  await sendPushNotification("ExponentPushToken[abc]", "Title here", "Body here", { sessionId: "s1" });

  expect(captured).toBeDefined();
  expect(captured!.url).toBe("https://exp.host/--/api/v2/push/send");
  expect(captured!.init.method).toBe("POST");
  expect(captured!.init.headers["Content-Type"]).toBe("application/json");

  const body = JSON.parse(captured!.init.body);
  expect(body).toEqual({
    to: "ExponentPushToken[abc]",
    title: "Title here",
    body: "Body here",
    sound: "default",
    priority: "high",
    data: { sessionId: "s1" },
  });
});

test("sendPushNotification: defaults data to {} when omitted", async () => {
  let body: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    return new Response("{}", { status: 200 });
  }) as any;

  await sendPushNotification("tok", "t", "b");
  expect(body.data).toEqual({});
});

test("sendPushNotification: swallows a fetch rejection (no throw)", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as any;

  // Must resolve, not reject.
  await expect(sendPushNotification("tok", "t", "b")).resolves.toBeUndefined();
});
