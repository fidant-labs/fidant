import assert from "node:assert/strict";
import { type AddressInfo, createServer } from "node:net";
import { test } from "node:test";
import { parseClientMessage } from "@fidant/protocol";
import { compose, isLoopback, type Mail, smtpMailer } from "./mail.ts";

const url =
  "https://fidant.se/r/AAAAAAAAAAAAAAAAAAAAAA#BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const to = "anna@example.se";

test("the notice names the sender as unverified and carries the link in its body only", () => {
  const en = compose({ to, lang: "en", url, from: "Bertil" });
  assert.equal(en.subject, "A link for you on Fidant");
  assert.match(en.text, /^Bertil \(name typed by the sender, not verified\) wants to send you a/);
  assert.ok(en.text.includes(`\n${url}\n`));
  const sv = compose({ to, lang: "sv", url, from: "Bertil" });
  assert.equal(sv.subject, "En länk till dig på Fidant");
  assert.match(sv.text, /^Bertil \(namn som avsändaren skrivit in, inte verifierat\) vill skicka/);
  assert.ok(sv.text.includes(`\n${url}\n`));
  assert.ok(en.text.includes("What they send is not stored anywhere."));
  assert.ok(sv.text.includes("Det som skickas sparas inte någonstans."));
  for (const mail of [en, sv]) {
    assert.ok(!mail.subject.includes("Bertil"));
    assert.ok(!mail.subject.includes(url));
  }
});

test("the notice says someone when the sender typed no name", () => {
  for (const from of ["", "  "]) {
    assert.match(
      compose({ to, lang: "en", url, from }).text,
      /^Someone wants to send you a file or a secret\./,
    );
    assert.match(
      compose({ to, lang: "sv", url, from }).text,
      /^Någon vill skicka en fil eller en hemlighet till dig\./,
    );
  }
});

test("the code mail carries the code and no link", () => {
  for (const lang of ["en", "sv"] as const) {
    const mail = compose({ to, lang, code: "123456" });
    assert.ok(mail.text.includes("123456"));
    assert.ok(!mail.subject.includes("123456"));
    assert.doesNotMatch(mail.text, /https?:|\/r\/|#|www\./);
    assert.ok(!compose({ to, lang, url, from: "" }).text.includes("123456"));
  }
  assert.equal(compose({ to, lang: "en", code: "123456" }).subject, "Your Fidant code");
  assert.equal(compose({ to, lang: "sv", code: "123456" }).subject, "Din kod från Fidant");
});

test("refuses an SMTP URL with a password or another scheme, echoing none of it", () => {
  const from = "Fidant <noreply@mail.fidant.test>";
  for (const bad of ["smtp://user:hunter2@127.0.0.1", "https://hunter2.example", "hunter2"]) {
    assert.throws(
      () => smtpMailer({ url: bad, from }),
      (error: Error) => !error.message.includes("hunter2"),
    );
  }
  assert.throws(() => smtpMailer({ url: "smtp://127.0.0.1", from, password: "hunter2" }));
});

/** A minimal SMTP server on 127.0.0.1 that records the commands and message it receives. */
async function fakeSmtp(t: { after(fn: () => void): void }, rcptReply = "250 OK") {
  const commands: string[] = [];
  const messages: string[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    let inData = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.write("220 fake\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf(inData ? "\r\n.\r\n" : "\r\n");
        if (end < 0) {
          return;
        }
        const part = buffer.slice(0, end);
        buffer = buffer.slice(end + (inData ? 5 : 2));
        if (inData) {
          messages.push(part);
          inData = false;
          socket.write("250 queued\r\n");
          continue;
        }
        commands.push(part);
        const verb = part.slice(0, 4).toUpperCase();
        if (verb === "DATA") {
          inData = true;
        }
        const replies: Record<string, string> = {
          EHLO: "250-fake\r\n250 AUTH PLAIN",
          MAIL: "250 OK",
          RCPT: rcptReply,
          DATA: "354 go on",
          RSET: "250 OK",
          QUIT: "221 bye",
        };
        socket.write(`${replies[verb] ?? "502 no"}\r\n`);
      }
    });
  });
  t.after(() => server.close());
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `smtp://127.0.0.1:${(server.address() as AddressInfo).port}`, commands, messages };
}

