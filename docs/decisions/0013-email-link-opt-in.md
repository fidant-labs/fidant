# 0013: Emailing a link is opt-in, and headlines describe the default

- Status: Accepted
- Date: 2026-11-25
- Linear: SIG-178

## Context

0012 added emailed links. Two of its consequences shaped how the site talks about them:

- **Site copy.** Every claim that nobody in between, us included, can read the file (the landing lede, the /about lede and the footer tagline) got a qualifier such as "unless you ask us to email the link".
- **Send page.** The email address was an optional field next to the recipient's name. Senders who did not want an emailed link left it empty, and a notice appeared once they typed an address.

In practice this made the exception louder than the rule. The footer, the meta description and every link preview read "readable only by the recipient unless you ask us to email the link", so the first thing a visitor learned was the one mode in which our server sees a key. And the field invited an address on every recipient, although passing the link on yourself is the safe way.

## Options considered

1. **Keep 0012 as it is.** Accurate, but it leads with the exception everywhere and makes the less private mode look like the normal one.
2. **Drop the qualifier and keep the field.** Shorter headlines, but a sender could still type an address without meeting the cost first, and the headlines would overstate.
3. **Opt-in, and headlines that are true without the qualifier.** Emailing becomes an explicit choice that shows its cost before the address field appears. Headlines say only what holds in every mode, and the exception is explained where the choice is made and on /how/link.

## Decision

Option 3.

- On `/send` and `/secret`, emailing a link is off on every page load. There is no address field until the sender ticks "Email the link for me (less private)". Ticking it first shows what it costs: our server sees the link's key once, our mail service and anyone who reads the email on its way can see it, the link stays in the recipient's mailbox, and until check words exist our server could sit in the middle of that transfer. It links to /how/link. Once ticked, the address is required; an empty or invalid one is refused with an error.
- Headline claims say only what is true without a qualifier: the footer tagline, meta and link-preview description ("Files encrypted in your browser. Only the link can unlock them."), the landing lede ("only someone with the link can open it"), the /how lede and the /about lede ("without having to trust anyone in between, including us").
- Body text that describes what we see, keep or can do keeps its exact exception for emailed links: /privacy, /how/link, /how/traces, /how/protection, /security and /terms.

This replaces 0012's "Site copy" consequence and its description of the email field as an optional field left empty. The rest of 0012, how emailed links, codes and tokens work, stands.

## Consequences

- A sender who does nothing never has a link emailed, and so never gives our server or a mail service a key.
- A headline must not need "unless you ask us to email the link" to be true. When a new headline would, reword it to a claim that holds in every mode, and put the exception in the body text it links to.
- `docs/how-fidant-works.md` ("Emailed links") describes the opt-in. The end-to-end tests check that the address field is absent until the box is ticked, that ticking it shows the notice, that an empty address is refused and that the choice stays ticked for further recipients.
