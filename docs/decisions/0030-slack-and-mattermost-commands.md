# 0030: Starting a secret from Slack or Mattermost

- Status: Proposed
- Date: 2026-11-27
- Linear: FID-334

This record amends 0001 (`0001-e2e-tests-and-leak-model.md`). Read it with the replacement under "Text typed after a command".

## Context

- People paste passwords and API keys into Slack and Mattermost, where they stay readable by the service, by workspace admins and in exports. The Linear project Secrets from Slack (P-FID-7) makes Fidant the quicker way to send them. On 2026-11-26 it settled five things:
  - secrets only (files from Slack stay in FID-159)
  - live only: nothing is stored, and the sender's tab stays open until the recipient opens the link
  - the Slack app from the start
  - the safety number on by default for a link started from Slack
  - an "Add to Slack" install from fidant.se, unlisted in the Slack Marketplace, keeping no Slack tokens
- On 2026-11-27 Mattermost joined the project, for organisations that run their own Mattermost. It is decided here and built after Slack works.
- A secret is shared from the send page in secret mode, `/send?mode=secret` (`/sv/skicka?mode=secret`). The recipient's link carries the key after `#`, which browsers never send in a request (`docs/how-fidant-works.md`, "The link"). Every load of the page in secret mode already sends `mode=secret` to our server ("Sharing a secret").
- The old address `/secret` still opens, but the router rewrites it to `/send?mode=secret` and drops the part after `#` (`apps/web/src/App.tsx`). The router reads the part after `#` only on `/how` and on the receive page.
- 0024 put the safety number on the button that creates the link. "Create link" comes first and "Create link with safety number" second, and the order flips once the sender chooses email.
- Our CDN's edge function (`apps/infra/edge/site.js`, `FidantPages`) runs on viewer requests and already answers some itself, without contacting the origin: redirects, and the empty 404 under `/relay-secret/`. A CloudFront Function has no access to the request body ("Access to the request body | No", [choosing between CloudFront Functions and Lambda@Edge](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-choosing.html)). AWS's pages don't say whether one answers a POST itself the same way. `FidantPages` keeps no access logs, and all of its behaviours allow only GET and HEAD.
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
- **Link previews.** Slack crawls posted links for a preview: "By default, we unfurl all links in messages posted by users and Slack apps", unless the message sets both `unfurl_links` and `unfurl_media` to `false` ([unfurling links](https://docs.slack.dev/messaging/unfurling-links-in-messages/)). The docs don't say whether a slash command's ephemeral reply is unfurled, or whether it honours those two fields.
- **Signatures.** Slack signs each request, and the docs say the app "must" check it ([verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack)). Nothing says Slack enforces that.
- **Installs.** The docs don't say whether an OAuth v2 install completes when the app never exchanges the code with `oauth.v2.access` ([installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth)).
- **Mattermost custom slash commands.** Someone on the team sets one up on each server. It posts IDs, names, the typed text and a per-command token to a URL that person typed in ([custom slash commands](https://docs.mattermost.com/developers/integrate/slash-commands/custom)).
- **Mattermost server plugins.** A server plugin is a Go process that runs alongside the Mattermost server. `RegisterCommand` and the `ExecuteCommand` hook answer a command inside that server ([server reference](https://docs.mattermost.com/developers/integrate/reference/server)). Admins install a plugin in one of these ways ([using and managing plugins](https://docs.mattermost.com/developers/integrate/plugins/using-and-managing-plugins)):
  - from the Marketplace
  - by upload in the System Console, or from a URL. Uploads are off by default and "cannot be enabled via the System Console or REST API", only in `config.json`.
  - from the command line
  - by unpacking the bundle in the server's `plugins` directory, which the docs call "no longer recommended"

  A server with `RequirePluginSignature` on installs only Marketplace plugins.
- **Mattermost link previews.** Mattermost's server fetches a preview of the first link in a post by default, and admins can turn this off ([site configuration](https://docs.mattermost.com/administration-guide/configure/site-configuration-settings.html)). The docs don't say whether it does so for an ephemeral post, and name no way for one post to turn it off.
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

| Option                                                           | For                                                                                                      | Against                                                                                                                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. A server plugin that answers inside the customer's Mattermost | The plugin sends us nothing about who used it, where or when. It works on servers that may not call out. | The first Go code in the repository, a release file per version, and each admin installs it, by an upload that is off by default.                                                |
| 2. A custom slash command pointing at fidant.se                  | Nearly free once Slack's endpoint exists.                                                                | Each use sends us user and channel names from the customer's server, which is what organisations that run their own Mattermost avoid. The URL each admin typed can never change. |
| 3. 2 now, 1 when a customer asks                                 | Something to offer sooner.                                                                               | Ships the exposure of 2 first, and two ways to support.                                                                                                                          |

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
  - one line in English with a plain link to `https://fidant.se/send?mode=secret#chat`
  - one line in Swedish with a plain link to `https://fidant.se/sv/skicka?mode=secret#chat`
  - a line saying never to type a secret or a link after the command

  The reply sets `unfurl_links` and `unfurl_media` to `false`. If Slack previews the link anyway, its crawler requests `/send?mode=secret`, which tells us no more than the command already did.

  The endpoint reads no field of the request. `/fidant secret`, `/fidant` and `/fidant` followed by anything else all get the same reply, and so do Slack's `ssl_check` requests.

  The two links are a lasting contract once installed, above all in Mattermost plugin releases that admins upload and keep, so the send page keeps answering them.
- **Where.** `POST https://fidant.se/slack/command`.
  - After the cutover, the edge function answers it on a new `FidantPages` behaviour for `/slack/command`, the only one that allows POST. The function returns the reply itself, so the request never reaches the origin.
  - Until the cutover, and on the local stack, `apps/server` answers the same path with the same bytes. It reads no body: it answers at once and closes the connection, so it needs no size cap, and it has no rate limit, like every page.
  - FID-335 ships both, so the command works on whichever serves fidant.se, before and after the cutover. It checks on the distribution's CloudFront name, before the cutover, that the function answers a POST itself.
  - A test fails when the two replies differ.
  - Neither writes a log line for it.
- **No signature check.** The check protects nothing while all four of these hold:
  - the reply is fixed
  - the endpoint reads nothing from the request
  - it calls nobody: no `response_url` and no Slack API
  - it logs nothing about the request

  A change that breaks any of them first adds the check, with the signing secret in the signaling container's secret store, and moves the endpoint there.
- **The manifest.** The Slack app's manifest is committed to the repository. It asks for the `commands` scope only and declares the two commands. FID-337 adds the OAuth redirect URL. A test fails when the manifest gains anything on the list below.
- **What the app never has.** Each of these would send our server more than the command. Items 2 and 4 would send it a link's key, and item 1 might:
  1. unfurl domains, which bring `link_shared`
  2. a message shortcut
  3. a bot user, or any message the app posts
  4. event subscriptions, or any scope beyond `commands`
  5. an `in_channel` reply, which also shows the user's command to everyone in the channel
  6. anything in the query string of the reply's links besides the page's own `mode=secret` (anything else the page needs goes after `#`)
  7. Block Kit buttons, or an interactivity request URL
  8. a global shortcut, which can show nothing without a token
- **The install.** A new public page, `/slack` (`/sv/slack`), explains the command, says what Slack and we see in the words of `/privacy`, and has an "Add to Slack" link for the `commands` scope. The OAuth redirect URL is `https://fidant.se/slack/installed`. Public distribution is on, with no Marketplace listing. FID-337 tests, with a second workspace, whether the install completes when the redirect page never exchanges the code.
  - If it completes, `/slack/installed` is a static page that says the app is installed, and we hold no client secret and no token. Slack's redirect carries `code` and `state` in the query, which reach the CDN and go unused.
  - If it doesn't, the CDN passes `/slack/installed` on to the signaling container, as it does `/relay-secret/<id>`. The container exchanges the code using the client secret from its secret store, and drops the returned token without logging or storing it. This waits for FID-263.

### The page opened from a chat

- `#chat` after the send page's address marks a page opened from Slack or Mattermost. One marker serves both, because the page does the same for each. It stays in the browser.
- The router reads the part after `#` on the send page too, and the send page looks only for `#chat` there. The send page's own address never holds a key. "The link" in `docs/how-fidant-works.md` says so.
- With the marker, the send page in secret mode:
  - makes "Create link with safety number" the first button, as it is for email in 0024
  - makes each card's copy button copy the link together with one fixed line the recipient can act on, in the page's language. The line names nobody, because whatever is copied stays in the conversation.
- Without the marker, nothing changes. The line about keeping the tab open and the offer of the delivery notification show for every sender already.
- Swedish and English, as every page.

### Text typed after a command

- Slack posts whatever is typed after `/fidant` or `/secret`. Someone may type the secret itself there by mistake, or paste a Fidant link, key included. Either then reaches our CDN, or the box's Caddy and `apps/server` until the cutover, inside Slack's request. No code of ours reads it, logs it or answers with it.
- This is a third exception to the first two invariants in `AGENTS.md`: to the one on content and keys, beside the BankID receipt text and an emailed link, and to the one on where keys live, beside the server-held key half and an emailed link.
- The pull request that ships the endpoint (FID-335) names the exception in both invariants, adds 0030 to the records that `AGENTS.md` says amend 0001, and qualifies every absolute the exception makes untrue, as `AGENTS.md` requires.
- 0001 is amended, not superseded, and stays Accepted. Read it with these replacements from that pull request's merge:

| Where 0001 says                                                                                | Read                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Class C: "the plaintext bytes. Allowed nowhere outside the sender's and recipients' browsers." | The same, except text a person types after the Slack command, which may be a secret by mistake. It may appear only in Slack's request to `/slack/command`, in memory at our CDN, and, until the cutover and on the local stack, in memory in Caddy and `apps/server`. Never in a log, a response or anywhere else. |
| Class K: "Allowed nowhere."                                                                    | The same, except a link a person pastes after the Slack command, key included. It may appear only where the row above allows typed text.                                                                                                                                                                           |

- An end-to-end test on the local stack posts a request shaped like Slack's, with a canary secret and a link's key as the typed text, and checks that neither appears in any server log or response.

### Mattermost

- **A server plugin.** It lives in this repository and is built after Slack works.
- **What it does.** It registers `/fidant` and `/secret`, and answers inside the Mattermost server with an ephemeral reply that carries the same text and links as Slack's, in Mattermost's Markdown.
- **What it never does.** It makes no network request, has no settings, reads no post, and implements no hook besides activating and answering its command. A hook that sees posts as they are written would see every link's key.
- **How it ships.** A file attached to a GitHub release, which an admin installs by upload, from its URL or from the command line. A Marketplace listing is a later decision.
- **Its link's preview.** The plugin issue tests, on a Mattermost server with link previews on, whether the server fetches a preview of the link in the plugin's ephemeral reply. If it does, each use shows our CDN the customer server's address and the time. The issue then looks for a reply that Mattermost won't preview, or this record is amended to say so.
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

  The typed text may hold a secret by mistake (see "Text typed after a command"). The user's click then opens the send page like any other visit.
- **What we get from Mattermost.** The plugin sends us nothing. Until its issue's test settles it, the customer's server may fetch a preview of the reply's link, which would show us that server's address and the time of each use (see "Its link's preview"). The user's click opens the send page like any other visit. The customer's Mattermost server keeps what it keeps about commands and posts, and fetches link previews unless its admins turn them off.
- **The text that changes.**
  - `AGENTS.md` names the third exception in its first two invariants and lists 0030 among the records that amend 0001 (FID-335).
  - `docs/how-fidant-works.md` gains a section on starting from Slack or Mattermost, and its paragraph in "The link" on where the router reads the part after `#` gains the send page.
  - "Where traces are kept" gains rows for Slack's servers, for our CDN (and the box until the cutover) receiving a command, and for the customer's Mattermost server.
  - `/how/traces`, `/privacy` and the `technical` text in `apps/web/src/i18n/en.ts` and `sv.ts` follow, each in the pull request that ships the part it describes.

  No transfer path, signaling message or log event is added, so `packages/protocol/src/transfer-paths.test.ts` needs no change.
- **Absolutes.** Copy that says our infrastructure never receives a secret, or receives nothing about one, is qualified for the typed text. The command's request also tells us that someone in a given workspace is about to share a secret.
- **The issues.**
  - FID-335 builds the endpoint: a link instead of a button, the edge function and the server route, no log event, the manifest with its test, the canary test and the `AGENTS.md` exception.
  - FID-336 builds the `#chat` marker on the send page.
  - FID-337 builds `/slack`, `/slack/installed` and the install, and runs the live test.
  - A new issue builds the Mattermost plugin.
- **Approval from the other maintainer.** The `FidantPages` behaviour, `site.js` (with `/slack` and `/sv/slack` added to `PAGES`) and `AGENTS.md` are sensitive paths, so the pull requests that change them need it.
- **The plugin's cost.** The first Go code in the repository, with its own build and tests in CI and a release file per version. A server that requires signed plugins can't install it until a Marketplace listing exists. One with uploads off needs them turned on in `config.json`, or the bundle unpacked by hand.
- **Not decided here.** A Marketplace listing for either service, and files from Slack (FID-159).
