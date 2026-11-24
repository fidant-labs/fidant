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
    "why a link or connection was refused",
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
    lede: "Fidant encrypts the file in your browser before it goes to the person you choose. It is never stored, and nobody in between, us included, can read it.",
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
    lede: "What happens to your file, step by step. In short: it is locked on your computer, and only someone with the link can unlock it.",
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
          "You get one link for each person. Each link works once. You send it yourself, for example by email or chat.",
          "The key that unlocks the file is the part after the # sign. Browsers never send that part to us, so we never see the key.",
          "Anyone with the link can open the file. Send each link only to the person it is for.",
        ],
      },
      open: {
        heading: "They open the link while your page is open",
        body: [
          "Nothing is stored, so your page must stay open until they have the file.",
          "Our server helps the two browsers find each other, like an operator connecting a phone call. It passes on a few small locked messages that it can't read.",
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
          "Not your file. Not its name. Not the key that unlocks it.",
          "That goes for our server and our relay.",
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
    lede: "Paste a password, an API key or any short text. It goes from this browser to the people you choose, encrypted the whole way, and is never uploaded or stored.",
    label: "Your text",
    hint: (max: number) => `Up to ${max.toLocaleString("en-US")} characters.`,
    lostServer:
      "Lost the connection to the server. Trying to reconnect… Texts already on their way can finish. Nobody new can connect until it's back, so keep this page open.",
    // Only the problems after an offer whose file wording would be wrong; the rest come from receive.problems.
    problems: {
      offline: {
        title: "The sender's page is closed",
        body: "The text comes straight from their browser, so it has to stay open. Ask them for a new link.",
      },
      offlineReceiving: {
        title: "The sender's page is closed",
        body: "The text comes straight from their browser, so it has to stay open. The text wasn't shown. Ask them for a new link.",
      },
      lost: {
        title: "The connection to the sender was lost",
        body: "The text wasn't shown.",
      },
      lostReceiving: {
        title: "The connection to the sender was lost",
        body: "The text wasn't shown. Try again to make sure you get it.",
      },
      checksum: {
        title: "The text didn't arrive intact",
        body: "It was changed or damaged on the way, so it was not shown. Try again, and tell the sender if it keeps happening.",
        detail: "The SHA-256 checksum of the received text did not match the sender's.",
      },
      invalid: {
        title: "Something went wrong with the transfer",
        body: "The sender's browser sent data we couldn't read, so nothing was shown.",
        detail: "A frame from the sender failed to decrypt or broke the transfer format.",
      },
    },
    back: "Back to the text",
    first: "Write or paste the text first.",
    locked: "Remove everyone to change your name or text.",
    keepOpen: "Keep this tab open until everyone has the text. It's sent from here.",
    // Only the statuses whose file wording would be wrong; the rest come from send.status.
    status: {
      declined: (name: string) =>
        `${name}'s link was opened and the text was declined. The link still works.`,
      failed: (name: string) =>
        `The text didn't arrive intact through ${name}'s link. The link can be opened again to retry.`,
    },
    offerTitle: (from: string) => (from ? `${from} sent you a text` : "You've been sent a text"),
    show: "Show",
    receivingTitle: "Opening the text…",
    doneTitle: "Here's the text",
    textLabel: "The text",
    notSaved: "It isn't saved anywhere. Copy it before you close this tab.",
    copy: "Copy text",
    copyNote: {
      copied: "Copied",
      failed: "Couldn't copy. Select the text and copy it yourself.",
    },
    declinedTitle: "You declined the text",
    showAgain: "Show the text again",
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
    }: {
      online: boolean;
      links: number;
      connected: number;
      /** Whether the sender allows our TURN relay. */
      relay: boolean;
    }) => {
      if (!online) {
        return "Nothing once it notices the connection has closed. That takes up to a minute if the network dropped.";
      }
      const choice = relay
        ? "Your choice to allow our relay."
        : "Your choice not to allow our relay.";
      if (links === 0) {
        return `No links yet. ${choice}`;
      }
      const ids =
        links === 1
          ? "The ID of your link, never the part that unlocks the file."
          : `The IDs of your ${links} links, never the part that unlocks the file.`;
      const held = `${ids} ${choice}`;
      if (connected === 0) {
        return held;
      }
      const who = connected === 1 ? "1 recipient" : `${connected} recipients`;
      return `${held} ${who} connected right now.`;
    },
    recipientHolds: (tie: Tie) =>
      ({
        paired:
          "The ID of your link, never the part that unlocks the file, and that this page is connected to the sender.",
        unpaired:
          "Nothing that ties this page to your link. Only the sender's page can keep your link's ID there.",
        closed:
          "Nothing about this page once it notices the connection has closed, which takes up to a minute if the network dropped. Only the sender's page can keep your link's ID there.",
      })[tie],
    /** `size` is already formatted, like "9.2 KB". */
    passedOn: (messages: number, size: string) =>
      messages === 0
        ? "Nothing yet."
        : `${messages} ${messages === 1 ? "setup message" : "setup messages"} (${size}), all encrypted so the server can't read them.`,
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
    senderAfterwards: (online: boolean): string =>
      online
        ? "When you close this tab, the server forgets your links, within a minute at most. Its log lines stay."
        : "Your links are gone from the server within a minute of the connection closing. Its log lines stay.",
    afterwardsRecipient:
      "When this page disconnects, the server drops what it has about this page, within a minute at most. Its log lines stay.",
    logs: `What happened, like a link being opened, with ${new Intl.ListFormat("en", {
      type: "conjunction",
    }).format(
      Object.entries(logFields)
        .filter(([field]) => field !== "event")
        .map(([, [what]]) => what),
    )}. Never names, keys, file data or IP addresses.`,
  },
  footer: {
    label: "Site",
    tagline: "Files encrypted in your browser, readable only by the recipient.",
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
    lede: "Fidant is a way to send a file to someone without trusting anyone in between, including us.",
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
          "Files go between browsers, encrypted the whole way, and we never have the key, so we can't read, recover, delete or check them for you. Only send files you have the right to share, and only to people you mean to share them with.",
          "Don't use Fidant for anything illegal.",
        ],
      },
      {
        heading: "Links",
        body: [
          "Anyone who has a link can open the file it points to. Each link works once, and only while the sender's page is open.",
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
          "Your browser encrypts the file with AES-256-GCM before it leaves your computer. The key is in the part of the link after #, which browsers never send to a server.",
          "The file goes directly between the two browsers. If a network blocks that, it passes through our relay instead, still encrypted. Our server only passes on a few small setup messages, which are encrypted so it can't read them.",
          "The recipient's browser checks the file's SHA-256 checksum, so a file that was changed or damaged on the way is not saved.",
        ],
        link: ["The technical description", "/technical"],
      },
      {
        heading: "What it doesn't protect against",
        body: [
          "Anyone who gets hold of a link can open the file. Send each link only to the person it is for, over a channel you trust.",
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
    lede: "How Fidant works under the hood, for readers who want to check it: the keys, the encryption, how the file travels, what our servers see and what Fidant doesn't protect against. The How it works page tells the same story without the technical terms.",
    sections: [
      {
        heading: "The parts",
        body: [
          "Fidant has three parts. The web app runs in the sender's and the recipient's browsers and does all the encryption. Our server, in Stockholm, serves the web app and passes setup messages between the two browsers over a WebSocket. Our relay, on the same machine, tells browsers their public address (STUN) and carries encrypted traffic when two browsers can't reach each other directly (TURN).",
          "There are no accounts, no database and no file storage. The server holds what it knows only in memory.",
          "All of it is open source, so every statement on this page can be checked against the code.",
        ],
        link: ["The code on GitHub", "https://github.com/sigill-labs/sigill"],
      },
      {
        heading: "The link",
        body: [
          "For each recipient, the sender's browser creates a link of the form https://fidant.se/r/<link ID>#<secret>. The link ID is 16 random bytes and the secret 32 random bytes, both from the browser's cryptographic random number generator.",
          "The link ID only names the link: our server uses it to pair the sender with the recipient. The secret is in the fragment, the part after #, which browsers don't send to servers, and the site tells browsers not to send the page address on to other sites either. The app never sends the secret anywhere. It only derives keys from it.",
          "Every recipient gets their own link ID and secret, so one recipient's link says nothing about another's.",
        ],
      },
      {
        heading: "Keys",
        body: [
          "Two keys are derived from the secret with HKDF-SHA-256. Both are AES-256-GCM keys that the browser marks as non-extractable: the page can use them, but can't read them out.",
          "The signal key encrypts the setup messages. Its salt is the link ID.",
          "The file key encrypts every frame between the browsers except the first, INIT, which carries only the random transfer ID. Its salt is a random transfer ID that the sender picks again for every attempt, so a retried transfer never reuses a key and nonce pair.",
        ],
      },
      {
        heading: "Connecting the two browsers",
        body: [
          "The sender's page opens a WebSocket to our server and registers its link IDs. When the recipient opens their link, their page joins with the link ID and a random attempt ID, new for each page load and each retry. The server pairs at most one recipient page with a link at a time and tells both sides.",
          "The browsers then set up a WebRTC connection. The offer, the answer and the network candidates are encrypted with the signal key before they reach our server. Each message is bound to its link, attempt and direction, so the server can't read or change them, can't send a message back to the side that sent it, can't move it to another link and can't replay it into another attempt. Replaying old messages can at most make one attempt fail, which dropping them would do anyway.",
          "This matters beyond privacy: the setup messages carry the fingerprints of WebRTC's own DTLS encryption. Because the server can't change them, it can't put itself between the two browsers.",
          "If the connection to our server drops, both pages try to reconnect by themselves. The sender's page registers its links again, and a recipient who was still connecting tries again a few times before giving up. A transfer that has already started doesn't need our server and carries on.",
        ],
      },
      {
        heading: "Two layers of encryption",
        body: [
          "WebRTC encrypts the connection between the browsers with DTLS. Fidant doesn't rely on that alone: every frame after INIT is also encrypted with AES-256-GCM under the file key, which only the two browsers have.",
          "Each frame starts with a 10-byte header with its version, kind and sequence number. The header is authenticated with the frame, and the nonce is built from the direction and the sequence number, so the two directions never share a nonce. A browser accepts only the next sequence number, so a dropped, reordered, repeated or altered frame stops the transfer.",
        ],
      },
      {
        heading: "The transfer, frame by frame",
        body: [
          "When the sender chooses the file, their browser computes its SHA-256 checksum.",
          "INIT: the sender sends the transfer ID. It is the only frame not encrypted. Changing it changes the file key, so the next frame fails to decrypt.",
          "META: the file name, size and type and the sender's typed name, encrypted. The recipient sees them and chooses.",
          "ACCEPT or DECLINE: the recipient's answer, encrypted. ACCEPT also proves that the recipient has the key. No file data is sent before it.",
          "CHUNK: the file in frames of equal size, up to 48 KiB each.",
          "END: the file's exact size and the checksum computed when it was chosen.",
          "RECEIPT: the checksum the recipient computed from what arrived. The sender counts the file as delivered only when it matches.",
        ],
      },
      {
        heading: "Checking the file",
        body: [
          "The recipient's browser hashes the file as it arrives, and checks the size, the number of chunks, the padding and the checksum against END. Only when everything matches is the file kept. Any other ending, such as a frame that fails to decrypt or a connection that closes early, throws away what was written.",
          "Chrome and Edge can write the file straight to a place on the disk the recipient chooses. Other browsers collect it in memory and start the download at the end. The download is always marked as plain binary data, whatever type the sender claims, so a file can't run as a web page on Fidant's site.",
          "Names with control characters or the Unicode characters that override or isolate text direction are refused, so a name ending in .exe can't be made to look like one ending in .pdf.",
        ],
      },
      {
        heading: "Hiding the exact size",
        body: [
          "Anyone who can see the encrypted traffic, such as the networks on the way or our relay, sees how big the frames are. So the size is rounded up with the Padmé scheme, which adds at most 12 %, and then to whole chunks. Every chunk frame has the same size, and the padding is zeros that the recipient checks.",
          "The exact size travels only inside the encrypted META and END. META always has the same size, so the length of the file name doesn't show either.",
          "A shared text is at most 32 KiB, and every text is padded to exactly one chunk, as long as the connection allows large enough messages. With every browser we tested in November 2026 (Chromium, Firefox and WebKit), that chunk is 48 KiB. So every text looks the same on the wire, whatever its length, and the same as any file of up to 48 KiB.",
        ],
      },
      {
        heading: "Sharing a text",
        body: [
          "The Share a secret page sends a typed or pasted text the same way as a file: the same keys, frames, checks and one-time links. Nothing is stored, so the sender's page must stay open until each recipient has the text.",
          "The sender's browser turns the text into a file that exists only in memory, with a fixed name and a type that marks it as a text. Like any file's, the name and type travel only inside the encrypted META. A text can have up to 10,000 characters, which is at most 30,000 bytes.",
          "The text box tells the browser to turn off spell checking, autocorrect, automatic capitals, autocomplete, writing suggestions and translation for it.",
          "The recipient's browser treats an offer as a text only if it has exactly that type and is at most 32 KiB. Anything else is offered as a file. For a text, the recipient sees the sender's typed name but not the size, and chooses Show or Decline. After Decline the link still works.",
          "Show keeps the text in the browser's memory, never in a save dialog or a download. Only once the checks against END pass is the text decoded and shown, as plain text with translation off. The page inserts it as text and never reads it as HTML. It isn't in a form field, whose contents a browser can save with the session. The Copy text button puts it on the clipboard.",
          "Our server and relay handle a text like any file. When the Share a secret page is loaded from our server, by typing its address, reloading or following a link, our server can see that someone opened it. The page then opens a signaling connection like every sender page, and moving to it inside the app opens one too. The server never gets the text or its length, and a connection doesn't say which page opened it, but after a full load the server can tie the connection that follows from the same address to the visit and infer that this visitor shares a text and with how many links. Page visits aren't logged.",
        ],
      },
      {
        heading: "How the file travels",
        body: [
          "WebRTC tries the direct routes first: over the local network, or through each side's public address, which the browser learns from our STUN service. The file then goes straight between the browsers. The sender's page shows which route each connection took.",
          "If no direct route works, which is common on mobile data and office networks, the traffic goes through our TURN relay in Stockholm. The relay forwards encrypted packets. It can't decrypt them and doesn't store them.",
          "To use the relay a browser needs credentials, which our server creates for each pairing and gives only to the two paired pages. They expire after 5 minutes. Browsers can reach the relay over UDP or TCP, but it forwards only over UDP. It refuses to forward to other machines on private or internal networks (with one accepted exception: the relay's own box, see decision 0007), and limits how many relayed connections run at once.",
          "On every route, each browser sees the other's IP address, like on a video call.",
        ],
      },
      {
        heading: "Refusing the relay",
        body: [
          "The sender can untick \"Allow our relay if a direct connection isn't possible\". Our server then gives that send no relay credentials, only the STUN address, so an unmodified browser can't use the relay. As a backstop, if the sender's browser still sees a relayed connection, it ends it. File data only flows after the recipient accepts, so in practice that happens before any of it has passed.",
          "The limit: a modified recipient can still send its side through our relay with credentials from another pairing, or through any public relay. That recipient has the key anyway. The choice decides which infrastructure carries the encrypted traffic, not who can read the file.",
        ],
      },
      {
        heading: "Several recipients and one-time links",
        body: [
          "One send can go to up to 256 people. Each has their own link, key, connection and transfer.",
          "A link counts as used only once the recipient's RECEIPT matches. After that it is refused. A link that is already open in one tab is refused in another.",
          "Until then the link can be opened again: after a decline, a dropped connection or a failed check. Every new attempt has a new transfer ID and so a new file key.",
          "Nothing is stored, so a link works only while the sender's page is open. When it closes, our server forgets its links within a minute.",
        ],
      },
      {
        heading: "What our server and relay see and keep",
        body: [
          "Our server sees each page's IP address and browser details, the link IDs, the sender's relay choice, the connection path the sender reports for each attempt (direct, STUN, relay or failed), whether a link was already used, when each side connects and disconnects, and the encrypted setup messages and their sizes. It never sees the file, its name, its type or its exact size, a shared text or its length, the secret or the keys, and it can't read the setup messages. It keeps what it knows in memory only, and forgets a page within a minute after it disconnects.",
          "Its log lines use a fixed list of fields, such as the first 6 characters of a link ID and whether a connection was direct. Never names, keys, file data or IP addresses. They are deleted after 30 days.",
          "Our relay sees both IP addresses and the encrypted traffic, so the file's size only roughly and nothing of a text's length. It keeps no log. Only to fix a fault or stop abuse do we turn one on, with connection times, IP addresses and data volumes, for at most 7 days.",
        ],
        link: ["Every log field, on the privacy page", "/privacy"],
      },
      {
        heading: "The site itself",
        body: [
          "The site is served only over HTTPS, and browsers are told never to use plain HTTP for it. Sending and receiving refuse to run without a secure connection.",
          "A Content Security Policy lets the pages load code, styles, fonts and connections only from our own site, and stops other sites from showing them in a frame. There are no cookies, no third-party scripts and no trackers.",
          "The setup WebSocket refuses connections opened from other sites, and limits protect the server from overload: connections in total and per address, messages per connection, links per sender and the size of each setup message.",
        ],
      },
      {
        heading: "What it doesn't protect against",
        body: [
          "The link is the key. Anyone who gets a link can open its file or text until it has been used. Send each link only to the person it is for, over a channel you trust.",
          "Your browser runs the code our server sends it. A server that sent different code could read files. The code is public, but browsers can't yet check that what they got matches it.",
          "The sender's name is typed by the sender and not verified.",
          "The other browser sees your IP address. The networks on the way, and our relay when it is used, see both IP addresses, when the transfer happens and roughly how big the file is. Our server sees both IP addresses, which recipient connects to which sender and when, and how many recipients a sender has. So it learns who sends to whom, though not what.",
          "Malware on either computer can read the file before it is encrypted or after it is decrypted.",
          "When the recipient copies a text, it goes to the device's clipboard, where clipboard history, clipboard sync to other devices and other apps can read it. Once a text has been shown, Fidant can't reach it: it can't take it back or delete it.",
          "Fidant has not been independently audited yet.",
        ],
      },
      {
        heading: "Planned: verified transfers",
        body: [
          "Not built yet. The plan: the recipient signs a receipt with BankID before they can open the file, and the receipt names the file. The file key is split, and our server releases its half only after the receipt is signed. Events go into an audit log that makes tampering visible, anchored with trusted timestamps.",
          "When it ships, this page will describe it.",
        ],
        link: [
          "The design records on GitHub",
          "https://github.com/sigill-labs/sigill/tree/main/docs/decisions",
        ],
      },
    ] as Sections,
  },
  privacy: {
    title: "Privacy",
    lede: "Your file goes from your browser to the browser of the person you send it to, directly when your networks allow it and otherwise through our relay. It's locked before it leaves your computer, and only the person with the link can unlock it. We never get the file, its name or the key. The same goes for a text you share from the Share a secret page.",
    howHeading: "How sending works",
    // [bold, rest]: the bold part opens each step.
    steps: [
      [
        "You pick a file and add the people to send it to.",
        "The file stays on your computer. Nothing is uploaded.",
      ],
      [
        "You get one link per person.",
        "Each link holds the key that unlocks the file. You send the link yourself, for example by email or chat.",
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
      " sign. Browsers never send that part to any website, ours included. That is why we can't unlock your file even if we wanted to.",
    ] as readonly [string, string],
    direct:
      "Because the two browsers connect directly, each can see the other's network address (IP address), the same as on a video call. If a network blocks that, the file passes through our relay instead, still locked. The relay then sees both IP addresses and roughly how big the file is, and can't unlock it.",
    linkWarning:
      "Anyone who has the link can open the file. Send each link only to the person it is for.",
    serverHeading: "What our server knows",
    neverHeading: "Never",
    never: [
      ["Your file", "Not the contents, not the file name, not its size or type."],
      [
        "Your text",
        "Not the text you share from the Share a secret page, and not its length: every text is padded to the same size before it leaves your browser.",
      ],
      ["The key", "The part of the link that unlocks the file never reaches us."],
      ["Names", "Neither the name you type for yourself nor the names of the people you send to."],
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
        "A few small, locked messages that help the two browsers connect. We pass them on without being able to read them, and don't keep them.",
      ],
      [
        "The sender's relay choice",
        "Whether the sender allows our relay, so we only give recipients access to it when they do. We forget it within a minute after the sender's page closes, and never write it to our logs.",
      ],
    ] as ReadonlyArray<readonly [string, string]>,
    keepHeading: "What we keep",
    keep: "We have no accounts, no database, no cookies and no tracking. Apart from the log lines below, nothing is kept once the sender's page is closed, within a minute at most.",
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
