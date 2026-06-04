import { useCallback, useEffect, useState } from "react";
import * as AppleAuthentication from "expo-apple-authentication";
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import type { Session } from "@supabase/supabase-js";
import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID, supabase } from "../store/supabase";

// In MOCK_MODE (simulator dev) we bypass real auth with a fake session so the
// app is usable without a sign-in round-trip. Mirrors useMockDiktat.
const MOCK_MODE = __DEV__;

// Configure Google sign-in once. webClientId sets the ID-token audience that
// Supabase validates; iosClientId authorizes the native iOS flow.
GoogleSignin.configure({
  webClientId: GOOGLE_WEB_CLIENT_ID,
  iosClientId: GOOGLE_IOS_CLIENT_ID,
});

const MOCK_SESSION = {
  access_token: "mock-access-token",
  user: { id: "mock-user", email: "dev@diktat.app" },
} as unknown as Session;

export interface AuthApi {
  session: Session | null;
  loading: boolean;
  error: string | null;
  appleAvailable: boolean;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

export function useAuth(): AuthApi {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    AppleAuthentication.isAvailableAsync().then(setAppleAvailable).catch(() => setAppleAvailable(false));
  }, []);

  useEffect(() => {
    if (MOCK_MODE) {
      setSession(MOCK_SESSION);
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const signInWithApple = useCallback(async () => {
    setError(null);
    try {
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!cred.identityToken) throw new Error("No identity token returned from Apple");
      const { error: err } = await supabase.auth.signInWithIdToken({
        provider: "apple",
        token: cred.identityToken,
      });
      if (err) throw err;
    } catch (e: any) {
      if (e?.code === "ERR_REQUEST_CANCELED") return; // user dismissed the sheet
      setError(e?.message ?? "Apple sign-in failed");
    }
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setError(null);
    try {
      await GoogleSignin.hasPlayServices();
      const response = await GoogleSignin.signIn();
      if (!isSuccessResponse(response)) return; // cancelled
      const idToken = response.data.idToken;
      if (!idToken) throw new Error("No ID token returned from Google");
      const { error: err } = await supabase.auth.signInWithIdToken({
        provider: "google",
        token: idToken,
      });
      if (err) throw err;
    } catch (e: any) {
      if (isErrorWithCode(e) && e.code === statusCodes.SIGN_IN_CANCELLED) return;
      setError(e?.message ?? "Google sign-in failed");
    }
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    if (MOCK_MODE) return;
    try {
      await GoogleSignin.signOut();
    } catch {
      /* not signed in with Google — fine */
    }
    await supabase.auth.signOut();
  }, []);

  return { session, loading, error, appleAvailable, signInWithApple, signInWithGoogle, signOut };
}