function decodeQuotedPrintable(text: string): string {
  const latin1 = text
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(latin1, "latin1").toString("utf8");
}

test("sends one plain-text mail to one address from the configured sender only", async (t) => {
  const smtp = await fakeSmtp(t);
  const send = smtpMailer({ url: smtp.url, from: "Fidant <noreply@mail.fidant.test>" });
  const mail: Mail = { to, lang: "sv", url, from: "Bertil" };
  await send(mail);

  assert.deepEqual(
    smtp.commands.filter((line) => /^(MAIL|RCPT)/i.test(line)),
    ["MAIL FROM:<noreply@mail.fidant.test>", `RCPT TO:<${to}>`],
  );
  assert.equal(smtp.messages.length, 1);
  const message = smtp.messages[0] ?? "";
  const head = message.slice(0, message.indexOf("\r\n\r\n"));
  const body = message.slice(head.length + 4);
  const headers = head.replace(/\r\n[ \t]+/g, " ").split("\r\n");
  assert.ok(headers.includes("From: Fidant <noreply@mail.fidant.test>"), head);
  assert.ok(headers.includes(`To: ${to}`), head);
  assert.ok(headers.includes("Content-Type: text/plain; charset=utf-8"), head);
  assert.ok(!/^(reply-to|cc|bcc|sender):/im.test(head), head);
  assert.ok(!head.includes("Bertil") && !head.includes("AAAAAAAAAAAAAAAAAAAAAA"), head);
  const encoding = headers.find((line) => /^content-transfer-encoding:/i.test(line)) ?? "";
  const text = /quoted-printable/i.test(encoding) ? decodeQuotedPrintable(body) : body;
  assert.equal(text.replace(/\r\n/g, "\n"), compose(mail).text);
});

test("refuses to send a password over a server that offers no STARTTLS", async (t) => {
  const smtp = await fakeSmtp(t);
  const send = smtpMailer({
    url: smtp.url.replace("smtp://", "smtp://fidant@"),
    from: "noreply@mail.fidant.test",
    password: "hunter2",
  });
  await assert.rejects(send({ to, lang: "en", code: "123456" }));
  assert.ok(!smtp.commands.some((line) => /^AUTH/i.test(line)), smtp.commands.join("\n"));
  assert.deepEqual(smtp.messages, []);
});

test("refuses plain SMTP without a password to a host that is not loopback", async (t) => {
  const smtp = await fakeSmtp(t);
  const port = smtp.url.slice(smtp.url.lastIndexOf(":") + 1);
  const send = smtpMailer({
    url: `smtp://[::ffff:127.0.0.1]:${port}`,
    from: "noreply@mail.fidant.test",
  });
  await assert.rejects(send({ to, lang: "en", code: "123456" }));
  assert.ok(!smtp.commands.some((line) => /^MAIL/i.test(line)), smtp.commands.join("\n"));
  assert.deepEqual(smtp.messages, []);
});

test("plain SMTP is allowed to loopback hosts only", () => {
  for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1"]) {
    assert.ok(isLoopback(host), host);
  }
  for (const host of [
    "smtp.example.com",
    "10.0.0.5",
    "127.0.0.1.example.com",
    "[::2]",
    "0.0.0.0",
  ]) {
    assert.ok(!isLoopback(host), host);
  }
  assert.ok(!isLoopback(new URL("smtp://[::2]:1025").hostname));
  assert.ok(isLoopback(new URL("smtp://[::1]:1025").hostname));
});

test("rejects with an error that does not quote the server's answer", async (t) => {
  const smtp = await fakeSmtp(t, `550 <${to}> no such user`);
  const send = smtpMailer({ url: smtp.url, from: "noreply@mail.fidant.test" });
  await assert.rejects(send({ to, lang: "en", code: "123456" }), (error: Error) => {
    assert.equal(error.message, "mail not sent");
    assert.equal(error.cause, undefined);
    return true;
  });
});

