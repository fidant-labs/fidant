// English text. sv.ts must have the same keys; messages.test.ts checks it.
// Plain strings, or functions for text with numbers or names in it.

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
};

export type Messages = typeof en;
