# 0032: Starting a transfer from Slack or Mattermost

- Status: Proposed
- Date: 2026-11-27
- Linear: FID-334

This record amends 0001 (`0001-e2e-tests-and-leak-model.md`) and 0024 (`0024-safety-number-buttons.md`). Read 0001 with the replacements under "Text typed after a command", from FID-335's merge, and under "A link posted into a chat", from the merges that section names; and 0024, from FID-336's merge, with the replacement under "The page opened from a chat".

## Context

- People paste passwords and API keys into Slack and Mattermost, where they stay readable by the service, by workspace admins and in exports. The Linear project Secrets from Slack (P-FID-7) makes Fidant the quicker way to send them. On 2026-11-26 it settled five things:
  - secrets only (files from Slack stay in FID-159)
  - live only: nothing is stored, and the sender's tab stays open until the recipient opens the link
  - the Slack app from the start
  - the safety number on by default for a link started from Slack
  - an "Add to Slack" install from fidant.se, unlisted in the Slack Marketplace, keeping no Slack tokens
- On 2026-11-27 Mattermost joined the project, for organisations that run their own Mattermost. It is decided here and built after Slack works.
- A secret is shared from the send page in secret mode, `/send/secret` (`/sv/skicka/hemlighet`). The recipient's link carries the key after `#`, which browsers never send in a request (`docs/how-fidant-works.md`, "The link"). Every load of the page in secret mode already tells our server that it is in secret mode ("Sharing a secret"). A file goes from file mode, `/send/file` (`/sv/skicka/fil`), with its link made the same way.
- On 2026-11-27 David decided that addresses carry no query parameters. FID-367 (merged that day) gave the two modes the paths `/send/file` and `/send/secret`, kept `/send` as file mode, and redirects the old `/secret` and `/sv/hemlighet` with a 301. The router reads the part after `#` only on `/how` and on the receive page (`apps/web/src/App.tsx`).
- 0024 put the safety number on the button that creates the link. "Create link" comes first and "Create link with safety number" second, and the order flips once the sender chooses email.
- Our CDN's edge function (`apps/infra/edge/site.js`, `FidantPages`) runs on viewer requests and already answers some itself, without contacting the origin: redirects, and the empty 404 under `/relay-secret/`. A CloudFront Function has no access to the request body ("Access to the request body | No", [choosing between CloudFront Functions and Lambda@Edge](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-choosing.html)), so it can't check a signature over the body or read a field. `FidantPages` keeps no access logs, and all of its behaviours allow only GET and HEAD.
- Until the cutover (FID-263), the app box serves fidant.se, and `apps/server` answers pages only for GET and HEAD.

What the two services send and do, from their docs, read on 2026-11-27:

- **Slack's slash command request.** Slack posts each slash command to the app's request URL. The page's example request carries:
  - the team, channel and user IDs and names
  - the enterprise ID and name
  - the text typed after the command
  - `command`, `response_url`, `trigger_id` and `api_app_id`

  The page calls these "some of the important fields", so the list may not be complete. None of them is the user's language, and the docs name no way to ask for it in the request. The reply may come in the HTTP response, and it is `ephemeral` by default, seen only by the user who ran the command ([implementing slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands)). Slack returns a user's locale only to a Web API call with a token, such as `users.info` with `include_locale` and the `users:read` scope ([users.info](https://docs.slack.dev/reference/methods/users.info)).
- **Replying later.** A command's `response_url` takes messages "up to 5 times within 30 minutes", ephemeral by default or `in_channel` for the whole conversation, and needs no token ([handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction)). The command itself must be acknowledged "within 3000 milliseconds", and an `in_channel` reply to it shares "both the response message and the initial slash command entered by the user" ([implementing slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands)). The docs don't say whether a later `in_channel` message shows the command, whose name it carries, or whether it takes the unfurl fields. On 2026-11-27 `hooks.slack.com` answered a POST sent with another origin with `access-control-allow-origin: *`, and a preflight with a 404.
- **Ephemeral messages.** Slack says they "do not persist across reloads" and "are not persisted". It says nothing about what its own servers keep ([chat.postEphemeral](https://docs.slack.dev/reference/methods/chat.postEphemeral)).
- **Buttons.** A Block Kit button with a `url` still sends the app an interaction payload when clicked: "If you're using `url`, you'll still receive an interaction payload" ([button element](https://docs.slack.dev/reference/block-kit/block-elements/button-element)). That payload carries the user, team and channel. For an ephemeral message it leaves the message out ([messaging](https://docs.slack.dev/messaging)). A click on a button in a message the app posted carries that message ([block_actions](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload)).
- **Global shortcuts.** An acknowledgment alone shows the user nothing, and the only other answer is a modal opened with `views.open`, which takes a token ([handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction), [views.open](https://docs.slack.dev/reference/methods/views.open)).
- **Unfurling and message shortcuts.** Slack sends `link_shared` for each posted link on a domain the app registers for unfurling ([link_shared](https://docs.slack.dev/reference/events/link_shared)). The docs don't say whether the part after `#` is kept. A message shortcut's payload carries the message it was used on ([implementing shortcuts](https://docs.slack.dev/interactivity/implementing-shortcuts)).
- **Link previews.** Slack crawls posted links for a preview: "By default, we unfurl all links in messages posted by users and Slack apps", unless the message sets both `unfurl_links` and `unfurl_media` to `false` ([unfurling links](https://docs.slack.dev/messaging/unfurling-links-in-messages/)). The docs don't say whether a slash command's ephemeral reply is unfurled, or whether it honours those two fields.
- **Signatures.** Slack signs each request with HMAC-SHA256 over `v0:`, the request's timestamp, `:` and the raw body, keyed with the app's signing secret, and recommends refusing a timestamp more than five minutes from local time. The docs say the app "must" check it ([verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack)). Nothing says Slack enforces that.
- **Installs.** The docs don't say whether an OAuth v2 install completes when the app never exchanges the code with `oauth.v2.access` ([installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth)).
- **Mattermost custom slash commands.** Someone on the team sets one up on each server. It posts IDs, names, the typed text and a per-command token to a URL that person typed in ([custom slash commands](https://docs.mattermost.com/developers/integrate/slash-commands/custom)).
- **Mattermost server plugins.** A server plugin is a Go process that runs alongside the Mattermost server. `RegisterCommand` and the `ExecuteCommand` hook answer a command inside that server, `ServeHTTP` serves the plugin's own pages under the server's address, `CreatePost` posts as a user, and `GetUser` returns the record of the user who ran it ([server reference](https://docs.mattermost.com/developers/integrate/reference/server)), whose `Locale` is their language ([model.User](https://pkg.go.dev/github.com/mattermost/mattermost/server/public/model#User)). Admins install a plugin in one of these ways ([using and managing plugins](https://docs.mattermost.com/developers/integrate/plugins/using-and-managing-plugins)):
  - from the Marketplace
  - by upload in the System Console, or from a URL. Uploads are off by default and "cannot be enabled via the System Console or REST API", only in `config.json`.
  - from the command line
  - by unpacking the bundle in the server's `plugins` directory, which the docs call "no longer recommended"

  A server with `RequirePluginSignature` on installs plugins only through a Marketplace, and turns uploads off. It checks each plugin against Mattermost's key and any keys its admin adds in `config.json` (`SignaturePublicKeyFiles`), which the docs describe for pointing a server at a different Marketplace.
- **Mattermost link previews.** Mattermost's server fetches a preview of the first link in a post by default, and admins can turn this off ([site configuration](https://docs.mattermost.com/administration-guide/configure/site-configuration-settings.html)). The docs don't say whether it does so for an ephemeral post, and name no way for one post to turn it off.
- **Mattermost ephemeral posts.** Whether Mattermost stores them is not documented.

## Options considered

What Slack's command answers:

| Option                                                     | For                                                                                                                                                  | Against                                                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. A fixed reply that uses nothing from the request        | A forged request gets only a public link, so no signing secret is needed. There is nothing to log or keep, and the edge function can give the reply. | The reply can't react to what the user typed. Neither option can follow the user's language, which the request doesn't carry.                           |
| 2. A reply built from the request (where to post the link) | The sender's browser can post the link into the conversation.                                                                                        | Needs the signature check, so the signing secret in the signaling container's secret store, and code that reads the names and text that Slack sends us. |

Where it answers:

| Option                                                                                                    | For                                                                                                                | Against                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The edge function on fidant.se, with `apps/server` giving the same reply until the cutover and locally | The request stops at the CDN, whose function can't read its body, and nothing logs it. The URL is fidant.se's own. | The function can't read the body, so it can't check the signature or read `response_url`. Two copies of one reply, and a new `FidantPages` behaviour that allows POST. |
| 2. Passed on from fidant.se to the signaling container, as `/relay-secret/<id>` is                        | One copy of the reply.                                                                                             | The body reaches the load balancer and the container, and the CDN would need an origin request policy to pass Slack's signature headers on.                            |
| 3. On `sto.signal.fidant.se` directly                                                                     | No CDN change, and Slack's headers arrive as sent.                                                                 | The same exposure as 2. The URL names the signaling host, but it lives in our app's settings and moves with it.                                                        |

How the reply links to Fidant:

| Option                              | For                                | Against                                                                                           |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1. A plain link in the reply's text | Clicking it sends the app nothing. | Looks plainer than a button.                                                                      |
| 2. A Block Kit button with a `url`  | Looks like an app.                 | Every click reports the user, team and channel to an interactivity URL that we would have to run. |

Who puts a recipient's link into the conversation:

| Option                                                  | For                                                                 | Against                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The sender copies it and pastes it                   | Nothing new reaches anyone.                                         | A trip from Slack to the page and back for every link, which David found a poor experience (2026-11-27).                                             |
| 2. The sender's browser posts it through `response_url` | One click, and the link and its key never pass through our servers. | The endpoint must read the request, so it needs the signature check and its secret, and waits for the cutover. The page's `connect-src` gains Slack. |
| 3. Our server posts it through `response_url`           | The page's `connect-src` stays as it is.                            | Our server would see every link's key.                                                                                                               |
| 4. The app posts it with a bot token                    | Posts under the app's name anywhere it is invited.                  | A token kept per workspace, and our server would see every link's key.                                                                               |

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

Option 2 in the first table, option 3 in the second, option 1 in the third, option 2 in the fourth and option 1 in the fifth. For the install, option 1 if a live test shows that the install completes without the exchange, otherwise option 2.

### Slack

- **The commands.** `/fidant` and `/send-secret` open the secret page, and `/send-file` the file page, decided by David on 2026-11-27 in place of `/secret`. That widens the project's "secrets only" to Fidant's file page. Files from Slack itself stay in FID-159: the sender picks the file on Fidant's page. Slash commands "are not namespaced", and "Slack will always invoke the one that was installed most recently" ([implementing slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands)), so a short name such as `/secret` or `/file` could be taken from another app by our install, or from us by a later one, which then gets whatever is typed after it. `/send` is already Slack's own ([Slack's shortcuts](https://slack.com/help/articles/201259356-Use-built-in-slash-commands)). The longer names are less likely to be taken, though a later app can still take any of the three. No command has a usage hint, so Slack shows each with nothing after it, and `/slack` lists all three.
- **The flow.** The sender types the command and gets a reply that only they see, with a link to the send page. They write the secret or pick the file there and create a link per recipient, and each recipient's card offers "Post in #channel", naming the workspace too. That button posts the recipient's link into the conversation the command came from, sent by the sender's own browser through the command's `response_url`, so the link and its key never pass through our servers. The sender's tab stays open until the recipient has it, as for any send. Copying the link stays possible on every card. Decided by David on 2026-11-27, because pasting by hand made for a poor experience, and he accepted that the command then waits for the cutover (FID-263).
- **Where.** `POST https://sto.signal.fidant.se/slack/command`, straight to the signaling container behind its load balancer. Through the CDN, Slack's signature headers would need an origin request policy, which no `FidantPages` behaviour has: without one, CloudFront sends the origin only the path and its own headers (`apps/infra/AGENTS.md` cites the pages). And a slash command's request URL is part of our app's settings, so it can move with the signaling host. The container answers anything but POST there with a 405. On the local stack `apps/server` answers the same path. The box never answers it: the command ships after the cutover.
- **The signature check.** The container checks Slack's signature before it reads any field: HMAC-SHA256 with the app's signing secret over `v0:` + `X-Slack-Request-Timestamp` + `:` + the raw body, compared in constant time with `X-Slack-Signature`, and a timestamp no more than five minutes from the container's clock. A request that fails gets a 401 and nothing else. Before hashing, the container refuses a body over 16 KB with a 413, so an unsigned request can't use up the memory of the task that carries every transfer's signaling. The signing secret is in the container's secret store, placed there by a maintainer from the Slack app's settings; FID-335 has the runbook.
- **What it reads.** After the check, the container uses four fields: `command`, to pick the page, and `response_url`, `channel_name` and `team_domain`. It uses no other field, the typed text included, and logs nothing about the request. A signed request with any other `command` gets a 400 and nothing else.
- **The reply.** An ephemeral reply in the HTTP response, within Slack's 3 seconds, in `mrkdwn`, with `unfurl_links` and `unfurl_media` set to `false`:

  ```
  Share a secret with Fidant:
  https://fidant.se/send/secret#chat.<target>

  Never type a secret, a file name or a link after the command: Slack sends it to us.
  ```

  `/send-file` gets the same reply with "Send a file with Fidant:" and `https://fidant.se/send/file#chat.<target>`.

  `<target>` is the post target: `response_url`, `channel_name`, `team_domain` and the time, signed by the container with a key of its own whose public half ships in the page, and encoded for the part after `#`. The link's text is its true address without the target, such as `https://fidant.se/send/secret`, because the target runs to several hundred characters. The reply is in English, because a reply in the user's language would need their locale, which the request doesn't carry (decided 2026-11-27). The page opens in Swedish for a Swedish reader: its pre-paint script opens the Swedish twin, such as `/sv/skicka/hemlighet#chat.<target>`, when the stored language choice is Swedish, or nothing is stored and the browser's language is, and it keeps the part after `#` (`apps/web/src/prepaint.js`).
- **The post.** "Post in #channel" sends `response_url` a JSON body with `response_type` set to `in_channel`, `replace_original` to `false`, both unfurl fields to `false`, and the recipient's link with the line from "The page opened from a chat". It goes as `text/plain`, because a JSON content type would need a preflight. The button names the channel and the workspace (`team_domain`), because a target signed for a channel of the same name in another workspace is just as valid. Slack takes at most five posts within 30 minutes of the command; after that, or with a target that fails its signature or is older than 30 minutes, the card offers copying only. When a post fails, the card says so, and copying stays the way on. The send page's `connect-src` gains `https://hooks.slack.com`, on the send page's addresses only, and the page posts only to a `response_url` on that origin.
- **The live tests.** Slack's docs leave four things open, and FID-335 tests them in our workspace before anything ships:
  - that Slack accepts the browser's `text/plain` post
  - whether the posted message also shows the command, with or without its typed text, to the channel. Slack does so for an `in_channel` reply to the command itself, which item 5 below rules out. If the later post shows the command at all, FID-335 stops until this record is amended.
  - whose name the post carries: the app's, the sender's, or both
  - whether the unfurl fields stop a preview of the link
  - a direct message and a private channel: what `channel_name` holds there, and whether the post works
  - whether Slack signs its `ssl_check` requests, which decides whether they get a 200 or a 401
  - that a real command's body fits under the 16 KB cap
- **The manifest.** The Slack app's manifest is committed to the repository. It asks for the `commands` scope only and declares the three commands. FID-337 adds the OAuth redirect URL. A test fails when the manifest gains anything on the list below.
- **What the app never has.** Each of these would send our server more than the command, show the command to others, or need a token. Items 2 and 9 would put a link's key in our servers' hands, item 4 would through message events, and item 1 might:
  1. unfurl domains, which bring `link_shared`
  2. a message shortcut
  3. a bot user or a bot token, apart from the one the fallback install below drops at once
  4. event subscriptions, or any scope beyond `commands`
  5. an `in_channel` reply to the command itself, which also shows the user's command to everyone in the channel
  6. a query string on the reply's link (anything the page needs goes after `#`)
  7. Block Kit buttons, or an interactivity request URL
  8. a global shortcut, which can show nothing without a token
  9. a post or call to Slack from our servers, apart from the fallback install's code exchange: only the sender's browser uses `response_url`
- **The install.** A new public page, `/slack` (`/sv/slack`), explains the commands, says what Slack and we see in the words of `/privacy`, and has an "Add to Slack" link for the `commands` scope. The OAuth redirect URL is `https://fidant.se/slack/installed`. Public distribution is on, with no Marketplace listing. FID-337 tests, with a second workspace, whether the install completes when the redirect page never exchanges the code.
  - If it completes, `/slack/installed` is a static page that says the app is installed, and we hold no client secret and no token. Slack's redirect carries `code` and `state` in the query, which reach the CDN and go unused. A browser that the pre-paint script sends on to the Swedish page sends them a second time, to that address.
  - If it doesn't, the OAuth redirect URL is `https://sto.signal.fidant.se/slack/installed`. The container exchanges the code using the client secret from its secret store, drops the returned token without logging or storing it, and redirects to `/slack/installed` on fidant.se.

### The page opened from a chat

- `#chat` after `/send/secret` or `/send/file` (`/sv/skicka/hemlighet`, `/sv/skicka/fil`) marks a page opened from Slack or Mattermost, and `#chat.<target>` adds where to post. It stays in the browser.
- The router reads the part after `#` on the send page too, and the send page looks only for `#chat` and a target there. The send page's own address never holds a key. "The link" in `docs/how-fidant-works.md` says so.
- With the marker, the send page, in either mode:
  - makes "Create link with safety number" the first button, as it is for email in 0024
  - gives each card a post button when the target is valid (see "The post" for Slack and "What it does" for Mattermost), naming where it posts. A Slack target is signed. A Mattermost target names the customer's server and a token, and nothing signs it: the page accepts only an `https:` origin and shows that full host on the button, which is what the sender checks before a crafted target can send the link elsewhere. With the safety number on, the default, the secret or the file still goes only to the recipient the sender confirms.
  - makes the post, each card's copy button, and its share button where the browser has one, pass on the link together with one fixed line, in the page's language, that tells the recipient to open it now: it works once, and only while the sender's Fidant tab is open. For example: "Open this while I'm online: it works once, and only while my Fidant tab is open." The line names nobody, because whatever is posted or copied stays in the conversation.
- Switching mode keeps `#chat` and the target, so both modes share the five posts Slack allows one command.
- 0024 is amended, not superseded, and stays Accepted. Read it with this replacement from FID-336's merge:

| Where 0024 says                                                                                                                                                                                          | Read                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| "Who turns it on": "The first button, which Enter presses, makes a plain link the sender passes on themselves and a link with a safety number for a recipient Fidant emails: the same defaults as 0017." | The same, except on the send page opened with `#chat`, where the first button makes a link with a safety number either way. |

- The target's format is a lasting contract once installed, above all in Mattermost plugin releases that admins upload and keep, so the send page keeps reading every format it has accepted.
- Without the marker, nothing changes. The line about keeping the tab open and the offer of the delivery notification show for every sender already.
- Swedish and English, as every page.

### Text typed after a command

- Slack posts whatever is typed after one of the app's commands. Someone may type the secret itself there by mistake, a file's name after `/send-file`, or paste a Fidant link, key included. Either then reaches the signaling container's load balancer and the container, inside Slack's request. No code of ours uses it, logs it or answers with it.
- This is a third exception to the first two invariants in `AGENTS.md`: to the one on file content, names and keys, beside the BankID receipt text and an emailed link, and to the one on where keys live, beside the server-held key half and an emailed link.
- The pull request that ships the endpoint (FID-335) names the exception in both invariants, adds 0032 to the records that `AGENTS.md` says amend 0001, and qualifies every absolute the exception makes untrue, as `AGENTS.md` requires.
- 0001 is amended, not superseded, and stays Accepted. Read it with these replacements from that pull request's merge:

| Where 0001 says                                                                                                                              | Read                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class C: "the plaintext bytes. Allowed nowhere outside the sender's and recipients' browsers."                                               | The same, except text a person types after one of the app's commands in Slack, which may be a secret by mistake. It may appear only in Slack's request to `/slack/command`, in memory in the signaling container's load balancer and the container, and in memory in `apps/server` on the local stack. Never in a log, a response or anywhere else. What Slack itself keeps is outside these lists (see Consequences). |
| Class K: "the fragment secret, the full key, every derived key (signaling key, file and chunk keys), and the receipt salt. Allowed nowhere." | As 0012 and 0030 read it, and also except the fragment secret of a link a person pastes after one of the app's commands in Slack. It may appear only where the row above allows typed text. Derived keys, the receipt salt and the ICE pwd stay allowed nowhere.                                                                                                                                                       |
| Class M: "Allowed nowhere, except the receipt exception for the file name."                                                                  | The same, and also except a file name a person types after one of the app's commands in Slack. It may appear only where the class C row allows typed text.                                                                                                                                                                                                                                                             |

- An end-to-end test on the local stack posts a request shaped like Slack's, with a canary secret, a canary file name and a link's key as the typed text, and checks that none of them appears in any server log or response.

### A link posted into a chat

- "Post in #channel" and "Post in Mattermost" send the recipient's link, key included, from the sender's browser: to a `response_url` on `https://hooks.slack.com`, or to the plugin's page on the customer's Mattermost server, which posts it. It is the link the sender would otherwise paste into the same conversation, but Fidant's code sends it, so it is a fourth exception to the first two invariants in `AGENTS.md`, after the typed text above. David named it on 2026-11-27.
- David's condition, set the same day: the secret must never reach Slack's infrastructure before it is encrypted. The post never carries it, encrypted or not: it carries only the link and its line, and the secret leaves the browser only encrypted, peer to peer or through our relay. A secret typed after the command by mistake is the exception above, which reaches Slack as typed. Slack, or the customer's server, holds a link that can open the secret while the sender's tab is open. The safety number, on by default for a page opened from a chat, makes the sender confirm the recipient before the secret goes, and the sender can turn it off (decided 2026-11-27: on by default is enough). A file sent from file mode is the same: the post carries no byte of it and not its name, and the file leaves the browser only encrypted.
- FID-336 names the exception for Slack, and FID-384 for Mattermost, in both invariants, and each qualifies every absolute it makes untrue, among them "The link" in `docs/how-fidant-works.md`: "The app sends the secret nowhere except in the one message that asks our server to email that link".
- Read 0001 with these replacements, from FID-336's merge for Slack and from FID-384's for Mattermost:

| Where 0001 says                                                      | Read                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class K, as the row under "Text typed after a command" reads it      | The same, and also except the fragment secret of a link the sender posts: in the sender's browser's request to a `response_url` on `https://hooks.slack.com`, in the plugin's page on the customer's server and its request to that server, and in the post that Slack or that server then keeps. |
| Requests outside the local stack: "Any such request fails the test." | The same, except a test of a post, which routes the page's request to a stub and checks that it holds exactly the posted link and its line.                                                                                                                                                       |

### Mattermost

- **A server plugin.** It lives in this repository and is built after Slack works.
- **What it does.** It registers the same three commands, and answers inside the Mattermost server with an ephemeral reply in Mattermost's Markdown, with a link to the secret page or, for `/send-file`, the file page, whose target names the customer's server and a token. "Post in Mattermost" on a card opens the plugin's own page on that server in a new tab, with `noopener`, so the send page stays open, with the token and the recipient's link after `#`. That page runs signed in as the user, and has the plugin post the link and its line into the conversation the command came from, under the user's name. Nothing passes through our servers, and the send page's `connect-src` doesn't change. The token serves one conversation and one user, for up to five posts, one per card, within 30 minutes. The page posts only a link on `https://fidant.se/r/` with one of the fixed lines, and FID-384 tests what it does for a user who isn't signed in in that browser. The reply is in the user's Mattermost language, Swedish or otherwise English, which the plugin reads with `GetUser` inside that server. Its link is the same in both, and the page picks its own language as above. Its warning not to type a secret after the command doesn't say that the text reaches us, because it doesn't.
- **What it never does.** It makes no network request beyond its own server, has no settings, takes only the trigger, the first word of the command text the server hands it, uses nothing typed after it, reads no post, uses nothing from the user's record but `Locale`, writes no log line about a command or a link, posts nothing but a Fidant link and fixed line its page hands it, within the token's limits, and implements no hook besides activating, answering its commands and serving its page. A hook that sees posts as they are written would see every link's key.
- **How it ships.** A file attached to a GitHub release, which an admin installs by upload, from its URL or from the command line. A Marketplace listing is a later decision.
- **Its link's preview.** The plugin issue tests, on a Mattermost server with link previews on, whether the server fetches a preview of the link in the plugin's ephemeral reply. If it does, each use shows our CDN the customer server's address and the time. The issue then looks for a reply that Mattermost won't preview, or this record is amended to say so.
- **No custom slash command.** We don't offer or document setting up a custom slash command against fidant.se.

## Consequences

- **What Slack sees:**
  - who ran the command, where and when, and the text typed after it
  - the reply, which Slack says doesn't persist across reloads
  - the post with the recipient's link, key included, which stays in the conversation after delivery, when it no longer works

  Slack's preview crawler requests `/r/<link ID>`, which never includes the part after `#`. The safety number catches someone who opens the link before the recipient does.
- **What we get from Slack.** Each command reaches the signaling container's load balancer and the container from Slack's servers, not from the user's browser, with the fields under Context: the IDs and names of the user, channel, team and enterprise, the typed text, `command`, `response_url` (a URL that posts a reply to the user), `trigger_id`, `api_app_id`, and any others Slack sends. P-FID-7 said "IDs" and now says "IDs and names".
  - The container checks the signature and reads the four fields. `response_url`, `channel_name` and `team_domain` go back to Slack only inside the reply's link, after `#` and signed. Nothing logs them.
  - `response_url` lets whoever holds it post into that conversation, five times within 30 minutes. It is in the load balancer's and the container's memory, in the reply Slack shows the sender, and in the sender's browser, whose address bar and history keep the target.

  The typed text may hold a secret or a file name by mistake (see "Text typed after a command"). The user's click then opens the send page like any other visit.
- **What we get from Mattermost.** The plugin sends us nothing. Until its issue's test settles it, the customer's server may fetch a preview of the reply's link, which would show us that server's address and the time of each use (see "Its link's preview"). The user's click opens the send page like any other visit. The customer's Mattermost server keeps what it keeps about commands and posts, and fetches link previews unless its admins turn them off.
- **The text that changes.**
  - `AGENTS.md` names the third exception in its first two invariants and lists 0032 among the records that amend 0001 (FID-335).
  - `docs/how-fidant-works.md` gains a section on starting from Slack or Mattermost, and its paragraph in "The link" on where the router reads the part after `#` gains the send page.
  - "Where traces are kept" gains rows for Slack's servers, for the signaling container's load balancer and the container receiving a command, which tells them whether a secret or a file is about to be sent, and for the customer's Mattermost server.
  - `/how/traces`, `/privacy` and the `technical` text in `apps/web/src/i18n/en.ts` and `sv.ts` follow, each in the pull request that ships the part it describes.
  - So do the absolutes the exception makes untrue, in FID-335: the first lines of `AGENTS.md` and `docs/how-fidant-works.md`, the landing page's "Our server never gets", `/how`'s "so we never see the key" and "We never see your file, its name or the key", `/privacy`'s "not the file name" and `/terms`' "We never have the key", in English and Swedish. The post's exception qualifies the same lines again, in FID-336 and FID-384.
  - 0023 says that with `SIGNALING_ONLY` the server answers `/signal`, `/relay-status` and `/relay-secret/<id>`, and 404 for every other path. FID-335 adds `/slack/command` there, and `/slack/installed` if the fallback install is needed, and 0023's row for the load balancer under its traces gains Slack's commands.
  - The send page's `connect-src` gains `https://hooks.slack.com` on its addresses only, which `docs/how-fidant-works.md` and `/security` describe, in FID-336.

  The post is a new way for a link to reach its recipient, so "Modes" and "Every path and its traces" in `docs/how-fidant-works.md` gain it, with a row for the sender's browser, whose address and history keep the target (FID-336). No signaling message or log event is added.
- **Live only in a chat that often isn't.** Slack and Mattermost conversations are often answered hours later. A link opened after the sender closed the tab fails, and the recipient's first sight of Fidant is a link that didn't work. The posted or copied line says so before the recipient clicks, and the delivery notification tells the sender when to close the tab. Storing a secret or a file for later is outside this project (decided 2026-11-26).
- **Absolutes.** Copy that says our infrastructure never receives a secret, a file's name or a key, or receives nothing about them, is qualified for the typed text and the posted link. The command's request also tells us that someone in a given workspace is about to share a secret or send a file, and which.
- **The issues.**
  - FID-367 gave the send page's modes their own addresses (merged).
  - FID-335 builds the endpoint after the cutover: the route on the signaling container, the size cap, the signature check, the signed post target and its key, the signing secret's runbook, no log event, the manifest with its test, the canary test, the live tests and the `AGENTS.md` exception.
  - FID-336 builds the `#chat` marker, the targets' checks and both post buttons on the send page, the `connect-src` change, and the post's exception for Slack.
  - FID-337 builds `/slack`, `/slack/installed` and the install, and runs the live test.
  - FID-384 builds the Mattermost plugin, its page and the post's exception for Mattermost.
- **The command waits for the cutover.** Nothing ships in Slack before FID-263, because the signing secret belongs in the container's secret store, not on the box.
- **Secrets in the container.** The signing secret and the key that signs post targets, and the client secret only if the fallback install is needed. With either of the first two, someone could make a target that names one channel and posts to another `response_url`; the safety number still catches a wrong person opening the link.
- **Approval from the other maintainer.** `FidantSignal`'s new secrets, `site.js` (with `/slack`, `/slack/installed` and their Swedish addresses added to `PAGES`) and `AGENTS.md` are sensitive paths, so the pull requests that change them need it.
- **The plugin's cost.** The first Go code in the repository, with its own build and tests in CI and a release file per version. A server that requires signed plugins can't install it until a Marketplace carries it: Mattermost's, or one its admin points the server at and trusts the key of. Signing our releases is not decided here. One with uploads off needs them turned on in `config.json`, or the bundle unpacked by hand.
- **Not decided here.** A Marketplace listing for either service, files from Slack itself (FID-159), and a Swedish Slack app. That would be a second app whose commands post to its own path, answered with the same reply in Swedish, so a workspace chooses its language by the link it installs from and we keep no setting.