// From the security audit of 2026-11-25: hostile addresses and sender names, sent the way a
// client would send them.
test("an address or sender name the parser accepts adds no recipient, header or command", async (t) => {
  const smtp = await fakeSmtp(t);
  const send = smtpMailer({ url: smtp.url, from: "Fidant <noreply@mail.fidant.test>" });
  /** The `email` message as the server would get it, or undefined when the parser refuses it. */
  const parsed = (fields: { to?: string; from?: string }) => {
    const message = parseClientMessage(
      JSON.stringify({
        t: "email",
        link: "A".repeat(22),
        secret: "A".repeat(43),
        to,
        from: "Bertil",
        lang: "en",
        ...fields,
      }),
    );
    return message?.t === "email" ? message : undefined;
  };

  // What would add a line, a recipient or a second address never gets past the parser.
  const injected = [
    "a@b.se\r\nBcc: x@y.se",
    "a@b.se\nRCPT TO:<x@y.se>",
    "a@b.se\u0000",
    "a@b.se,x@y.se",
    "a@b.se;x@y.se",
    "a@b.se x@y.se",
    "Name <x@y.se>",
    "<a@x.se>",
    "a@x.se>",
    '"a b"@x.se',
    "@r.se:a@x.se",
  ];
  for (const bad of injected) {
    assert.equal(parsed({ to: bad }), undefined, JSON.stringify(bad));
  }
  for (const bad of ["a\rb", "a\nb", "a\u0000b", "x\u0085y", "x\u2028y", "\u202egpj"]) {
    assert.equal(parsed({ from: bad }), undefined, JSON.stringify(bad));
  }

  const allowed = new Set([
    "from",
    "to",
    "subject",
    "message-id",
    "date",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
  ]);
  /** Sends one notice and checks the envelope and the header names of what reached the wire. */
  const sendAndCheck = async (message: { to: string; from: string }, label: string) => {
    const [commandsBefore, messagesBefore] = [smtp.commands.length, smtp.messages.length];
    await send({ to: message.to, lang: "en", url, from: message.from });
    const envelope = smtp.commands
      .slice(commandsBefore)
      .filter((line) => /^(MAIL|RCPT)/i.test(line));
    // One sender and one recipient. The mailer may quote an odd local part.
    assert.equal(envelope.length, 2, `${label}: ${envelope.join(" | ")}`);
    assert.equal(envelope[0], "MAIL FROM:<noreply@mail.fidant.test>", label);
    const domain = message.to.slice(message.to.lastIndexOf("@"));
    assert.ok(
      envelope[1]?.startsWith("RCPT TO:<") && envelope[1].endsWith(`${domain}>`),
      `${label}: ${envelope[1]}`,
    );
    assert.equal(smtp.messages.length, messagesBefore + 1, label);
    const text = smtp.messages.at(-1) ?? "";
    const head = text.slice(0, text.indexOf("\r\n\r\n")).replace(/\r\n[ \t]+/g, " ");
    for (const line of head.split("\r\n")) {
      const name = line.slice(0, line.indexOf(":")).toLowerCase();
      assert.ok(allowed.has(name), `${label} added the header ${JSON.stringify(line)}`);
    }
  };

  // Odd forms the parser may accept. Each one that it does must stay one address.
  const oddAddresses = [
    "a'b@x.se",
    "=?utf-8?q?x?=@x.se",
    "-oQ/tmp@x.se",
    "a|b`{c}@x.se",
    "a/b=c%d!e#f@x.se",
    ".a..b.@x.se",
    "a%0d%0aBcc:x@x.se",
    "a(c)@x.se",
    "a@localhost",
    "a@127.0.0.1",
    "a@xn--80ak6aa92e.com",
    `${"l".repeat(245)}@x.se`,
  ];
  let sent = 0;
  for (const odd of oddAddresses) {
    const message = parsed({ to: odd });
    if (message) {
      await sendAndCheck(message, JSON.stringify(odd));
      sent += 1;
    }
  }
  assert.ok(sent >= 5, "the parser refused nearly every odd address, so little was checked");

  const oddNames = [
    ".",
    "..",
    "x Fake line",
    "Content-Type: text/html",
    "Bcc: x@y.se",
    "<a href=x>y</a>",
    "\u200b",
    "é".repeat(100),
  ];
  for (const odd of oddNames) {
    const message = parsed({ from: odd });
    assert.ok(message, `the parser refused the name ${JSON.stringify(odd)}`);
    await sendAndCheck(message, JSON.stringify(odd));
    const body = smtp.messages.at(-1) ?? "";
    assert.ok(!/^content-type: text\/html/im.test(body.slice(0, body.indexOf("\r\n\r\n"))));
  }
});
