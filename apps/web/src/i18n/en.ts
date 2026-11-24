// English text. sv.ts must have the same keys; messages.test.ts checks it.
// Plain strings, or functions for text with numbers or names in it.

import type { LogFields } from "@sigill/protocol";
import type { Tie } from "../lib/server-facts.ts";

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

export const en = {
  product: "Fidant",
  // Browser tab titles, one per page (WCAG 2.4.2).
  tabTitles: {
    landing: "Fidant: private file transfer",
    send: "Send a file – Fidant",
    receive: "Receive a file – Fidant",
    privacy: "Privacy – Fidant",
    how: "How it works – Fidant",
    about: "About – Fidant",
    terms: "Terms of use – Fidant",
    security: "Security – Fidant",
  },
  menu: {
    language: "Language",
    theme: "Theme",
    themes: { system: "System", light: "Light", dark: "Dark" },
    label: "Main",
    send: "Send a file",
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
  server: {
    heading: "What our server has right now",
    seesLabel: "Sees",
    holdsLabel: "Holds",
    passedOnLabel: "Passed on",
    fileDataLabel: "File data",
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
    }: {
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
          ? `${ids}, never the part that unlocks the file.${email}`
          : `${ids}.${email} While it sends an email, also the part of that link that unlocks the file, and your name.`;
      const held = `${key} ${choice}${counts}`;
      if (connected === 0) {
        return held;
      }
      const who = connected === 1 ? "1 recipient" : `${connected} recipients`;
      return `${held} ${who} connected right now.`;
    },
    /** `emailed`: the link is one the server emailed. */
    recipientHolds: (tie: Tie, emailed: boolean) =>
      (emailed
        ? {
            paired:
              "The ID of your link, your email address, that this tab entered the right code, and that this page is connected to the sender. It had the part that unlocks the file only while it emailed you the link.",
            unpaired:
              "Your email address, which the sender gave for this link, the latest code it emailed you and whether this tab entered it. Only the sender's page can keep them there.",
            closed:
              "Nothing about this page once it notices the connection has closed, which takes up to a minute if the network dropped, apart from whether this tab entered the right code. Only the sender's page can keep that, your link's ID and your email address there.",
          }
        : {
            paired:
              "The ID of your link, never the part that unlocks the file, and that this page is connected to the sender.",
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
    fileData: "None. The file goes directly between browsers.",
    fileDataRelayed:
      "None. The browsers couldn't connect directly, so the file passes encrypted through our relay instead.",
    relaySeesLabel: "Our relay sees",
    relaySees:
      "Both browsers' IP addresses and the encrypted file passing through, with its size rounded up so the exact size stays hidden. It can't unlock the file.",
    relayLogsLabel: "Our relay logs",
    relayLogs:
      "Nothing by default. Only while we fix a fault or stop abuse: connection times, IP addresses and how much data passed through, for at most 7 days. Never names, keys or file data.",
    relayKeepsLabel: "Our relay keeps",
    relayKeeps:
      "Nothing of the file once it has passed through. Log lines from fixing a fault or stopping abuse are deleted within 7 days.",
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
    logs: `What happened, like a link being opened, with ${new Intl.ListFormat("en", {
      type: "conjunction",
    }).format(
      Object.entries(logFields)
        .filter(([field]) => field !== "event")
        .map(([, [what]]) => what),
    )}. Never names, email addresses, emailed codes, keys, file data or IP addresses.`,
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
  privacy: {
    title: "Privacy",
    lede: "Your file goes from your browser to the browser of the person you send it to, directly when your networks allow it and otherwise through our relay. It's locked before it leaves your computer, and only the person with the link can unlock it. We never get the file or its name, and never the key unless you ask us to email the link.",
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
        "The key, unless we email the link for you",
        "The part of the link that unlocks the file never reaches us, unless you ask us to email the link. Then our server uses it once to write the email, and doesn't store or log it.",
      ],
      [
        "Recipients' names",
        "Not the names you give the people you send to. Your own name reaches us only if you ask us to email a link: it goes in that email, and we don't keep it.",
      ],
    ] as ReadonlyArray<readonly [string, string]>,
    seesHeading: "Only what it needs to connect you",
    sees: [
      [
        "Your IP address and browser details",
        "Like any website you visit. We use them only to show you this page and connect you, and never write them to our logs.",
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
        "An email address, if you give one",
        "If you ask us to email a link, your browser sends our server the recipient's email address, the link with its key, and your name. We keep the key and your name only until the email has gone. We keep the address in memory while your page is open, so we can email the recipient a code when they open the link. We also keep the latest code and which browser tabs entered the right one. We never log the address or write it to disk. Our mail service, Amazon SES, delivers the emails, and bounces go only to it, never to a mailbox of ours. An address that bounces as undeliverable goes on a list that Amazon SES keeps for all its customers, for up to 14 days, so that nobody sends it more mail. We can't turn that list off.",
      ],
      [
        "Counts of emails",
        "To limit how many emails anyone can send, we count the emails sent to each address and the emails each IP address asks us to send, for an hour. We keep each count under a scrambled form of the address (an HMAC), never the address itself.",
      ],
    ] as ReadonlyArray<readonly [string, string]>,
    keepHeading: "What we keep",
    keep: "We have no accounts, no database, no cookies and no tracking. Apart from the log lines below and the email counts above, which last an hour, nothing is kept once the sender's page is closed, within a minute at most.",
    logFields,
    logRetention: "Log lines are deleted after 30 days.",
  },
};

export type Messages = typeof en;
/** A text page: each section a heading, paragraphs and an optional [text, href] link. */
export type Sections = ReadonlyArray<{
  heading: string;
  body: readonly string[];
  link?: readonly [string, string];
}>;
