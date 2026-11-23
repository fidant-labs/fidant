import { LOGS } from "../lib/server-facts.ts";
import { Facts, Page } from "../ui.tsx";

// Written for people who aren't technical. Keep every sentence true of what the
// code does today: server-facts.ts and apps/server/src/signaling.ts are the source.

const NEVER: ReadonlyArray<readonly [string, string]> = [
  ["Your file", "Not the contents, not the file name, not its size or type."],
  ["The key", "The part of the link that unlocks the file never reaches us."],
  ["Names", "Neither the name you type for yourself nor the names of the people you send to."],
];

const SEES: ReadonlyArray<readonly [string, string]> = [
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
  ["Log lines", LOGS],
];

export function PrivacyPage() {
  return (
    <Page current="privacy">
      <h1>Privacy</h1>
      <p class="lede">
        Your file goes straight from your browser to the browser of the person you send it to. It's
        locked before it leaves your computer, and only the person with the link can unlock it. We
        never get the file, its name or the key.
      </p>

      <section class="prose" aria-labelledby="how-heading">
        <h2 id="how-heading">How sending works</h2>
        <ol class="steps">
          <li>
            <strong>You pick a file and add the people to send it to.</strong> The file stays on
            your computer. Nothing is uploaded.
          </li>
          <li>
            <strong>You get one link per person.</strong> Each link holds the key that unlocks the
            file. You send the link yourself, for example by email or chat.
          </li>
          <li>
            <strong>They open the link while your page is still open.</strong> Our server helps the
            two browsers find each other, like an operator connecting a phone call.
          </li>
          <li>
            <strong>They see the file name and size and choose to download it, or decline.</strong>
          </li>
          <li>
            <strong>
              The file goes directly from your computer to theirs, locked the whole way.
            </strong>{" "}
            Their browser unlocks it and checks that it is exactly the file you sent.
          </li>
        </ol>
        <p>
          Because the file is never stored anywhere, keep your page open until everyone has
          downloaded it.
        </p>
      </section>

      <section class="prose" aria-labelledby="travel-heading">
        <h2 id="travel-heading">How the file travels</h2>
        <p>
          Think of it as handing someone a locked box in person. There is no post office in between
          that holds on to it, and only someone with the key can open it.
        </p>
        <p>
          The key is the last part of the link, after the <strong>#</strong> sign. Browsers never
          send that part to any website, ours included. That is why we can't unlock your file even
          if we wanted to.
        </p>
        <p>
          Because the two browsers connect directly, each can see the other's network address (IP
          address), the same as on a video call.
        </p>
        <p class="notice warning">
          Anyone who has the link can open the file. Send each link only to the person it is for.
        </p>
      </section>

      <section class="prose" aria-labelledby="server-heading">
        <h2 id="server-heading">What our server knows</h2>
        <h3>Never</h3>
        <Facts class="facts" rows={NEVER} />
        <h3>Only what it needs to connect you</h3>
        <Facts class="facts" rows={SEES} />
        <h3>What we keep</h3>
        <p>
          We have no accounts, no database, no cookies and no tracking. Apart from the log lines
          above, nothing is kept once the sender's page is closed, within a minute at most.
        </p>
      </section>
    </Page>
  );
}
