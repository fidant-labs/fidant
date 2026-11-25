# 0024: A safety number button instead of a checkbox

- Status: Accepted
- Date: 2026-11-25
- Linear: SIG-280

This record amends 0017 (`0017-check-number.md`) and 0008 (`0008-relay-opt-out.md`). Read them with the replacements under Decision.

## Context

- 0017 put the choice on the send page as a checkbox, "Check a number with this recipient before the file goes" ("before the secret goes" on `/secret`), ticked by default for a recipient Fidant emails, and called the number the check number on the recipient's card, the receive page and in the site text.
- In a local trial on 2026-11-25 the checkbox read as out of place, and its wording didn't say what the number is for. In English, "check number" is also the number printed on a bank cheque.
- The checkbox reset after every add, so it was a choice per recipient that looked like a setting.
- 0008's relay label, "Allow our relay if a direct connection isn't possible", is long and doesn't say what the relay sees.

## Options considered

| Option                                                             | For                                                                                                           | Against                                                                                                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Two buttons, "Create link" and "Create link with safety number" | The choice is made when the link is made. Nothing stays ticked or resets, and each button says what it makes. | One more button on the form.                                                                                                                                                      |
| 2. The checkbox, with a short title and a line that explains it    | No change to how the choice is made.                                                                          | Still a box that unticks itself after each add, and more text on every add.                                                                                                       |
| 3. A button called "Send with 2-factor"                            | Familiar words.                                                                                               | Two-factor means proving who you are when you log in, usually with a code sent to you. This compares a number from the connection, and emailed links already have a 6-digit code. |

For the name we weighed "safety number" (Signal's name for the same comparison), "PIN" (people are taught never to say a PIN aloud, and a PIN is typed in, not compared), "security code" (it clashes with the emailed link's 6-digit code) and no name at all (the explainer pages still need one).

## Decision

Option 1, named "safety number".

- **Who turns it on** (replaces 0017's paragraph of that name). The sender chooses per recipient by the button that adds them: "Create link" or "Create link with safety number", or, once they choose email, "Create and email link with safety number" or "Create and email link". The first button, which Enter presses, makes a plain link the sender passes on themselves and a link with a safety number for a recipient Fidant emails: the same defaults as 0017. A line under the buttons says what the safety number costs and what it shows.
- **The name.** English text calls the number the safety number wherever a person reads it. Swedish keeps "kontrollnummer", because "säkerhetsnummer" is close to BankID's "säkerhetskod", a code people must never read aloud. The code and its CHECK frames keep the word check.
- **The relay checkbox** (replaces the label 0008 quotes). It reads "Use our relay if needed" ("Använd vårt relä vid behov"), with a line under it on what the relay sees: both IP addresses and, for a file, roughly its size. What it does is unchanged: unticked, our server mints no relay credentials for that send, so neither browser gets any.
- Nothing else in 0017 or 0008 changes: 0017's commit, number, frames, attempt cap and what the check proves, and 0008's `turn` flag on `host` and its backstop.

## Consequences

- 0017 stays Accepted. Read its "Who turns it on" with the paragraph above, and its "check number" as the safety number.
- The e2e tests choose the check by the button they press, and check that the safety number is the first button once email is chosen.
- Copy that told the sender to keep the check number ticked, or to turn it off, now speaks of creating the link with or without a safety number.
- 0008 stays Accepted. Read its checkbox label as "Use our relay if needed".
- 0019's quotes of the relay label and of the check number read the same way.
