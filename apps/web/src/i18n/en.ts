// English text. sv.ts must have the same keys; messages.test.ts checks it.
// Plain strings, or functions for text with numbers or names in it.

import type { LogFields } from "@sigill/protocol";
import type { Kind, Tie } from "../lib/server-facts.ts";

// Every field a server log line can carry (plus `event`, which names the log line), with what it is
// and why we keep it. Keyed by LogFields, so a new field fails the typecheck until it is described
// here and in sv.ts. Event names are typed by LogEvent in @sigill/protocol.
const logFields: Record<"event" | keyof LogFields, readonly [string, string]> = {
  event: [
    "what happened, like a link being opened or a connection being refused",
    "So we can see how the service behaves and find what went wrong.",
  ],
  link: [
    "the first 6 characters of a link ID",
    "So we can follow one link through the log when something goes wrong, without being able to find the link itself.",
  ],
  links: [
    "how many links a sender has",
    "To see how the service is used and to spot a sender with an unusual number of links.",
  ],
  bytes: ["message sizes", "To spot oversized or broken messages and to size the server."],
  reason: [
    "why a link, connection, email or code was refused",
    "To see why connections fail, so we can fix the cause.",
  ],
  code: ["error codes", "To find bugs in the browser app or the server."],
  path: [
    "whether each connection was direct, went through our relay or failed",
    "To know how often connections need our relay, which tells us how big it must be.",
  ],
  port: ["the port the server listens on", "To confirm the server started where it should."],
};

export type Nouns = Record<
  Kind,
  {
    label: string;
    The: string;
    the: string;
    it: string;
    encrypted: string;
    data: string;
    key: string;
    unlocks: string;
    seen: string;
  }
>;

const items: Nouns = {
  file: {
    label: "File data",
    The: "The file",
    the: "the file",
    it: "it",
    encrypted: "encrypted",
    data: "file data",
    key: "the part of that link that unlocks the file",
    unlocks: "the part that unlocks the file",
    seen: "the encrypted file passing through, with its size rounded up so the exact size stays hidden",
  },
  secret: {
    label: "Secret",
    The: "The secret",
    the: "the secret",
    it: "it",
    encrypted: "encrypted",
    data: "secrets",
    key: "the part of that link that unlocks the secret",
    unlocks: "the part that unlocks the secret",
    seen: "the encrypted secret passing through, which shows nothing of its length",
  },
  unknown: {
    label: "Data",
    The: "What is shared",
    the: "what is shared",
    it: "it",
    encrypted: "encrypted",
    data: "what is shared",
    key: "the part of that link that unlocks what is shared",
    unlocks: "the part that unlocks what is shared",
    seen: "the encrypted data passing through, with its size rounded up so the exact size stays hidden",
  },
};

