// The Modernist transactional email system: one 600px table, six messages.
//
// Every send is built from the pieces here so they stay a family. The rules
// come from the design system and each one is a constraint email imposes:
//
//   • Tables, not divs — Outlook's rendering engine has no flexbox or grid.
//   • Inline styles only — most clients strip <style>, so the media query at
//     the top is a progressive enhancement and nothing depends on it.
//   • Arial, not Archivo — email has no webfonts; the design says so outright.
//   • Image-free — nothing breaks when a client blocks images, because there
//     are none to block.
//   • One button, maximum. Anything else is a text link.
//
// Two senders, and the header says which:
//   ACCOUNT — Sweep Console speaking to you. OTP, verification, password.
//   NOTICE  — Sweep Console speaking to a subscriber for a merchant. The
//             merchant's name leads, because that is who they bought from.

const INK = "#201e1d";
const PAPER = "#f3f2f2";
const OUTER = "#e8e7e6";
const RULE = "#d4d2d0";
const MUTED = "#6a6664";
const BODY = "#3d3937";
const ACCENT = "#2f6fc9";
const ACCENT_DARK = "#1f549e";
const ACCENT_WASH = "#e9eef8";

const FONT = "Arial,Helvetica,sans-serif";

/// Escapes anything interpolated into an email. Plan names, merchant names and
/// email addresses are user-supplied, and a stray `<` would otherwise break the
/// markup — or worse, survive into a client that renders it.
export function esc(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function manageUrl(): string {
  return `${appUrl()}/manage`;
}

function supportAddress(): string {
  return process.env.SUPPORT_EMAIL ?? "support@sweepconsole.com";
}

/// The address mail is sent from, without the display name.
function senderAddress(): string {
  const raw = process.env.EMAIL_FROM ?? process.env.SMTP_FROM ?? "noreply@sweepconsole.com";
  const m = raw.match(/<([^>]+)>/);
  return m ? m[1]!.trim() : raw.trim();
}

export interface ShellOptions {
  /// Sits in the inbox preview line, before any body text. The one piece of
  /// copy most recipients actually read.
  preheader: string;
  /// ACCOUNT puts Sweep Console in the header; NOTICE puts the merchant there.
  sender: "account" | "notice";
  /// Required for "notice" — the merchant the subscriber bought from.
  merchantName?: string;
  /// Small uppercase word above the headline: "Security", "Receipt", "Verify".
  kicker: string;
  title: string;
  /// Already-built HTML rows, from the helpers below.
  body: string;
  /**
   * Replaces the footer's "where to find this" line.
   *
   * The default for a "notice" points at /manage, which lists SUBSCRIPTIONS. A
   * payer on the external rail has none — their authorization is a mandate the
   * developer's own app owns — so the default line would send them to an empty
   * page and imply Sweep can manage something it cannot.
   */
  footerContact?: string;
}

/**
 * Wraps body content in the shell: accent crown, sender header, content, and
 * the footer that names who sent it and says the address takes no replies.
 */
export function shell(o: ShellOptions): string {
  const isNotice = o.sender === "notice";
  const lead = isNotice ? esc(o.merchantName ?? "") : "Sweep&nbsp;Console";
  const rightRail = isNotice ? "Notice<br>via Sweep&nbsp;Console" : "Account";

  const footerContact = o.footerContact
    ? o.footerContact
    : isNotice
    ? `Questions about your subscription? Contact ${esc(o.merchantName ?? "the merchant")} directly.
       Every subscription tied to this email address — across all merchants — is at
       <a href="${manageUrl()}" style="color:${ACCENT_DARK};text-decoration:underline;">${esc(manageUrl().replace(/^https?:\/\//, ""))}</a>.`
    : `Didn't expect this email? Contact
       <a href="mailto:${supportAddress()}" style="color:${ACCENT_DARK};text-decoration:underline;">${esc(supportAddress())}</a>
       — this address doesn't take replies.`;

  const sentBy = isNotice
    ? `Sent by Sweep Console (${esc(senderAddress())}) on behalf of ${esc(o.merchantName ?? "")} · non-custodial`
    : `Sent by Sweep Console (${esc(senderAddress())})`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(o.title)}</title>
<!--[if mso]>
<style>table,td,div,p,a{font-family:Arial,Helvetica,sans-serif !important;}</style>
<![endif]-->
<style>
  @media only screen and (max-width:620px){
    .px{padding-left:24px !important;padding-right:24px !important;}
    .amt{font-size:40px !important;}
    .code{font-size:36px !important;letter-spacing:6px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${OUTER};">
<span style="display:none;font-size:1px;color:${OUTER};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(o.preheader)}</span>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${OUTER};">
<tr><td align="center" style="padding:28px 12px 40px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;background-color:${PAPER};">

  <tr><td height="6" style="height:6px;line-height:6px;font-size:0;background-color:${ACCENT};">&nbsp;</td></tr>

  <tr>
    <td class="px" style="padding:26px 40px 22px 40px;border-bottom:2px solid ${INK};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td width="330" style="width:330px;font-family:${FONT};font-size:20px;line-height:24px;mso-line-height-rule:exactly;font-weight:bold;color:${INK};letter-spacing:-0.3px;">${lead}</td>
        <td width="190" align="right" style="width:190px;font-family:${FONT};font-size:10px;line-height:14px;mso-line-height-rule:exactly;letter-spacing:1.6px;text-transform:uppercase;color:${MUTED};">${rightRail}</td>
      </tr>
      </table>
    </td>
  </tr>

  <tr>
    <td class="px" style="padding:32px 40px 8px 40px;">
      <p style="margin:0 0 10px 0;font-family:${FONT};font-size:10px;line-height:14px;mso-line-height-rule:exactly;letter-spacing:1.6px;text-transform:uppercase;color:${ACCENT};">${esc(o.kicker)}</p>
      <p style="margin:0;font-family:${FONT};font-size:28px;line-height:34px;mso-line-height-rule:exactly;font-weight:bold;color:${INK};letter-spacing:-0.7px;">${esc(o.title)}</p>
    </td>
  </tr>

  ${o.body}

  <tr>
    <td class="px" style="padding:24px 40px 30px 40px;border-top:2px solid ${INK};">
      <p style="margin:0 0 10px 0;font-family:${FONT};font-size:11px;line-height:18px;mso-line-height-rule:exactly;color:${MUTED};">${footerContact}</p>
      <p style="margin:0;font-family:${FONT};font-size:10px;line-height:16px;mso-line-height-rule:exactly;letter-spacing:0.6px;text-transform:uppercase;color:${MUTED};">${sentBy}</p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/* ── body pieces ─────────────────────────────────────────────────────────── */

/// A paragraph of prose under the title.
export function lede(html: string): string {
  return `<tr><td class="px" style="padding:12px 40px 4px 40px;">
    <p style="margin:0;font-family:${FONT};font-size:14px;line-height:22px;mso-line-height-rule:exactly;color:${BODY};">${html}</p>
  </td></tr>`;
}

/// The money shot: an amount at 52px with its currency trailing small.
export function heroAmount(amount: string, currency: string, sub: string): string {
  return `<tr><td class="px" style="padding:22px 40px 30px 40px;border-bottom:1px solid ${RULE};">
    <p class="amt" style="margin:0 0 8px 0;font-family:${FONT};font-size:52px;line-height:54px;mso-line-height-rule:exactly;font-weight:bold;color:${INK};letter-spacing:-1.6px;">
      ${esc(amount)} <span style="font-size:20px;font-weight:normal;color:${MUTED};letter-spacing:0;">${esc(currency)}</span>
    </p>
    <p style="margin:0;font-family:${FONT};font-size:14px;line-height:22px;mso-line-height-rule:exactly;color:${BODY};">${sub}</p>
  </td></tr>`;
}

/// A one-time code, sized to be read off a phone.
export function codeBlock(code: string): string {
  return `<tr><td class="px" style="padding:24px 40px 28px 40px;border-bottom:1px solid ${RULE};">
    <p class="code" style="margin:0;font-family:${FONT};font-size:46px;line-height:52px;mso-line-height-rule:exactly;font-weight:bold;color:${INK};letter-spacing:10px;">${esc(code)}</p>
  </td></tr>`;
}

export interface DetailRow {
  k: string;
  /// Pre-escaped HTML — pass a link or a monospace span if needed.
  v: string;
  /// Renders the value in the accent, for "Covered" and similar.
  accent?: boolean;
}

/// The label/value ledger. The last row closes on a 2px ink rule.
export function detailRows(rows: DetailRow[]): string {
  const cells = rows
    .map((r, i) => {
      const last = i === rows.length - 1;
      const border = `border-bottom:${last ? `2px solid ${INK}` : `1px solid ${RULE}`};`;
      return `<tr>
        <td width="180" style="width:180px;padding:14px 0;${border}font-family:${FONT};font-size:12px;line-height:18px;mso-line-height-rule:exactly;color:${MUTED};">${esc(r.k)}</td>
        <td width="340" align="right" style="width:340px;padding:14px 0;${border}font-family:${FONT};font-size:13px;line-height:18px;mso-line-height-rule:exactly;color:${r.accent ? ACCENT : INK};">${r.v}</td>
      </tr>`;
    })
    .join("");
  return `<tr><td class="px" style="padding:8px 40px 0 40px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;">${cells}</table>
  </td></tr>`;
}

/// A washed panel for the one fact worth pulling out of the ledger.
export function panel(kicker: string, headline: string, body: string): string {
  return `<tr><td class="px" style="padding:26px 40px;background-color:${ACCENT_WASH};border-bottom:1px solid ${RULE};">
    <p style="margin:0 0 6px 0;font-family:${FONT};font-size:10px;line-height:14px;mso-line-height-rule:exactly;letter-spacing:1.6px;text-transform:uppercase;color:${ACCENT_DARK};">${esc(kicker)}</p>
    <p style="margin:0 0 4px 0;font-family:${FONT};font-size:22px;line-height:28px;mso-line-height-rule:exactly;font-weight:bold;color:${INK};letter-spacing:-0.4px;">${esc(headline)}</p>
    <p style="margin:0;font-family:${FONT};font-size:13px;line-height:21px;mso-line-height-rule:exactly;color:${BODY};">${body}</p>
  </td></tr>`;
}

/// Inverted to solid ink. For the "wasn't you?" case, where urgency has to come
/// from the system's own contrast rather than a borrowed red.
export function alarm(kicker: string, body: string): string {
  return `<tr><td class="px" style="padding:24px 40px;background-color:${INK};">
    <p style="margin:0 0 8px 0;font-family:${FONT};font-size:10px;line-height:14px;mso-line-height-rule:exactly;letter-spacing:1.6px;text-transform:uppercase;color:#b9b6b3;">${esc(kicker)}</p>
    <p style="margin:0;font-family:${FONT};font-size:14px;line-height:22px;mso-line-height-rule:exactly;color:#f3f2f2;">${body}</p>
  </td></tr>`;
}

/// At most one per email.
export function button(label: string, href: string): string {
  return `<tr><td class="px" style="padding:28px 40px 8px 40px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr><td bgcolor="${ACCENT}" style="background-color:${ACCENT};border-radius:0;">
      <a href="${href}" style="display:block;padding:14px 26px;font-family:${FONT};font-size:14px;line-height:18px;mso-line-height-rule:exactly;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(label)}</a>
    </td></tr>
    </table>
  </td></tr>`;
}

/// Small print above the footer rule.
export function fineprint(html: string): string {
  return `<tr><td class="px" style="padding:16px 40px 28px 40px;">
    <p style="margin:0;font-family:${FONT};font-size:12px;line-height:20px;mso-line-height-rule:exactly;color:${MUTED};">${html}</p>
  </td></tr>`;
}

/// A URL printed for clients that strip links.
export function fallbackUrl(label: string, url: string): string {
  return `<tr><td class="px" style="padding:18px 40px 0 40px;">
    <p style="margin:0 0 6px 0;font-family:${FONT};font-size:10px;line-height:14px;mso-line-height-rule:exactly;letter-spacing:1.6px;text-transform:uppercase;color:${MUTED};">${esc(label)}</p>
    <p style="margin:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:19px;word-break:break-all;color:${BODY};">${esc(url)}</p>
  </td></tr>`;
}

export const emailLink = (text: string, href: string) =>
  `<a href="${href}" style="color:${ACCENT_DARK};text-decoration:underline;">${esc(text)}</a>`;

export const mono = (text: string) =>
  `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;">${esc(text)}</span>`;
