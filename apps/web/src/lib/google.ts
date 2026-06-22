// Google Identity Services helper: lazily loads the GSI script and runs the
// OAuth2 implicit flow to get an access token, which the backend exchanges for
// the user's verified email (POST /auth/google). Lets us render our own
// "Continue with Google" button instead of Google's default widget.

const GSI_SRC = "https://accounts.google.com/gsi/client";

export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
export const googleEnabled = Boolean(GOOGLE_CLIENT_ID);

let gsiPromise: Promise<void> | null = null;

function loadGsi(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gsiPromise) return gsiPromise;

  gsiPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    const onReady = () => {
      // The script's onload fires slightly before the global is attached.
      const start = Date.now();
      const tick = () => {
        if (window.google?.accounts?.oauth2) return resolve();
        if (Date.now() - start > 5000) return reject(new Error("Google sign-in failed to load."));
        setTimeout(tick, 50);
      };
      tick();
    };

    if (existing) {
      onReady();
      return;
    }
    const script = document.createElement("script");
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = onReady;
    script.onerror = () => {
      gsiPromise = null;
      reject(new Error("Could not reach Google. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return gsiPromise;
}

/** Opens the Google popup and resolves with an OAuth access token. */
export async function requestGoogleAccessToken(): Promise<string> {
  if (!GOOGLE_CLIENT_ID) throw new Error("Google sign-in isn't configured.");
  await loadGsi();
  const oauth2 = window.google!.accounts!.oauth2!;

  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: "openid email profile",
      callback: (resp) => {
        if (resp.access_token) resolve(resp.access_token);
        else reject(new Error(resp.error ? "Google sign-in failed." : "Google sign-in was cancelled."));
      },
      error_callback: (e) => {
        reject(
          new Error(
            e?.type === "popup_closed" || e?.type === "popup_failed_to_open"
              ? "Google sign-in was cancelled."
              : "Google sign-in failed."
          )
        );
      },
    });
    client.requestAccessToken();
  });
}
