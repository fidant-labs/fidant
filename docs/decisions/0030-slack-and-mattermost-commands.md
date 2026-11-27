# 0030: Starting a secret from Slack or Mattermost

- Status: Proposed
- Date: 2026-11-27
- Linear: FID-334

## Context

- People paste passwords and API keys into Slack and Mattermost, where they stay readable by the service, by workspace admins and in exports. The Linear project Secrets from Slack (P-FID-7) makes Fidant the quicker way to send them. On 2026-11-26 it settled five things:
  - secrets only (files from Slack stay in FID-159)
  - live only: nothing is stored, and the sender's tab stays open until the recipient opens the link
  - the Slack app from the start
  - the safety number on by default for a link started from Slack
  - an "Add to Slack" install from fidant.se, unlisted in the Slack Marketplace, keeping no Slack tokens
- On 2026-11-27 Mattermost joined the project, for organisations that run their own Mattermost. It is decided here and built after Slack works.
- `/secret` (`/sv/hemlighet`) is the page for sharing a secret. Its link carries the key after `#`, which browsers never send in a request (`docs/how-fidant-works.md`, "The link").
- 0024 put the safety number on the button that creates the link. "Create link" comes first and "Create link with safety number" second, and the order flips once the sender chooses email.
- Our CDN's edge function (`apps/infra/edge/site.js`, `FidantPages`) runs on viewer requests, can answer one without contacting the origin, and has no access to the request body. `FidantPages` keeps no access logs, and all of its behaviours allow only GET and HEAD.
- Until the cutover (FID-263), the app box serves fidant.se, and `apps/server` answers pages only for GET and HEAD.

What the two services send and do, from their docs, read on 2026-11-27:

- **Slack's slash command request.** Slack posts each slash command to the app's request URL. The page's example request carries:
  - the team, channel and user IDs and names
  - the enterprise ID and name
  - the text typed after the command
  - `command`, `response_url`, `trigger_id` and `api_app_id`

  The page calls these "some of the important fields", so the list may not be complete. The reply may come in the HTTP response, and it is `ephemeral` by default, seen only by the user who ran the command ([implementing slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands)).
