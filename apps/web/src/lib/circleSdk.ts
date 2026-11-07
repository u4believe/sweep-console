/**
 * Load Circle's wallet SDK, and say something useful when the chunk is gone.
 *
 * WHY A WRAPPER FOR ONE IMPORT. The SDK is loaded with a dynamic import so it
 * is not in the main bundle — it is large and most sessions never open a
 * wallet. Vite therefore emits it as a hashed chunk, and a deploy replaces
 * every hash. A tab opened before the deploy asks for a filename that no
 * longer exists and gets:
 *
 *   Failed to fetch dynamically imported module: …/assets/index-Ddlst9tV.js
 *
 * Which is true and tells the person nothing they can act on. It happened
 * mid-upgrade on 2026-11-07: the server had already created the Circle user
 * and issued the challenge, and the browser could not open the PIN dialog to
 * finish it — so the account was left pointing at a wallet that did not exist
 * yet, and the message blamed a filename.
 *
 * The fix a person can act on is "reload the page", because the new HTML
 * references the new chunk. So that is what this says.
 */
export async function loadCircleSdk(): Promise<
  typeof import("@circle-fin/w3s-pw-web-sdk")
> {
  try {
    return await import("@circle-fin/w3s-pw-web-sdk");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Vite, Firefox and Safari each word it differently; all three mean the
    // same thing, and matching one browser's phrasing would leave the others
    // showing the raw error.
    const staleChunk =
      /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
        msg
      );
    throw new Error(
      staleChunk
        ? "This page is out of date because the app was updated. Reload the page and try again — nothing has been lost."
        : `Couldn't load the wallet dialog: ${msg}`
    );
  }
}