export const en = {
  product: "Fidant",
  // Browser tab titles, one per page (WCAG 2.4.2).
  tabTitles: {
    landing: "Fidant: private file transfer",
    send: "Send a file – Fidant",
    secret: "Share a secret – Fidant",
    receive: "Receive – Fidant",
    privacy: "Privacy – Fidant",
    how: "How it works – Fidant",
    about: "About – Fidant",
    terms: "Terms of use – Fidant",
    security: "Security – Fidant",
    technical: "Technical description – Fidant",
  },
  menu: {
    language: "Language",
    theme: "Theme",
    themes: { system: "System", light: "Light", dark: "Dark" },
    label: "Main",
    send: "Send a file",
    secret: "Share a secret",
    how: "How it works",
    privacy: "Privacy",
  },
  landing: {
    title: "Send a file only the recipient can open.",
    lede: "Fidant encrypts the file in your browser before it goes to the person you choose. It is never stored, and unless you ask us to email the link, nobody in between, us included, can read it.",
    cta: "Send a file",
    how: "Read how it works",
    noAccount: "No account. Nothing stored.",
    linkHeading: "The whole trick is in the link",
    linkId: "Link ID. Our server sees this, only to connect the two browsers.",
    linkKey: "Key. Browsers never send what comes after # to any server.",
    stepsHeading: "What happens",
    steps: [
      ["Choose a file", "It stays on your computer. Nothing is uploaded."],
      ["Add who it's for", "Each person gets their own link, which works once."],
      [
        "Share the link",
        "When they open it, the file goes from your browser to theirs, encrypted the whole way.",
      ],
    ] as ReadonlyArray<readonly [string, string]>,
    neverHeading: "Our server never gets",
    seesHeading: "Our server only sees",
    relayNote:
      "If the two browsers can't connect directly, the file passes through our relay instead, still encrypted. The relay then sees both IP addresses and roughly how big the file is, and can't unlock it.",
    caveat: "The catch: since nothing is stored, keep your tab open until the file has arrived.",
  },
  how: {
    title: "How it works",
    lede: "What happens to your file, step by step. In short: it is locked on your computer, and only someone with the link can unlock it. If you ask us to email the link, that includes us.",
    sections: {
      stays: {
        heading: "Your file stays on your computer",
        body: [
          "You choose a file in your browser. It is not uploaded anywhere.",
          "Your browser locks it before it leaves your computer.",
        ],
      },
      link: {
        heading: "You get a link with the key inside",
        body: [
          "You get one link for each person. Each link works once. You send it yourself, for example by email or chat, or give us their email address and we email it to them.",
          "The key that unlocks the file is the part after the # sign. Browsers never send that part to us, so we never see the key, unless you ask us to email the link. Then your browser gives it to our server once, to put in the email.",
          "Anyone with the link can open the file. A link we email also asks for a code that we email to the same address, so it works for anyone who can read that mailbox. Send each link only to the person it is for.",
        ],
      },
      open: {
        heading: "They open the link while your page is open",
        body: [
          "Nothing is stored, so your page must stay open until they have the file.",
          "Our server helps the two browsers find each other, like an operator connecting a phone call. It passes on a few small locked messages that it can't read, unless it emailed the link and so had the key.",
          "They see the file's name and size and choose whether to download it.",
        ],
      },
      direct: {
        heading: "The file goes straight to them, locked",
        body: [
          "When the networks allow it, the file goes straight from your computer to theirs. It stays locked the whole way.",
          "Their browser unlocks it and checks that it is exactly the file you sent.",
          "Like on a video call, each device can see the other's internet address.",
        ],
      },
      relay: {
        heading: "Sometimes it goes through our relay",
        body: [
          "Some networks can't connect directly to each other. This is common on mobile data and office networks.",
          "Then the file goes through our relay in Stockholm instead, still locked.",
          "The relay can't open the file, and it doesn't keep it.",
          "It sees the internet address of each device and roughly how big the file is.",
        ],
      },
      never: {
        heading: "What we never see",
        body: [
          "Not your file. Not its name. Not the key that unlocks it, unless you ask us to email the link.",
          "That goes for our server and our relay. Our relay never sees the key at all.",
        ],
      },
    },
    more: "Want the details? The privacy page says exactly what our server sees and what it logs.",
    moreLink: "Read the privacy page",
    techLink: "Read the technical description",
  },
  insecure: {
    title: "This page needs a secure connection",
    body: "Files are encrypted in your browser, which only works over a secure connection. Open this page with an address that starts with https://.",
  },
  common: {
    techDetails: "Technical details",
    size: "Size",
    type: "Type",
    typeMissing: "Not given",
    you: "You",
    sender: "Sender",
  },
  connection: {
    why: "Why?",
    more: "More about how it works",
    direct: {
      label: "Direct connection",
      explain:
        "The file goes straight between the two devices. Each side can see the other's internet address, like on a video call.",
    },
    relay: {
      label: "Through our relay",
      explain:
        "The two networks couldn't connect directly, which is common on mobile data and office Wi-Fi. So the file goes through our relay in Stockholm. It stays locked the whole way: the relay can't open it and doesn't keep it. The relay sees both devices' internet addresses and roughly how big the file is.",
    },
  },
  format: {
    bytes: (n: number) => (n === 1 ? "1 byte" : `${n.toLocaleString("en-US")} bytes`),
    progress: (percent: string, done: string, total: string) => `${percent} · ${done} of ${total}`,
  },
  send: {
    fileHeading: "Your file",
    recipientsHeading: "Recipients",
    continue: "Continue",
    back: "Back to the file",
    title: "Send a file",
    lede: "Your file is sent from this browser to the people you choose. It's encrypted the whole way and never uploaded or stored.",
    localhost:
      "This page is open on localhost, so the links won't work on other computers. Open the network address the server printed instead.",
    lostServer:
      "Lost the connection to the server. Trying to reconnect… Files already on their way can finish. Nobody new can connect until it's back, so keep this page open.",
    fromLabel: "Your name",
    optional: "(optional)",
    fromHint: "Shown to the people you send to.",
    fromHintEmail:
      "If we email a link, your name also goes in that email, marked as not verified. Our server puts it there and doesn't keep it.",
    allowRelay: "Allow our relay if a direct connection isn't possible",
    fromError: {
      unsafe: "Your name contains characters that can't be sent. Remove them and try again.",
      tooLong:
        "Your name and the file name are too long together. Shorten your name or rename the file.",
    },
    chooseFile: "Choose a file",
    chooseOther: "Choose a different file",
    orDrop: "or drop it here",
    fileError: {
      unsafe:
        "This file name contains characters that can't be sent. Rename the file and try again.",
      tooLong: "This file name is too long to send. Rename the file and try again.",
    },
    preparing: "Getting the file ready…",
    readFailed: "Couldn't read the file. Choose it again.",
    hashPending: "Not ready yet",
    locked: "Remove everyone to change your name or file.",
    recipientLabel: "Who is it for?",
    recipientPlaceholder: "Their name",
    add: "Add",
    nameError: {
      missing: "Enter a name.",
      taken: "That name is already on the list.",
    },
    emailLabel: "Their email address",
    emailError: "Enter a valid email address, like name@example.com.",
    emailNotice:
      "Fidant emails this link for you, so our server sees its key once. The key isn't stored or logged. The link, key included, stays in their mailbox, so anyone who can read that mailbox could receive the file.",
    fileFirst: "Choose a file first.",
    full: (max: number) => `You can send to up to ${max} people at a time.`,
    oneLinkEach: "Each person gets their own link, which works once.",
    keepOpen: "Keep this tab open until everyone has the file. It's sent from here.",
    recipients: "Recipients",
    status: {
      waiting: (name: string) => `Waiting for ${name}'s link to be opened`,
      connecting: (name: string) => `Connecting through ${name}'s link…`,
      offered: (name: string) => `${name}'s link has been opened`,
      declined: (name: string) =>
        `${name}'s link was opened and the file was declined. The link still works.`,
      receiving: (name: string) => `Sending through ${name}'s link`,
      delivered: (name: string) => `Delivered through ${name}'s link`,
      failed: (name: string) =>
        `The file didn't arrive intact through ${name}'s link. The link can be opened again to retry.`,
    },
    noRelay: (name: string) =>
      `${name}'s link was opened but couldn't connect directly. Allowing our relay may let it connect when they try again.`,
    /** `to` is the masked address, like a***@example.se. */
    mail: {
      sending: (to: string) => `Sending email to ${to}…`,
      sent: (to: string) => `Email sent to ${to}`,
      failed: (to: string) =>
        `Email not sent to ${to}. To try again, remove this recipient and add them again, or add them without an email address and share the link yourself.`,
      limit: (to: string) =>
        `Email not sent to ${to}: too many emails right now. Copy the link and share it yourself.`,
      verifying: (to: string) => `Code sent to ${to}`,
      verified: (to: string) => `Verified with the code sent to ${to}`,
      lost: (to: string) =>
        `The link emailed to ${to} stopped working when the connection to our server dropped. To send it again, remove this recipient and add them again.`,
    },
    progressFor: (name: string) => `Progress for ${name}`,
    copy: "Copy link",
    copyFor: (name: string) => `Copy link for ${name}`,
    copyNote: {
      copied: "Copied",
      failed: "Couldn't copy. Select the link below and copy it yourself.",
    },
    remove: "Remove",
    removeFor: (name: string) => `Remove ${name}`,
    linkFor: (name: string) => `Link for ${name}`,
  },
  receive: {
    connecting: "Connecting to the sender…",
    /** The code step of a link that was emailed. `to` is the masked address, like a***@example.se. */
    verify: {
      title: "Confirm your email to open this link",
      body: (to: string) => `We'll email a code to ${to}.`,
      send: "Send me a code",
      sending: "Sending a code…",
      codeLabel: "Code from the email",
      submit: "Continue",
      results: {
        sent: "Code sent. Check your email.",
        wait: "Too soon for another code. Try again in a moment.",
        limit: "Too many codes for this link. Ask the sender to send you the link again.",
        failed: "We couldn't send the code. Try again in a moment.",
        wrong: "That code is wrong. Try again.",
        expired: "The code has expired. Ask for a new one.",
        tries: "Too many wrong tries. Ask for a new code.",
      },
    },
    /** `from` is the sender's typed name, or "" when they gave none. */
    offerTitle: (from: string) =>
      from ? `${from} wants to send you a file` : "You've been sent a file",
    unverified: "Name typed by the sender, not verified.",
    memoryWarning:
      "This browser keeps the whole file in memory until you save it, which can slow down or crash the tab. Chrome or Edge saves straight to disk.",
    download: "Download",
    decline: "Decline",
    offerCaption: (from: string) =>
      `Sent from ${from ? `${from}'s` : "the sender's"} computer to yours. Encrypted, never stored on a server.`,
    receivingTitle: "Downloading…",
    progressLabel: "Download progress",
    receivingCaption: "Receiving from the sender. Keep this tab open until it's done.",
    doneTitle: "Download complete",
    verified: "We checked it: this is exactly the file that was sent.",
    autoDownload: "Your download should start by itself.",
    savedWhereChosen: "It's saved where you chose.",
    saveFile: "Save file",
    doneCaption: "Sent from the sender's computer to yours. Encrypted the whole way.",
    declinedTitle: "You declined the file",
    declinedBody:
      "You can close this tab. If you change your mind, the link still works while the sender's page is open.",
    showAgain: "Show the file again",
    tryAgain: "Try again",
    whatHappened: "What happened",
    encryptionLabel: "Encryption",
    encryption: "AES-256-GCM, end to end. The key is in your link and never leaves this browser.",
    encryptionEmailed: "AES-256-GCM. Fidant emailed this link, so our server had its key once.",
    sha256Checked: "SHA-256, checked",
    // Keyed by what went wrong; the page stores the key, so a language switch re-renders it.
    problems: {
      badLink: {
        title: "This link doesn't work",
        body: "Part of it may be missing. Check that you copied all of it, or ask the sender to send it again.",
      },
      unknown: {
        title: "This link isn't active",
        body: "The file comes straight from the sender's browser, so the link only works while they have the page open. Ask them for a new link.",
      },
      unbound: {
        title: "This link no longer works",
        body: "Ask the sender to send it again.",
      },
      used: {
        title: "This link has already been used",
        body: "Each link works once. If you still need the file, ask the sender for a new link.",
      },
      busy: {
        title: "This link is open somewhere else",
        body: "Each link can be open in one place at a time. Close the other tab and reload this page.",
      },
      offline: {
        title: "The sender's page is closed",
        body: "The file comes straight from their browser, so it has to stay open. Ask them for a new link.",
      },
      offlineReceiving: {
        title: "The sender's page is closed",
        body: "The file comes straight from their browser, so it has to stay open. The file may not have been saved. Ask them for a new link.",
      },
      lost: {
        title: "The connection to the sender was lost",
        body: "Nothing was saved.",
      },
      lostReceiving: {
        title: "The connection to the sender was lost",
        body: "The file may not have been saved. Try again to make sure you get it.",
      },
      checksum: {
        title: "The file didn't arrive intact",
        body: "It was changed or damaged on the way, so it was not saved. Try again, and tell the sender if it keeps happening.",
        detail: "The SHA-256 checksum of the received file did not match the sender's.",
      },
      invalid: {
        title: "Something went wrong with the transfer",
        body: "The sender's browser sent data we couldn't read, so nothing was saved.",
        detail: "A frame from the sender failed to decrypt or broke the transfer format.",
      },
      save: {
        title: "The file couldn't be saved",
        body: "Check that there's enough space on your disk.",
      },
      create: {
        title: "The file couldn't be created",
        body: "Try again, or choose another place to save it.",
      },
      connect: {
        title: "Couldn't connect to the sender's computer",
        body: "Your two computers couldn't reach each other.",
      },
      noRelay: {
        title: "Couldn't connect directly to the sender",
        body: "The sender doesn't allow our relay, and your networks probably couldn't connect directly. Ask the sender to allow the relay, or try another network, for example your phone's mobile data.",
      },
      server: {
        title: "Couldn't reach the server",
        body: "The server connects you to the sender. Check your internet connection.",
      },
    },
  },
  secret: {
    lede: "Paste a password, an API key or another short secret. It goes from this browser to the people you choose, encrypted the whole way, and is never uploaded or stored.",
    label: "Your secret",
    hint: (max: number) => `Up to ${max.toLocaleString("en-US")} characters.`,
    count: (length: number, max: number) =>
      `${length.toLocaleString("en-US")} of ${max.toLocaleString("en-US")} characters.`,
    tooLong: "Shorten the secret to share it.",
    lostServer:
      "Lost the connection to the server. Trying to reconnect… Secrets already on their way can finish. Nobody new can connect until it's back, so keep this page open.",
    // Only the problems after an offer whose file wording would be wrong; the rest come from receive.problems.
    problems: {
      offline: {
        title: "The sender's page is closed",
        body: "The secret comes straight from their browser, so it has to stay open. Ask them for a new link.",
      },
      offlineReceiving: {
        title: "The sender's page is closed",
        body: "The secret comes straight from their browser, so it has to stay open. The secret wasn't shown. Ask them for a new link.",
      },
      lost: {
        title: "The connection to the sender was lost",
        body: "The secret wasn't shown.",
      },
      lostReceiving: {
        title: "The connection to the sender was lost",
        body: "The secret wasn't shown. Try again to make sure you get it.",
      },
      checksum: {
        title: "The secret didn't arrive intact",
        body: "It was changed or damaged on the way, so it was not shown. Try again, and tell the sender if it keeps happening.",
        detail: "The SHA-256 checksum of the received secret did not match the sender's.",
      },
      invalid: {
        title: "Something went wrong with the transfer",
        body: "The sender's browser sent data we couldn't read, so nothing was shown.",
        detail: "A frame from the sender failed to decrypt or broke the transfer format.",
      },
      save: {
        title: "The secret couldn't be shown",
        body: "This browser couldn't read the secret it received. Ask the sender to send it again.",
      },
    },
    back: "Back to the secret",
    first: "Write or paste the secret first.",
    locked: "Remove everyone to change your name or secret.",
    keepOpen: "Keep this tab open until everyone has the secret. It's sent from here.",
    emailNotice:
      "Fidant emails this link for you, so our server sees its key once. The key isn't stored or logged. The link, key included, stays in their mailbox, so anyone who can read that mailbox could receive the secret.",
    // Only the statuses whose file wording would be wrong; the rest come from send.status.
    status: {
      declined: (name: string) =>
        `${name}'s link was opened and the secret was declined. The link still works.`,
      failed: (name: string) =>
        `The secret didn't arrive intact through ${name}'s link. The link can be opened again to retry.`,
    },
    unsendable: (name: string) =>
      `The secret wasn't sent through ${name}'s link, because its length would have shown on this connection. The link still works.`,
    offerTitle: (from: string) =>
      from ? `${from} sent you a secret` : "You've been sent a secret",
    show: "Show",
    receivingTitle: "Opening the secret…",
    doneTitle: "Here's the secret",
    textLabel: "The secret",
    notSaved: "It isn't saved anywhere. Copy it before you close this tab.",
    copy: "Copy secret",
    copyNote: {
      copied: "Copied",
      failed: "Couldn't copy. Select the secret and copy it yourself.",
    },
    declinedTitle: "You declined the secret",
    showAgain: "Show the secret again",
  },
  server: {
    heading: "What our server has right now",
    seesLabel: "Sees",
    holdsLabel: "Holds",
    passedOnLabel: "Passed on",
    fileDataLabel: (kind: Kind) => items[kind].label,
    logsLabel: "Logs",
    afterwardsLabel: "Afterwards",
    seesSender:
      "Your IP address and the usual browser details any website gets, and the same for each recipient when they open their link.",
    seesRecipient: "Your IP address and the usual browser details any website gets.",
    senderHolds: ({
      online,
      links,
      connected,
      relay,
      emailed,
      sending,
      mailed,
      kind,
    }: {
      kind: Kind;
      online: boolean;
      links: number;
      connected: number;
      /** Whether the sender allows our TURN relay. */
      relay: boolean;
      /** Hosted links the server emails or may be emailing. */
      emailed: number;
      /** Of those, links whose email the server may still be sending. */
      sending: number;
      /** Whether this page ever asked the server to email a link. */
      mailed: boolean;
    }) => {
      if (!online) {
        return mailed
          ? "Only scrambled counts of the emails it sent for you, for up to an hour, once it notices the connection has closed. That takes up to a minute if the network dropped."
          : "Nothing once it notices the connection has closed. That takes up to a minute if the network dropped.";
      }
      const choice = relay
        ? "Your choice to allow our relay."
        : "Your choice not to allow our relay.";
      const counts = mailed
        ? " Scrambled counts of the emails it sent for you, for up to an hour."
        : "";
      if (links === 0) {
        return `No links yet. ${choice}${counts}`;
      }
      const ids = links === 1 ? "The ID of your link" : `The IDs of your ${links} links`;
      const email =
        emailed === 0
          ? ""
          : emailed === 1
            ? " For the link it emails: the recipient's email address and the codes sent there."
            : ` For the ${emailed} links it emails: the recipients' email addresses and the codes sent there.`;
      const key =
        sending === 0
          ? `${ids}, never ${items[kind].unlocks}.${email}`
          : `${ids}.${email} While it sends an email, also ${items[kind].key}, and your name.`;
      const held = `${key} ${choice}${counts}`;
      if (connected === 0) {
        return held;
      }
      const who = connected === 1 ? "1 recipient" : `${connected} recipients`;
      return `${held} ${who} connected right now.`;
    },
    /** `emailed`: the link is one the server emailed. */
    recipientHolds: (tie: Tie, emailed: boolean, kind: Kind) =>
      (emailed
        ? {
            paired: `The ID of your link, your email address, that this tab entered the right code, and that this page is connected to the sender. It had ${items[kind].unlocks} only while it emailed you the link.`,
            unpaired:
              "Your email address, which the sender gave for this link, the latest code it emailed you and whether this tab entered it. Only the sender's page can keep them there.",
            closed:
              "Nothing about this page once it notices the connection has closed, which takes up to a minute if the network dropped, apart from whether this tab entered the right code. Only the sender's page can keep that, your link's ID and your email address there.",
          }
        : {
            paired: `The ID of your link, never ${items[kind].unlocks}, and that this page is connected to the sender.`,
            unpaired:
              "Nothing that ties this page to your link. Only the sender's page can keep your link's ID there.",
            closed:
              "Nothing about this page once it notices the connection has closed, which takes up to a minute if the network dropped. Only the sender's page can keep your link's ID there.",
          })[tie],
    /** `size` is already formatted, like "9.2 KB". `emailed`: the server emailed a link on this page. */
    passedOn: (messages: number, size: string, emailed: boolean) =>
      messages === 0
        ? "Nothing yet."
        : `${messages} ${messages === 1 ? "setup message" : "setup messages"} (${size}), all encrypted so the server can't read them${emailed ? ", except for a link it emailed, whose key it had" : ""}.`,
    fileData: (kind: Kind) => `None. ${items[kind].The} goes directly between browsers.`,
    fileDataRelayed: (kind: Kind) =>
      `None. The browsers couldn't connect directly, so ${items[kind].the} passes ${items[kind].encrypted} through our relay instead.`,
    relaySeesLabel: "Our relay sees",
    relaySees: (kind: Kind) =>
      `Both browsers' IP addresses and ${items[kind].seen}. It can't unlock ${items[kind].the}.`,
    relayLogsLabel: "Our relay logs",
    relayLogs: (kind: Kind) =>
      `Nothing by default. Only while we fix a fault or stop abuse: connection times, IP addresses and how much data passed through, for at most 7 days. Never names, keys or ${items[kind].data}.`,
    relayKeepsLabel: "Our relay keeps",
    relayKeeps: (kind: Kind) =>
      `Nothing of ${items[kind].the} once ${items[kind].it} has passed through. Log lines from fixing a fault or stopping abuse are deleted within 7 days.`,
    /** `mailed`: this page asked the server to email a link. */
    senderAfterwards: (online: boolean, mailed: boolean): string =>
      `${
        online
          ? "When you close this tab, the server forgets your links, within a minute at most. Its log lines stay."
          : "Your links are gone from the server within a minute of the connection closing. Its log lines stay."
      }${mailed ? " So do scrambled counts of the emails it sent for you, for up to an hour." : ""}`,
    /** `emailed`: the link is one the server emailed. */
    afterwardsRecipient: (emailed: boolean): string =>
      emailed
        ? "When this page disconnects, the server drops what it has about this page, within a minute at most, apart from what the code check needs: your email address and whether this tab entered the right code stay until the sender's page closes, and a scrambled count of the codes sent to your address for up to an hour. Its log lines stay."
        : "When this page disconnects, the server drops what it has about this page, within a minute at most. Its log lines stay.",
    logs: (kind: Kind) =>
      `What happened, like a link being opened, with ${new Intl.ListFormat("en", {
        type: "conjunction",
      }).format(
        Object.entries(logFields)
          .filter(([field]) => field !== "event")
          .map(([, [what]]) => what),
      )}. Never names, email addresses, emailed codes, keys, ${items[kind].data} or IP addresses.`,
  },
  footer: {
    label: "Site",
    tagline:
      "Files encrypted in your browser, readable only by the recipient unless you ask us to email the link.",
    about: "About",
    terms: "Terms",
    security: "Security",
    source: "Source code",
    license: "Open source, MIT license",
  },
  preview: {
    title: "Private file transfer with Fidant",
    receiveTitle: "Sent to you with Fidant",
    receiveDescription:
      "Open the link to receive it. It's encrypted the whole way, and the link works only while the sender's page is open.",
  },
  about: {
    title: "About Fidant",
    lede: "Fidant is a way to send a file to someone without trusting anyone in between, including us, unless you ask us to email the link.",
    sections: [
      {
        heading: "Who runs it",
        body: [
          "Fidant is an open-source project with no company behind it yet. It is a proof of concept, not a commercial service.",
          "There are no ads, no accounts and no tracking.",
        ],
      },
      {
        heading: "Check it yourself",
        body: [
          "All the code that runs this site is public under the MIT license. Every claim on the privacy and security pages can be checked against it, and you can run your own copy.",
        ],
        link: ["The code on GitHub", "https://github.com/sigill-labs/sigill"],
      },
      {
        heading: "Contact",
        body: [
          "Questions, bugs and ideas go in the project's issue tracker. Issues are public, so never post files, links or personal details there. To report a security problem, follow the security page instead.",
        ],
        link: ["Open an issue", "https://github.com/sigill-labs/sigill/issues"],
      },
    ] as Sections,
  },
  terms: {
    title: "Terms of use",
    lede: "Short version: Fidant is free, comes as is, and you are responsible for what you send.",
    sections: [
      {
        heading: "As is",
        body: [
          "Fidant is a proof of concept offered free of charge, without any warranty. It can be unavailable, change or stop at any time. Don't rely on it as the only way to get an important file somewhere.",
        ],
      },
      {
        heading: "Your files are yours",
        body: [
          "Files go between browsers, encrypted the whole way. We never have the key, unless you ask us to email a link, and we never keep it, so we can't recover, delete or check your files for you. Only send files you have the right to share, and only to people you mean to share them with.",
          "Don't use Fidant for anything illegal.",
        ],
      },
      {
        heading: "Links",
        body: [
          "Anyone who has a link can open the file it points to. A link we email also needs a code we send to the same address. Each link works once, and only while the sender's page is open.",
        ],
      },
      {
        heading: "Changes",
        body: ["These terms can change. Every change is visible in the project's public history."],
        link: ["History of this text", "https://github.com/sigill-labs/sigill/commits/main"],
      },
    ] as Sections,
  },
  security: {
    title: "Security",
    lede: "How your file is protected, what Fidant doesn't protect against, and how to tell us about a problem.",
    sections: [
      {
        heading: "How the file is protected",
        body: [
          "Your browser encrypts the file with AES-256-GCM before it leaves your computer. The key is in the part of the link after #, which browsers never send to a server. If you ask us to email a link, your browser gives that link's key to our server once, to put in the email, and the server doesn't store or log it.",
          "The file goes directly between the two browsers. If a network blocks that, it passes through our relay instead, still encrypted. Our server only passes on a few small setup messages, which are encrypted so it can't read them, except for a link it emailed, whose key it had.",
          "The recipient's browser checks the file's SHA-256 checksum, so a file that was changed or damaged on the way is not saved.",
        ],
        link: ["The technical description", "/technical"],
      },
      {
        heading: "What it doesn't protect against",
        body: [
          "Anyone who gets hold of a link can open the file, and a link we email also needs a code we send to the same address. Send each link only to the person it is for, over a channel you trust.",
          "A link we email stays in the recipient's mailbox. Anyone who can read that mailbox can also get the code, and so the file. And because our server had that link's key, you have to trust us not to read the file on its way. To avoid both, leave the email address empty and send the link yourself.",
          "The sender's name is typed by the sender and not verified.",
          "The two browsers see each other's IP address, the same as on a video call. When the file goes through our relay, the relay sees both IP addresses and roughly how big the file is.",
          "A computer that is already compromised can read the file before it is encrypted or after it is unlocked.",
          "Fidant has not been independently audited yet.",
        ],
      },
      {
        heading: "Report a vulnerability",
        body: [
          "Please report security problems privately through GitHub, not in a public issue. We'll reply there.",
        ],
        link: [
          "Report privately on GitHub",
          "https://github.com/sigill-labs/sigill/security/advisories/new",
        ],
      },
    ] as Sections,
  },
  // A reader's version of docs/how-fidant-works.md, the source of truth. Change both together.
  technical: {
    title: "Technical description",
    lede: "How Fidant works under the hood, for readers who want to check it: the keys, the encryption, the modes Fidant runs in, how each part protects you, what our servers see and keep at each step, and what Fidant doesn't protect against. The How it works page tells the same story without the technical terms.",
    sections: {
      parts: {
        heading: "The parts",
        body: [
          "Fidant has three parts. The web app runs in the sender's and the recipient's browsers and does all the encryption. Our server, in Stockholm, serves the web app and passes setup messages between the two browsers over a WebSocket. Our relay, on the same machine, tells browsers their public address (STUN) and carries encrypted traffic when two browsers can't reach each other directly (TURN). If a sender asks us to email a link, our server also sends emails through a mail service.",
          "There are no accounts, no database and no file storage. The server holds what it knows only in memory.",
          "All of it is open source, so every statement on this page can be checked against the code.",
        ],
        link: ["The code on GitHub", "https://github.com/sigill-labs/sigill"],
      },
      link: {
        heading: "The link",
        body: [
          "For each recipient, the sender's browser creates a link of the form https://fidant.se/r/<link ID>#<secret>. The link ID is 16 random bytes and the secret 32 random bytes, both from the browser's cryptographic random number generator.",
          "The link ID only names the link: our server uses it to pair the sender with the recipient. The secret is in the fragment, the part after #, which browsers don't send to servers, and the site tells browsers not to send the page address on to other sites either. The app never sends the secret anywhere, unless the sender asks us to email the link (see Emailed links below). Apart from that, it only derives keys from it.",
          "Every recipient gets their own link ID and secret, so one recipient's link says nothing about another's.",
        ],
      },
      keys: {
        heading: "Keys",
        body: [
          "Two keys are derived from the secret with HKDF-SHA-256. Both are AES-256-GCM keys that the browser marks as non-extractable: the page can use them, but can't read them out.",
          "The signal key encrypts the setup messages. Its salt is the link ID.",
          "The file key encrypts every frame between the browsers except the first, INIT, which carries only the random transfer ID. Its salt is a random transfer ID that the sender picks again for every attempt, so a retried transfer never reuses a key and nonce pair.",
        ],
      },
      signal: {
        heading: "Connecting the two browsers",
        body: [
          "The sender's page opens a WebSocket to our server and registers its link IDs. When the recipient opens their link, their page joins with the link ID and a random attempt ID, new for each page load and each retry. The server pairs at most one recipient page with a link at a time and tells both sides.",
          "The browsers then set up a WebRTC connection. The offer, the answer and the network candidates are encrypted with the signal key before they reach our server. Each message is bound to its link, attempt and direction, so the server can't read or change them, can't send a message back to the side that sent it, can't move it to another link and can't replay it into another attempt. Replaying old messages can at most make one attempt fail, which dropping them would do anyway.",
          "This matters beyond privacy: the setup messages carry the fingerprints of WebRTC's own DTLS encryption. Because the server can't change them, it can't put itself between the two browsers. All of this rests on our server not having the key. For a link we email it had the key, so until check words exist it could read and change that link's setup messages and put itself in between.",
          "If the connection to our server drops, both pages try to reconnect by themselves. The sender's page registers its links again, except links we emailed: our server forgot those with the old connection, so they stop working and the sender's page says so. A recipient who was still connecting tries again a few times before giving up. A transfer that has already started doesn't need our server and carries on.",
        ],
      },
      layers: {
        heading: "Two layers of encryption",
        body: [
          "WebRTC encrypts the connection between the browsers with DTLS. Fidant doesn't rely on that alone: every frame after INIT is also encrypted with AES-256-GCM under the file key, which only the two browsers have. For a link we email, our server had the link's secret, which the file key comes from.",
          "Each frame starts with a 10-byte header with its version, kind and sequence number. The header is authenticated with the frame, and the nonce is built from the direction and the sequence number, so the two directions never share a nonce. A browser accepts only the next sequence number, so a dropped, reordered, repeated or altered frame stops the transfer.",
        ],
      },
      frames: {
        heading: "The transfer, frame by frame",
        body: [
          "When the sender chooses the file, their browser computes its SHA-256 checksum.",
          "INIT: the sender sends the transfer ID. It is the only frame not encrypted. Changing it changes the file key, so the next frame fails to decrypt.",
          "META: the file name, size and type and the sender's typed name, encrypted. The recipient sees them and chooses.",
          "ACCEPT or DECLINE: the recipient's answer, encrypted. ACCEPT also proves that the recipient has the key. No file data is sent before it.",
          "CREDIT: how many chunks the sender may send, encrypted. The recipient grants 128 at a time and more as it writes them, so a slow recipient never has more than about 6 MiB waiting. A sender that gets further ahead than that is stopped.",
          "CHUNK: the file in frames of equal size, up to 48 KiB each.",
          "END: the file's exact size and the checksum computed when it was chosen.",
          "RECEIPT: the checksum the recipient computed from what arrived. The sender counts the file as delivered only when it matches.",
        ],
      },
      check: {
        heading: "Checking the file",
        body: [
          "The recipient's browser hashes the file as it arrives, and checks the size, the number of chunks, the padding and the checksum against END. Only when everything matches is the file kept. Any other ending, such as a frame that fails to decrypt or a connection that closes early, throws away what was written.",
          "Chrome and Edge can write the file straight to a place on the disk the recipient chooses. Other browsers collect it in memory and start the download at the end, and for a file over 256 MiB the recipient is warned first. The download is always marked as plain binary data, whatever type the sender claims, so a file can't run as a web page on Fidant's site.",
          "Names with control characters, line separators or the Unicode characters that override or isolate text direction are refused, so a name ending in .exe can't be made to look like one ending in .pdf.",
        ],
      },
      padding: {
        heading: "Hiding the exact size",
        body: [
          "Anyone who can see the encrypted traffic, such as the networks on the way or our relay, sees how big the frames are. So the size is rounded up with the Padmé scheme, which adds at most 12 %, and then to whole chunks. Every chunk frame has the same size, and the padding is zeros that the recipient checks.",
          "The exact size travels only inside the encrypted META and END. META always has the same size, so the length of the file name doesn't show either.",
          "A shared secret is at most 32 KiB, and every shared secret is padded to exactly one chunk. The app enforces this: if a connection only allows messages too small for a 32 KiB chunk, nothing is sent over it, and the sender sees that the secret wasn't sent. With every browser we tested in November 2026 (Chromium, Firefox and WebKit), the chunk is 48 KiB. So every shared secret looks the same on the wire, whatever its length, and the same as any file of up to 48 KiB.",
        ],
      },
      travel: {
        heading: "How the file travels",
        body: [
          "WebRTC tries the direct routes first: over the local network, or through each side's public address, which the browser learns from our STUN service. The file then goes straight between the browsers. The sender's page shows which route each connection took.",
          "If no direct route works, which is common on mobile data and office networks, the traffic goes through our TURN relay in Stockholm. The relay forwards encrypted packets. It can't decrypt them and doesn't store them.",
          "To use the relay a browser needs credentials, which our server creates for each pairing and gives only to the two paired pages. They expire after 5 minutes. Browsers reach the relay over UDP, or over TLS on port 443 where a network allows only web traffic. The relay forwards only over UDP, and only from its own address. It refuses to forward to other machines on private or internal networks (with one accepted exception: the relay's own box, see decision 0007), and limits how many relayed connections run at once.",
          "On every route, each browser sees the other's IP address, like on a video call.",
        ],
      },
      norelay: {
        heading: "Refusing the relay",
        body: [
          "The sender can untick \"Allow our relay if a direct connection isn't possible\". Our server then gives that send no relay credentials, only the STUN address, so an unmodified browser can't use the relay. As a backstop, if the sender's browser still sees a relayed connection, it ends it. File data only flows after the recipient accepts, so in practice that happens before any of it has passed.",
          "The limit: a modified recipient can still send its side through our relay with credentials from another pairing, or through any public relay. That recipient has the key anyway. The choice decides which infrastructure carries the encrypted traffic, not who can read the file.",
        ],
      },
      recipients: {
        heading: "Several recipients and one-time links",
        body: [
          "One send can go to up to 256 people. Each has their own link, key, connection and transfer.",
          "A link counts as used only once the recipient's RECEIPT matches. After that it is refused. A link that is already open in one tab is refused in another.",
          "Until then the link can be opened again: after a decline, a dropped connection or a failed check. Every new attempt has a new transfer ID and so a new file key.",
          "Nothing is stored, so a link works only while the sender's page is open. When it closes, our server forgets its links within a minute.",
        ],
      },
      secret: {
        heading: "Sharing a secret",
        body: [
          "The Share a secret page sends a secret the sender types or pastes the same way as a file: the same keys, frames, checks and one-time links. Nothing is stored, so the sender's page must stay open until each recipient has the shared secret.",
          "The sender's browser turns the shared secret into a file that exists only in memory, with a fixed name and a type that marks it as a shared secret. Like any file's, the name and type travel only inside the encrypted META. A shared secret can have up to 10,000 characters, which is at most 30,000 bytes.",
          "The text box tells the browser to turn off spell checking, autocorrect, automatic capitals, autocomplete, writing suggestions and translation for it.",
          "The recipient's browser treats an offer as a shared secret only if it has exactly that type and is at most 32 KiB. Anything else is offered as a file. For a shared secret, the recipient sees the sender's typed name but not the size, and chooses Show or Decline. After Decline the link still works.",
          "Show keeps the shared secret in the browser's memory, never in a save dialog or a download. Only once the checks against END pass is it decoded and shown, as plain text with translation off. The page inserts it as text and never reads it as HTML. It isn't in a form field, whose contents a browser can save with the session. The Copy secret button puts it on the clipboard.",
          "Our server and relay handle a shared secret like any file. When the Share a secret page is loaded from our server, by typing its address, reloading or following a link, our server can see that someone opened it. The page then opens a signaling connection like every sender page, and moving to it inside the app opens one too. The server never gets the shared secret or its length, and a connection doesn't say which page opened it, but after a full load the server can tie the connection that follows from the same address to the visit and infer that this visitor shares a secret and with how many links. A full load of any other page can give away that the visitor shares a secret too. Each sender page connects when it is first shown and stays connected while the tab is open, so two sender connections open at once from the same address, with no page load between them, most likely mean the visitor opened both the Send a file page and the Share a secret page in one tab. After a full load of the Send a file page, the second connection comes from the Share a secret page. Page visits aren't logged.",
        ],
      },
      email: {
        heading: "Emailed links",
        body: [
          "Whoever sends a file or shares a secret can give a recipient's email address. Their page then sends our server one message with the link ID, the address, the link's secret, the name the sender typed and the page's language. This is the one case where a link's secret leaves the browser.",
          "Our server picks a random value and emails the recipient the link with that value in front of the link's secret: https://fidant.se/r/<link ID>#e.<value>.<secret>. It makes one attempt, with a time limit, and never retries. It has the link's secret and the sender's name only until that attempt ends, and never stores or logs them. The email is plain text. It gives the name the sender typed, marked as not verified, and says nothing about what is sent, not even whether it is a file or a shared secret.",
          "Before it connects, the recipient's page sends the value to our server. Only if it matches does the server show a masked address, like a***@example.se, and on request email a 6-digit code there. A code works for 10 minutes, and 5 wrong tries end it. The right code gets a random token that only that browser tab keeps, and the server connects nobody to an emailed link without one. Someone with only the link ID, or an emailed link that has stopped working, can't see the address, can't make us send codes and can't connect.",
          "Our server keeps the address, the value, the codes and the tokens in memory while the sender's page has the link. When the sender removes the recipient, closes the page or loses the connection to our server, or when the server restarts, all of it is gone and the emailed link stops working. To limit abuse, the server counts emails for an hour under a scrambled form of each address (an HMAC with a random key), never the address itself: at most 20 emails an hour from one connection, 50 from one IP address and 5 to one email address, and at most 5 codes per link, 30 seconds apart, and 10 an hour to one address.",
          "The catch: the key is in the email. Our server had it, our mail service and anyone who reads the email on its way can see it, and it stays in the recipient's mailbox. The code stops a forwarded link or a mail scanner from receiving the file or the shared secret, but not someone who can read that mailbox. And because our server had the key, it could put itself between the two browsers for that link. Check words that both screens show, which are planned, will let you catch that. If you don't want any of this, leave the email address empty and send the link yourself.",
        ],
      },
      site: {
        heading: "The site itself",
        body: [
          "The site is served only over HTTPS, and browsers are told never to use plain HTTP for it. Sending and receiving refuse to run without a secure connection.",
          "A Content Security Policy lets the pages load code, styles, fonts and connections only from our own site, and stops other sites from showing them in a frame. There are no cookies, no third-party scripts and no trackers.",
          "The setup WebSocket refuses connections opened from other sites, and limits protect the server from overload: connections in total and per address, messages per connection, links per sender, the size of each setup message, and the emails and codes described above.",
        ],
      },
      seen: {
        heading: "What our server and relay see and keep",
        body: [
          "Our server sees each page's IP address and browser details, the link IDs, the sender's relay choice, the connection path the sender reports for each attempt (direct, STUN, relay or failed), whether a link was already used, when each side connects and disconnects, and the encrypted setup messages and their sizes. It never sees the file, its name, its type or its exact size, or a shared secret or its length. It never sees a link's secret or the keys and can't read the setup messages, except for a link we email: then it gets that link's secret once to write the email, along with the recipient's email address and the sender's typed name. It keeps what it knows in memory only, and forgets a page within a minute after it disconnects. The exceptions are an emailed link's address, codes and tokens, which stay until the sender's page lets the link go, and the email counts, which last an hour.",
          "Its log lines use a fixed list of fields, such as the first 6 characters of a link ID and whether a connection was direct. Never names, email addresses, codes, keys, file data or IP addresses. They are deleted after 30 days.",
          "Our relay sees both IP addresses and the encrypted traffic, so the file's size only roughly and nothing of a shared secret's length. On port 443 a program on the same server passes each connection to the relay without decrypting it, and logs nothing. The relay keeps no log. Only to fix a fault or stop abuse do we turn one on, with connection times, IP addresses and data volumes, for at most 7 days.",
        ],
        link: ["Every log field, on the privacy page", "/privacy"],
      },
      limits: {
        heading: "What it doesn't protect against",
        body: [
          "The link is the key. Anyone who gets a link can open the file or shared secret behind it until the link has been used. A link we email also needs a code sent to the same address, so anyone who can read that mailbox can open it. Send each link only to the person it is for, over a channel you trust.",
          "For a link we email, our server, our mail service and the recipient's mailbox have the key, and until check words exist our server could put itself between the two browsers.",
          "Your browser runs the code our server sends it. A server that sent different code could read files. The code is public, but browsers can't yet check that what they got matches it.",
          "The sender's name is typed by the sender and not verified.",
          "The other browser sees your IP address. The networks on the way, and our relay when it is used, see both IP addresses, when the transfer happens and roughly how big the file is. Our server sees both IP addresses, which recipient connects to which sender and when, and how many recipients a sender has, and for a link we email, the recipient's email address. So it learns who sends to whom, though not what, unless it puts itself in the middle of a link we emailed.",
          "Malware on either computer can read the file before it is encrypted or after it is decrypted.",
          "When the recipient copies a shared secret, it goes to the device's clipboard, where clipboard history, clipboard sync to other devices and other apps can read it. Once a shared secret has been shown, Fidant can't reach it: it can't take it back or delete it.",
          "Fidant has not been independently audited yet.",
        ],
      },
      planned: {
        heading: "Planned: verified transfers",
        body: [
          "Not built yet. The plan: the recipient signs a receipt with BankID before they can open the file, and the receipt names the file. The file key is split, and our server releases its half only after the receipt is signed. Events go into an audit log that makes tampering visible, anchored with trusted timestamps.",
          "When it ships, this page will describe it as a new mode.",
        ],
        link: [
          "The design records on GitHub",
          "https://github.com/sigill-labs/sigill/tree/main/docs/decisions",
        ],
      },
    } satisfies Record<string, Section>,
    modes: {
      heading: "The modes Fidant runs in",
      body: [
        "Three choices set how a transfer runs: what is sent, how the link reaches the recipient, and which route the encrypted traffic takes. The sections below explain each one in detail.",
      ],
      groups: {
        send: {
          heading: "What is sent",
          items: {
            file: {
              heading: "A file",
              body: "Any file. Its name, size and type travel encrypted, and the recipient sees them and chooses to download it or decline.",
            },
            secret: {
              heading: "A shared secret",
              body: "Up to 10,000 characters the sender types or pastes, such as a password. It travels like a file, padded to one chunk, and the recipient's page shows it as text and never downloads it.",
            },
          },
        },
        link: {
          heading: "How the link reaches the recipient",
          items: {
            own: {
              heading: "The sender passes it on",
              body: "The sender copies each link and sends it themselves, for example by chat or email. The key in the link never reaches our server.",
            },
            emailed: {
              heading: "We email it",
              body: "The sender gives an email address and our server emails the link. The recipient also needs a code sent to that address. Our server and the mail service then see that link's key.",
            },
          },
        },
        route: {
          heading: "The route the traffic takes",
          items: {
            local: {
              heading: "Direct, on the same network",
              body: "When both browsers are on the same local network, they connect over their local addresses. The file goes straight between them, and our server and relay see none of it.",
            },
            stun: {
              heading: "Direct, through public addresses",
              body: "Each browser asks our STUN service for its public address, which shows the relay that IP address and nothing else. The file then goes straight between the browsers over the internet.",
            },
            turn: {
              heading: "Through our relay",
              body: "When no direct route works, the encrypted traffic goes through our TURN relay in Stockholm, over UDP or over TLS on port 443. The relay forwards packets it can't decrypt and doesn't store them.",
            },
            norelay: {
              heading: "Relay refused",
              body: "The sender can refuse our relay for a send. Our server then gives no relay credentials, and a connection with no direct route fails.",
            },
          },
        },
      },
    },
    protect: {
      heading: "How Fidant protects you",
      body: [
        "Each risk, and what in Fidant stands against it. The sections above explain each part.",
      ],
      columns: ["The risk", "What Fidant does"],
      rows: [
        [
          "Our server or our host reads the file",
          "The file is encrypted in your browser with a key from the part of the link after #, which browsers never send to a server. Only someone with the link can decrypt it. The exception is a link we email, whose key our server and the mail service see.",
        ],
        [
          "Our server puts itself between the two browsers",
          "The setup messages are encrypted and bound to their link, attempt and direction. They carry the fingerprints of the WebRTC encryption, which the server therefore can't swap for its own. For a link we email, the server had the key, so this holds only once check words exist (planned).",
        ],
        [
          "The networks on the way or our relay read the traffic",
          "Two layers of encryption: WebRTC's DTLS, and AES-256-GCM under a file key only the two browsers have, new for every attempt.",
        ],
        [
          "The traffic gives away the file name, the exact size or a secret's length",
          "Name, type and size travel only encrypted, in a frame of fixed size. A file is padded so its size shows only roughly, and every shared secret is padded to the same single chunk.",
        ],
        [
          "A piece of the file is changed, dropped, repeated or reordered",
          "Every frame is authenticated and numbered, and the recipient checks the size and the SHA-256 checksum. Anything else stops the transfer and throws away what was written.",
        ],
        [
          "A link is opened twice, or by someone else after delivery",
          "A link is refused once its file is delivered, and in a second tab while it is open in one.",
        ],
        [
          "An emailed link is forwarded or fetched by a mail scanner",
          "The recipient's browser connects only after a 6-digit code sent to the same address. A code works for 10 minutes and 5 wrong tries end it.",
        ],
        [
          "A file disguised by its name, or one that runs as a page",
          "Names that hide their real ending with text direction characters are refused, and downloads are always plain binary data.",
        ],
        [
          "A shared secret lingers in the browser",
          "It is never downloaded or put in a form field, and the browser is told to keep spelling, autocomplete, writing suggestions and translation off it.",
        ],
        [
          "Data left behind on our machines",
          "No accounts, database or file storage. The server holds what it knows only in memory and forgets a page within a minute after it disconnects. Logs have fixed fields, never names, email addresses, codes, keys, file data or IP addresses, and are deleted after 30 days.",
        ],
        [
          "Tracking, or code from other sites",
          "HTTPS only, no cookies, no third-party scripts or trackers, and a Content Security Policy that allows code only from our own site.",
        ],
        [
          "You don't want your traffic through our relay",
          "Untick the relay for that send. Our server then gives no relay credentials, and the sender's browser ends a relayed connection.",
        ],
      ],
    },
    data: {
      heading: "Step by step",
      body: [
        "The same, for each step of a transfer: what our server sees, keeps and logs, and what our relay sees. A shared secret goes through the same steps as a file.",
      ],
      columns: ["Step", "Our server sees", "Our server keeps", "Our server logs", "Our relay"],
      rows: [
        [
          "You open the site",
          "Your IP address and browser details, like any website.",
          "Nothing.",
          "Nothing.",
          "Nothing.",
        ],
        [
          "You choose the file or type the secret, and add recipients",
          "Nothing. Your browser reads the file, computes its checksum and makes the links on its own.",
          "Nothing.",
          "Nothing.",
          "Nothing.",
        ],
        [
          "Your page registers its links",
          "The link IDs, your relay choice and your IP address.",
          "The link IDs and your relay choice, in memory, while your page is open.",
          "That a sender registered, and how many links.",
          "Nothing.",
        ],
        [
          "You ask us to email a link",
          "The recipient's email address, the link's secret, the name you typed and the page's language. The mail service gets the email with the link.",
          "The address, the language and a random value while your page has the link. The secret and your name only until the email is sent or fails. A count of emails per scrambled address, for an hour.",
          "Whether the email was sent, with the first 6 characters of the link ID.",
          "Nothing.",
        ],
        [
          "A recipient on an emailed link enters the code",
          "The value from the link and the code typed.",
          "The latest code with its expiry and tries, and the token a right code gets, while your page has the link.",
          "Each code sent or refused and why, and a right code, with the first 6 characters of the link ID.",
          "Nothing.",
        ],
        [
          "A recipient opens their link",
          "The link ID, a random attempt ID, and the recipient's IP address and browser details.",
          "Which recipient page is paired with which link, in memory.",
          "That a recipient joined or was refused and why, with the first 6 characters of the link ID.",
          "Nothing yet. If you allow the relay, our server gives the two pages credentials for it that expire after 5 minutes.",
        ],
        [
          "The browsers set up the connection",
          "Encrypted setup messages and their sizes. It can't read them, except for a link we emailed.",
          "Nothing. It passes them on.",
          "Each message's size, with the first 6 characters of the link ID.",
          "Each browser's IP address, when it asks for its public address (STUN).",
        ],
        [
          "The file or secret travels",
          "Nothing of it. Your page reports the route: direct, STUN, relay or failed.",
          "Nothing.",
          "The route.",
          "On the relay route only: both IP addresses and the encrypted packets, which it forwards and doesn't store.",
        ],
        [
          "The recipient confirms delivery",
          "Nothing. The receipt goes between the browsers. If the link is opened again, your page refuses it as used.",
          "Nothing.",
          'A later refusal, with the reason "used".',
          "Nothing.",
        ],
        [
          "A page closes",
          "That the page disconnected.",
          "Nothing about that page, within a minute. When your page closes, an emailed link's address, codes and tokens go too.",
          "That a sender left and how many links it had, or that a recipient left, with the first 6 characters of the link ID.",
          "Nothing.",
        ],
        [
          "Afterwards",
          "Nothing.",
          "Only the scrambled email counts, for up to an hour.",
          "Log lines are deleted after 30 days.",
          "No log. Only to fix a fault or stop abuse do we turn one on, with connection times, IP addresses and data volumes, for at most 7 days.",
        ],
      ],
    },
  },
  privacy: {
    title: "Privacy",
    lede: "Your file goes from your browser to the browser of the person you send it to, directly when your networks allow it and otherwise through our relay. It's locked before it leaves your computer, and only the person with the link can unlock it. We never get the file, its name or a secret you share, and never the key unless you ask us to email the link.",
    howHeading: "How sending works",
    // [bold, rest]: the bold part opens each step.
    steps: [
      [
        "You pick a file and add the people to send it to.",
        "The file stays on your computer. Nothing is uploaded.",
      ],
      [
        "You get one link per person.",
        "Each link holds the key that unlocks the file. You send the link yourself, for example by email or chat, or we email it to an address you give us. A link we email also asks for a code we send to the same address.",
      ],
      [
        "They open the link while your page is still open.",
        "Our server helps the two browsers find each other, like an operator connecting a phone call.",
      ],
      ["They see the file name and size and choose to download it, or decline.", ""],
      [
        "The file goes from your computer to theirs, locked the whole way.",
        "It goes directly when your networks allow it, otherwise through our relay. Their browser unlocks it and checks that it is exactly the file you sent.",
      ],
    ] as ReadonlyArray<readonly [string, string]>,
    keepOpen:
      "Because the file is never stored anywhere, keep your page open until everyone has downloaded it.",
    travelHeading: "How the file travels",
    lockedBox:
      "Think of it as handing someone a locked box in person. There is no post office in between that holds on to it, and only someone with the key can open it.",
    // [before, after] a bold "#".
    keyPart: [
      "The key is the last part of the link, after the ",
      " sign. Browsers never send that part to any website, ours included. That is why we can't unlock your file even if we wanted to. The exception is a link you ask us to email: your browser gives its key to our server once, to put in the email, and we don't store or log it.",
    ] as readonly [string, string],
    direct:
      "Because the two browsers connect directly, each can see the other's network address (IP address), the same as on a video call. If a network blocks that, the file passes through our relay instead, still locked. The relay then sees both IP addresses and roughly how big the file is, and can't unlock it.",
    linkWarning:
      "Anyone who has the link can open the file. A link we email also needs a code we send to the same address, so anyone who can read that mailbox can open it. Send each link only to the person it is for.",
    serverHeading: "What our server knows",
    neverHeading: "Never",
    never: [
      ["Your file", "Not the contents, not the file name, not its size or type."],
      [
        "Your secret",
        "Not a secret you share from the Share a secret page, and not its length: every shared secret is padded to the same size before it leaves your browser.",
      ],
      [
        "The key, unless we email the link for you",
        "The part of the link that unlocks the file or the shared secret never reaches us, unless you ask us to email the link. Then our server uses it once to write the email, and doesn't store or log it.",
      ],
      [
        "Recipients' names",
        "Not the names you give the people you send to. Your own name reaches us only if you ask us to email a link: it goes in that email, and we don't keep it.",
      ],
    ] as ReadonlyArray<readonly [string, string]>,
    seesHeading: "Only what it needs to connect you or email a link",
    sees: [
      [
        "Your IP address and browser details",
        "Like any website you visit. We use them only to show you this page and connect you. Our server never writes them to its logs. Our relay logs nothing either, except while we fix a fault or stop abuse (see below).",
      ],
      [
        "A link ID",
        "Each link has a random ID, like a ticket number, so the right two browsers can find each other. It can't unlock anything. We forget it within a minute after the sender's page closes, apart from its first few characters in our log lines.",
      ],
      [
        "Setup messages",
        "A few small, locked messages that help the two browsers connect. We pass them on and don't keep them. We can't read them, except those of a link we emailed, whose key we had.",
      ],
      [
        "The sender's relay choice",
        "Whether the sender allows our relay, so we only give recipients access to it when they do. We forget it within a minute after the sender's page closes, and never write it to our logs.",
      ],
      [
        "If we email a link: the address, the link's key and your name",
        "If you ask us to email a link, your browser sends our server the recipient's email address, the link with its key, and your name. We keep the key and your name only until the email has gone. We keep the address in memory while your page is open, so we can email the recipient a code when they open the link. We also keep the latest code and which browser tabs entered the right one. We never log the address or write it to disk. Our mail service, Amazon SES, delivers the emails, and bounces go only to it, never to a mailbox of ours. Amazon SES keeps an email with a link, and so the key and your name, only until it is delivered: if the recipient's mail server doesn't accept it at once, Amazon SES tries again for at most 15 minutes and then drops it. An address that bounces as undeliverable goes on a list that Amazon SES keeps for all its customers, for up to 14 days, so that nobody sends it more mail. We can't turn that list off.",
      ],
      [
        "Counts of emails",
        "To limit how many emails anyone can send, we count the emails sent to each address and the emails each IP address asks us to send, for an hour. We keep each count under a scrambled form of the address (an HMAC), never the address itself.",
      ],
    ] as ReadonlyArray<readonly [string, string]>,
    keepHeading: "What we keep",
    keep: "We have no accounts, no database, no cookies and no tracking. Apart from the log lines below, a relay log while we fix a fault or stop abuse, the email counts above, which last an hour, and our mail service's list of bounced addresses, nothing is kept once the sender's page is closed, within 2 minutes at most.",
    logFields,
    logRetention: "Log lines are deleted after 30 days.",
    relayLog:
      "Our relay, which carries the locked file when two browsers can't connect directly, keeps no log. Only to fix a fault or stop abuse do we turn one on. It then records, for each relayed connection, both IP addresses and ports, when it started and ended, and how much data passed through. Never names, keys or file data. We turn it off and delete it within 7 days.",
  },
};

export type Messages = typeof en;
/** A text page: each section a heading, paragraphs and an optional [text, href] link. */
export type Section = {
  heading: string;
  body: readonly string[];
  link?: readonly [string, string];
};
export type Sections = ReadonlyArray<Section>;