- **Ephemeral messages.** Slack says they "do not persist across reloads" and "are not persisted". It says nothing about what its own servers keep ([chat.postEphemeral](https://docs.slack.dev/reference/methods/chat.postEphemeral)).
- **Buttons.** A Block Kit button with a `url` still sends the app an interaction payload when clicked: "If you're using `url`, you'll still receive an interaction payload" ([button element](https://docs.slack.dev/reference/block-kit/block-elements/button-element)). That payload carries the user, team and channel. For an ephemeral message it leaves the message out ([messaging](https://docs.slack.dev/messaging)). A click on a button in a message the app posted carries that message ([block_actions](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload)).
- **Global shortcuts.** An acknowledgment alone shows the user nothing, and the only other answer is a modal opened with `views.open`, which takes a token ([handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction), [views.open](https://docs.slack.dev/reference/methods/views.open)).
- **Unfurling and message shortcuts.** Slack sends `link_shared` for each posted link on a domain the app registers for unfurling ([link_shared](https://docs.slack.dev/reference/events/link_shared)). The docs don't say whether the part after `#` is kept. A message shortcut's payload carries the message it was used on ([implementing shortcuts](https://docs.slack.dev/interactivity/implementing-shortcuts)).
- **Link previews.** Slack crawls posted links for a preview ([unfurling links](https://docs.slack.dev/messaging/unfurling-links-in-messages/)).
- **Signatures.** Slack signs each request, and the docs say the app "must" check it ([verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack)). Nothing says Slack enforces that.
- **Installs.** The docs don't say whether an OAuth v2 install completes when the app never exchanges the code with `oauth.v2.access` ([installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth)).
- **Mattermost custom slash commands.** Someone on the team sets one up on each server. It posts IDs, names, the typed text and a per-command token to a URL that person typed in ([custom slash commands](https://docs.mattermost.com/developers/integrate/slash-commands/custom)).
- **Mattermost server plugins.** A server plugin is a Go process that runs alongside the Mattermost server. `RegisterCommand` and the `ExecuteCommand` hook answer a command inside that server ([server reference](https://docs.mattermost.com/developers/integrate/reference/server)). Admins install a plugin in one of two ways ([using and managing plugins](https://docs.mattermost.com/developers/integrate/plugins/using-and-managing-plugins)):
  - from the Marketplace, where it must be signed by a key the server trusts
  - by upload, which is off by default and can be turned on only in `config.json`
- **Mattermost link previews.** Mattermost's server fetches a preview of the first link in a post by default, and admins can turn this off ([site configuration](https://docs.mattermost.com/administration-guide/configure/site-configuration-settings.html)).
- **Mattermost ephemeral posts.** Whether Mattermost stores them is not documented.

## Options considered

What Slack's command answers:

| Option                                                        | For                                                                                                                                                  | Against                                                                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. A fixed reply that uses nothing from the request           | A forged request gets only a public link, so no signing secret is needed. There is nothing to log or keep, and the edge function can give the reply. | The reply can't follow the user's language or react to what they typed.                                                                                 |
| 2. A reply built from the request (its text, the user's name) | A reply that can say more.                                                                                                                           | Needs the signature check, so the signing secret in the signaling container's secret store, and code that reads the names and text that Slack sends us. |

Where it answers:

| Option                                                                                                    | For                                                                                                                | Against                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 1. The edge function on fidant.se, with `apps/server` giving the same reply until the cutover and locally | The request stops at the CDN, whose function can't read its body, and nothing logs it. The URL is fidant.se's own. | Two copies of one fixed reply, and a new `FidantPages` behaviour that allows POST.      |
| 2. Passed on from fidant.se to the signaling container, as `/relay-secret/<id>` is                        | One copy of the reply.                                                                                             | The body reaches the load balancer and the container, and the CDN change is no smaller. |
| 3. On `sto.signal.fidant.se` directly                                                                     | No CDN change.                                                                                                     | The same exposure as 2, and the URL names a signaling host that can move.               |

How the reply links to Fidant:

| Option                              | For                                | Against                                                                                           |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1. A plain link in the reply's text | Clicking it sends the app nothing. | Looks plainer than a button.                                                                      |
| 2. A Block Kit button with a `url`  | Looks like an app.                 | Every click reports the user, team and channel to an interactivity URL that we would have to run. |

How Mattermost comes in:

| Option                                                           | For                                                                                             | Against                                                                                                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. A server plugin that answers inside the customer's Mattermost | Nothing about who used it, where or when reaches us. It works on servers that may not call out. | The first Go code in the repository, a release file per version, and each admin installs it, by an upload that is off by default.                                                |
| 2. A custom slash command pointing at fidant.se                  | Nearly free once Slack's endpoint exists.                                                       | Each use sends us user and channel names from the customer's server, which is what organisations that run their own Mattermost avoid. The URL each admin typed can never change. |
| 3. 2 now, 1 when a customer asks                                 | Something to offer sooner.                                                                      | Ships the exposure of 2 first, and two ways to support.                                                                                                                          |

How Slack's install ends:

| Option                                                            | For                                   | Against                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1. The redirect page never exchanges the code                     | No client secret and no token at all. | Not documented, so it may leave the install unfinished.                                  |
| 2. The signaling container exchanges the code and drops the token | Documented to finish the install.     | The client secret in the container's secret store, and a token passing through our code. |

## Decision

Option 1 in each of the first four tables. For the install, option 1 if a live test shows that the install completes without the exchange, otherwise option 2.

### Slack

- **The commands.** `/fidant` and `/secret`. Slack doesn't namespace slash commands, and when two apps register the same name the one installed last wins, so help text always names `/fidant secret`.
- **The reply.** One fixed reply, the same bytes for every request. It goes in the HTTP response body with `response_type` set to `ephemeral`, in Slack's `mrkdwn`:
  - one line in English with a plain link to `https://fidant.se/secret#chat`
  - one line in Swedish with a plain link to `https://fidant.se/sv/hemlighet#chat`
  - a line saying never to type a secret after the command

  The endpoint reads no field of the request. `/fidant secret`, `/fidant` and `/fidant` followed by anything else all get the same reply, and so do Slack's `ssl_check` requests.
- **Where.** `POST https://fidant.se/slack/command`.
  - After the cutover, the edge function answers it on a new `FidantPages` behaviour for `/slack/command`, the only one that allows POST. The function returns the reply itself, so the request never reaches the origin.
  - Until the cutover, and on the local stack, `apps/server` answers the same path with the same bytes.
  - A test fails when the two replies differ.
  - Neither writes a log line for it.
- **No signature check.** The check protects nothing while all four of these hold:
  - the reply is fixed
  - the endpoint reads nothing from the request
  - it calls nobody: no `response_url` and no Slack API
  - it logs nothing about the request

  A change that breaks any of them first adds the check, with the signing secret in the signaling container's secret store, and moves the endpoint there.
- **The manifest.** The Slack app's manifest is committed to the repository. It asks for the `commands` scope only, and declares the two commands and the OAuth redirect URL. A test fails when it gains anything on the list below.
- **What the app never has.** Each of these would send our server more than the command. The first four, and possibly the first, would send a link's key:
  1. unfurl domains, which bring `link_shared`
  2. a message shortcut
  3. a bot user, or any message the app posts
  4. event subscriptions, or any scope beyond `commands`
  5. an `in_channel` reply, which also shows the user's command to everyone in the channel
  6. a query string on the reply's links (anything the page needs goes after `#`)
  7. Block Kit buttons, or an interactivity request URL
  8. a global shortcut, which can show nothing without a token
- **The install.** The page has an "Add to Slack" link for the `commands` scope. Public distribution is on, with no Marketplace listing. FID-337 tests, with a second workspace, whether the install completes when the redirect page never exchanges the code.
  - If it completes, the redirect page only says that the app is installed, and we hold no client secret and no token.
  - If it doesn't, the signaling container exchanges the code using the client secret from its secret store. It drops the returned token without logging or storing it. This waits for FID-263.

### The page opened from a chat

- `#chat` after the page's address marks a page opened from Slack or Mattermost. One marker serves both, because the page does the same for each and the marker stays in the browser.
- With the marker, `/secret`:
  - makes "Create link with safety number" the first button, as it is for email in 0024
  - says in one line that the link works only while this tab stays open
  - offers the existing delivery notification
- The copy button copies the link together with one line the recipient can act on.
- Swedish and English, as every page.

### Mattermost

- **A server plugin.** It lives in this repository and is built after Slack works.
- **What it does.** It registers `/fidant` and `/secret`, and answers inside the Mattermost server with an ephemeral reply that carries the same text and links as Slack's, in Mattermost's Markdown.
- **What it never does.** It makes no network request, has no settings, reads no post, and implements no hook besides activating and answering its command. A hook that sees posts as they are written would see every link's key.
- **How it ships.** A file attached to a GitHub release, which an admin uploads. A Marketplace listing is a later decision.
- **No custom slash command.** We don't offer or document setting up a custom slash command against fidant.se.

## Consequences

- **What Slack sees:**
  - who ran the command, where and when, and the text typed after it
  - the reply, which Slack says doesn't persist across reloads
  - the link the sender pastes, key included, which stays in the conversation after delivery, when it no longer works

  Slack's preview crawler requests `/r/<link ID>`, which never includes the part after `#`. The safety number catches someone who opens the link before the recipient does.
- **What we get from Slack.** Each command reaches our CDN from Slack's servers, not from the user's browser, with the fields under Context: the IDs and names of the user, channel, team and enterprise, and the typed text. P-FID-7 says "IDs" and now says "IDs and names".
  - The edge function answers without the body reaching it, and nothing logs it.
  - Until the cutover, the box's Caddy and `apps/server` hold the request in memory and log nothing.

  The user's click then opens `/secret` like any other visit.
- **What we get from Mattermost.** Nothing from the plugin. The user's click opens `/secret` like any other visit. The customer's Mattermost server keeps what it keeps about commands and posts, and fetches link previews unless its admins turn them off.
- **The text that changes.**
  - `docs/how-fidant-works.md` gains a section on starting from Slack or Mattermost.
  - "Where traces are kept" gains rows for Slack's servers, for our CDN (and the box until the cutover) receiving a command, and for the customer's Mattermost server.
  - `/how/traces`, `/privacy` and the `technical` text in `apps/web/src/i18n/en.ts` and `sv.ts` follow, each in the pull request that ships the part it describes.

  No transfer path, signaling message or log event is added, so `packages/protocol/src/transfer-paths.test.ts` needs no change.
- **Absolutes.** Any copy saying our infrastructure receives nothing about a secret is checked against the command's request, which tells us that someone in a given workspace is about to share one.
- **The issues.**
  - FID-335 builds the endpoint: a link instead of a button, the edge function and the server route, no log event, and the manifest with its test.
  - FID-336 builds the page with the `#chat` marker.
  - FID-337 builds the install and runs its live test.
  - A new issue builds the Mattermost plugin.
- **Approval from the other maintainer.** The `FidantPages` behaviour and `site.js` are under `apps/infra`, so that pull request needs it.
- **The plugin's cost.** The first Go code in the repository, with its own build and tests in CI and a release file per version. Admins who keep plugin uploads off can't install it until a Marketplace listing exists.
- **Not decided here.** A Marketplace listing for either service, and files from Slack (FID-159).
