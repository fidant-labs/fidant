import { readFileSync } from "node:fs";
import type { EmailMessage } from "@fidant/protocol";
import { createTransport } from "nodemailer";

type Lang = EmailMessage["lang"];

/** `from` is the name the sender typed, unverified; the server passes the link it built in `url`. */
export type Mail =
  | { to: string; lang: Lang; url: string; from: string }
  | { to: string; lang: Lang; code: string };

/** Sends one mail. Rejects with an error that says nothing about the mail or the address. */
export type Mailer = (mail: Mail) => Promise<void>;

const TEXT = {
  en: {
    noticeSubject: "A link for you on Fidant",
    named: (name: string) =>
      `${name} (name typed by the sender, not verified) wants to send you a file or a secret.`,
    someone: "Someone wants to send you a file or a secret.",
    open: "Open this link to get it:",
    noticeEnd: [
      "What they send is not stored anywhere. The link works only while the sender's page is open.",
      "On the link's page, ask for a code. We will email it to this address.",
    ],
    codeSubject: "Your Fidant code",
    code: (code: string) => `Your code: ${code}`,
    codeEnd: [
      "Enter it on the link's page. It works for 10 minutes.",
      "If you did not open a link from Fidant, you can ignore this email.",
    ],
  },
  sv: {
    noticeSubject: "En länk till dig på Fidant",
    named: (name: string) =>
      `${name} (namn som avsändaren skrivit in, inte verifierat) vill skicka en fil eller en hemlighet till dig.`,
    someone: "Någon vill skicka en fil eller en hemlighet till dig.",
    open: "Öppna länken för att hämta den:",
    noticeEnd: [
      "Det som skickas sparas inte någonstans. Länken fungerar bara medan avsändarens sida är öppen.",
      "Be om en kod på länkens sida. Vi mejlar den till den här adressen.",
    ],
    codeSubject: "Din kod från Fidant",
    code: (code: string) => `Din kod: ${code}`,
    codeEnd: [
      "Skriv in den på länkens sida. Den gäller i 10 minuter.",
      "Om du inte har öppnat en länk från Fidant kan du strunta i det här mejlet.",
    ],
  },
};

export function compose(mail: Mail): { subject: string; text: string } {
  const text = TEXT[mail.lang];
  if ("code" in mail) {
    return {
      subject: text.codeSubject,
      text: [text.code(mail.code), ...text.codeEnd].join("\n\n"),
    };
  }
  const name = mail.from.trim();
  const lines = [name ? text.named(name) : text.someone, `${text.open}\n${mail.url}`];
  return { subject: text.noticeSubject, text: [...lines, ...text.noticeEnd].join("\n\n") };
}

/** Plain SMTP is allowed only to this machine; every other host must upgrade with STARTTLS. */
export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function smtpMailer(config: {
  url: string;
  from: string;
  password?: string | undefined;
}): Mailer {
  const url = URL.parse(config.url);
  if (!url || (url.protocol !== "smtp:" && url.protocol !== "smtps:") || !url.hostname) {
    throw new Error("MAIL_SMTP_URL must be an smtp:// or smtps:// URL with a host.");
  }
  if (url.password) {
    throw new Error(
      "Put the SMTP password in the file named by MAIL_PASSWORD_FILE, not in the URL.",
    );
  }
  if (config.password && !url.username) {
    throw new Error("MAIL_SMTP_URL needs a user name when MAIL_PASSWORD_FILE is set.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const secure = url.protocol === "smtps:";
  const transport = createTransport({
    host,
    port: Number(url.port) || (secure ? 465 : 587),
    secure,
    requireTLS: Boolean(config.password) || !isLoopback(host),
    auth: config.password
      ? { user: decodeURIComponent(url.username), pass: config.password }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return async (mail) => {
    try {
      await transport.sendMail({ from: config.from, to: mail.to, ...compose(mail) });
    } catch {
      // SMTP errors can quote the address, so none of it travels further.
      throw new Error("mail not sent");
    }
  };
}

/**
 * The server's mail, from its environment, or undefined when mail is off. Without MAIL_ENABLED=1
 * (`site.mail`) the mail settings are ignored, so a box that has them sends nothing
 * (docs/decisions/0030-email-off-until-verified-transfers.md). Emailed links point at
 * PUBLIC_ORIGIN, never at whatever Host a request names. Throws with a message that echoes
 * nothing from the configuration.
 */
export function mailService(
  env: Record<string, string | undefined>,
  site: { mail: boolean; origin: string | undefined },
): { send: Mailer; origin: string } | undefined {
  if (!site.mail) {
    return undefined;
  }
  const { MAIL_SMTP_URL: url, MAIL_FROM: from, MAIL_PASSWORD_FILE: passwordFile } = env;
  if (!url || !from || !site.origin) {
    throw new Error(
      "MAIL_ENABLED=1 needs MAIL_SMTP_URL and MAIL_FROM together with PUBLIC_ORIGIN.",
    );
  }
  let password: string | undefined;
  if (passwordFile) {
    try {
      password = readFileSync(passwordFile, "utf8").trim();
    } catch {
      throw new Error("Could not read the file named by MAIL_PASSWORD_FILE.");
    }
    if (!password) {
      throw new Error("The file named by MAIL_PASSWORD_FILE must not be empty.");
    }
  }
  return { send: smtpMailer({ url, from, password }), origin: site.origin };
}
