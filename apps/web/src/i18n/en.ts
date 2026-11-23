// English text. sv.ts must have the same keys; messages.test.ts checks it.
// Plain strings, or functions for text with numbers or names in it.

import type { LogFields } from "@sigill/protocol";

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
  server: {
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
