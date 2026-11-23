// English text. sv.ts must have the same keys; messages.test.ts checks it.
// Plain strings, or functions for text with numbers or names in it.

import type { LogFields } from "@sigill/protocol";
import type { Tie } from "../lib/server-facts.ts";

export const en = {
  product: "Fidant",
  menu: {
    label: "Main",
    send: "Send a file",
    privacy: "Privacy",
    newTab: "(opens in a new tab)",
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
  format: {
    bytes: (n: number) => (n === 1 ? "1 byte" : `${n.toLocaleString("en-US")} bytes`),
    progress: (percent: string, done: string, total: string) => `${percent} · ${done} of ${total}`,
  },
  send: {
    title: "Send a file",
    lede: "Your file goes straight from this browser to the people you choose. It's encrypted on the way and never uploaded or stored.",
    localhost:
      "This page is open on localhost, so the links won't work on other computers. Open the network address the server printed instead.",
    lostServer:
      "Lost the connection to the server. Files already on their way can finish, but nobody new can connect. Reload the page to start again.",
    fromLabel: "Your name",
    optional: "(optional)",
    fromHint: "Shown to the people you send to.",
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
    keepOpen: "Keep this tab open until everyone has the file. It's sent straight from here.",
    recipients: "Recipients",
    status: {
      waiting: (name: string) => `Waiting for ${name} to open the link`,
      connecting: (name: string) => `Connecting to ${name}…`,
      offered: (name: string) => `${name}'s link has been opened`,
      receiving: (name: string) => `Sending to ${name}`,
      delivered: (name: string) => `Delivered through ${name}'s link`,
      failed: (name: string) =>
        `The file didn't arrive intact for ${name}. They can open the link again to retry.`,
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
    /** `from` is the sender's typed name, or "" when they gave none. */
    offerTitle: (from: string) =>
      from ? `${from} wants to send you a file` : "You've been sent a file",
    unverified: "Name typed by the sender, not verified.",
    download: "Download",
    decline: "Decline",
    offerCaption: (from: string) =>
      `Sent straight from ${from ? `${from}'s` : "the sender's"} computer to yours. Encrypted, never stored on a server.`,
    receivingTitle: "Downloading…",
    progressLabel: "Download progress",
    receivingCaption: "Receiving directly from the sender. Keep this tab open until it's done.",
    doneTitle: "Download complete",
    verified: "We checked it: this is exactly the file that was sent.",
    autoDownload: "Your download should start by itself.",
    savedWhereChosen: "It's saved where you chose.",
    saveFile: "Save file",
    doneCaption: "Sent straight from the sender's computer to yours. Encrypted the whole way.",
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
        body: "The file travels directly between your two computers, and they couldn't reach each other.",
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
    }: {
      online: boolean;
      links: number;
      connected: number;
    }) => {
      if (!online) {
        return "Nothing once it notices the connection has closed. That takes up to a minute if the network dropped.";
      }
      if (links === 0) {
        return "No links yet.";
      }
      const ids =
        links === 1
          ? "The ID of your link, never the part that unlocks the file."
          : `The IDs of your ${links} links, never the part that unlocks the file.`;
      if (connected === 0) {
        return ids;
      }
      const who = connected === 1 ? "1 recipient" : `${connected} recipients`;
      return `${ids} ${who} connected right now.`;
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
    senderAfterwards: (online: boolean): string =>
      online
        ? "When you close this tab, the server forgets your links, within a minute at most. Its log lines stay."
        : "Your links are gone from the server within a minute of the connection closing. Its log lines stay.",
    afterwardsRecipient:
      "When this page disconnects, the server drops what it has about this page, within a minute at most. Its log lines stay.",
    logs: `What happened, like a link being opened, with ${new Intl.ListFormat("en", {
      type: "conjunction",
    }).format(
      Object.values({
        link: "the first 6 characters of a link ID",
        links: "how many links a sender has",
        bytes: "message sizes",
        reason: "why a link or connection was refused",
        code: "error codes",
        port: "the port it listens on",
      } satisfies Record<keyof LogFields, string>),
    )}. Never names, keys, file data or IP addresses.`,
  },
  privacy: {
    title: "Privacy",
    lede: "Your file goes straight from your browser to the browser of the person you send it to. It's locked before it leaves your computer, and only the person with the link can unlock it. We never get the file, its name or the key.",
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
        "The file goes directly from your computer to theirs, locked the whole way.",
        "Their browser unlocks it and checks that it is exactly the file you sent.",
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
      "Because the two browsers connect directly, each can see the other's network address (IP address), the same as on a video call.",
    linkWarning:
      "Anyone who has the link can open the file. Send each link only to the person it is for.",
    serverHeading: "What our server knows",
    neverHeading: "Never",
    never: [
      ["Your file", "Not the contents, not the file name, not its size or type."],
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
    ] as ReadonlyArray<readonly [string, string]>,
    logLines: "Log lines",
    keepHeading: "What we keep",
    keep: "We have no accounts, no database, no cookies and no tracking. Apart from the log lines above, nothing is kept once the sender's page is closed, within a minute at most.",
  },
};

export type Messages = typeof en;
