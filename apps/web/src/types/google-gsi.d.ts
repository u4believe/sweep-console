// Minimal typings for the Google Identity Services OAuth2 token client.
// Loaded at runtime from https://accounts.google.com/gsi/client.

interface GoogleTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  scope?: string;
}

interface GoogleTokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}

interface GoogleTokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: GoogleTokenResponse) => void;
  error_callback?: (error: { type?: string; message?: string }) => void;
}

interface GoogleAccountsOAuth2 {
  initTokenClient: (config: GoogleTokenClientConfig) => GoogleTokenClient;
}

interface Window {
  google?: {
    accounts?: {
      oauth2?: GoogleAccountsOAuth2;
    };
  };
}
