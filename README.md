# dsh-feishu-session-manager

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that turns one **Feishu** chat into the interface of *every* session in this Harness.

Sessions report themselves into the chat. Summaries are written by a model, and every push names the workspace and the session it came from. Your reply goes back through a second model call that decides **which** session the message belongs to — or whether a fresh session is the better host, and which facts must be carried over.

**English** | [简体中文](README.zh-CN.md)

```
Feishu chat  ⇄  Feishu long connection  ⇄  bridge  ⇄  every session
                                   │            │
                        summarizing model   routing model
```

## What it does

| Direction | Behaviour |
|---|---|
| Session → chat | A finished turn is summarized by the model into a short message that always carries `Workspace: … \| Session: …`. |
| Session → chat | A failed turn is reported with its failure code and a model analysis. |
| Session → chat | `ask_user_question` and permission requests are pushed as numbered menus and answered from the chat. |
| Chat → session | Free text is routed by the model to an existing session, a new session, or a new session carrying distilled context. |
| Chat → session | `/sessions`, `/use`, `/new`, `/bind`, `/status`, `/help`, `/skip` stay deterministic escape hatches. |

The routing model weighs four things, and its prompt states all of them:

1. **Relevance** — does the message continue that session's thread?
2. **Workspace** — which project directory does it belong to?
3. **Context length** — measured against the session's **own model window**, which the Harness reports for the route that served it (the `contextPressure` projection, or the session's selected model), never a budget this plugin invents. A session close to its window is a poor host; the router then distils the essential facts into a fresh session instead of continuing.
4. **Inactivity** — a long-idle session has lost its KV cache, so resuming it is no cheaper than starting over.

The plugin never trusts the model with an identity it was not offered: every `sessionId` and `workspaceId` in an answer is checked against the catalog the model was shown, a missing `prompt` falls back to your own words, and an unusable answer becomes a question to you rather than a wrong turn.

## Install

```sh
pnpm install
pnpm check          # typecheck both halves, build, 142 tests
pnpm pack           # dist/dsh-feishu-session-manager-0.1.9.tgz
```

Install the tarball through **Settings → Plugins**, then **restart** the application. Adding a bundle to a running profile never takes effect until the host process restarts, and reinstalling the same version is a silent no-op — bump the version instead.

The package carries its own `cordis.patch.yml` row, so adding it to `dsh.profile.bundles` is the whole registration. The row needs no config: every setting is written by the settings page.

### The Feishu app

1. In the [Feishu developer console](https://open.feishu.cn/app) create a custom app and add the **bot** capability.
2. **Event subscription**: choose the **long connection** mode and subscribe to `im.message.receive_v1`. Do *not* set a request URL — the bridge dials out to Feishu, so no inbound port, tunnel, or certificate is needed.
3. **Permissions**: `im:message` (read messages sent to the bot) and `im:message:send_as_bot` (send messages as the bot).
4. Publish a version of the app, then add the bot to a group chat or open a direct chat with it.
5. Paste the **App ID** and **App secret** into the plugin's settings page and turn the bridge on.

Feishu only pushes group messages that mention the bot; a direct chat needs no mention.

## Settings page

**Settings → Feishu** (its own navigation section).

| Group | Fields |
|---|---|
| Connection | enable, app ID, app secret (write-only), encrypt key, verification token, notification chat, reply language |
| Model | provider, model, reasoning effort — one route performs both auxiliary calls |
| Prompts | the routing prompt and the summarizing prompt, both editable, both resettable to the shipped default |
| Notifications | turn finished, turn failed, questions, permission requests |
| Routing policy | allow creating sessions, stale-after minutes, routing output cap, transcript size, candidate count, answer timeout, message size, verbose log |
| Status | live connection state, counters, waiting interactions, activity log, test message, reconnect, dry-run router |

The status block is not decoration: **Preview routing** runs the real router on a sample message without delivering anything, which is the fastest way to see why a message would go astray.

Credentials are declared `secret` in the schema, so the settings wire never carries them back to a browser. The page shows `saved — type to replace` instead of the stored value, and leaving a field empty keeps what is stored.

## Talking to the bot

```
/sessions                 list recent sessions with numbers
/use <n|id>               the NEXT message goes to that session
/new [workspace]          create a session now, bypassing the router
/bind                     make this chat the notification target
/status                   connection, model, counters, waiting items
/skip <text>              route this text even while an answer is waiting
/help                     the list above
```

Answers to questions and permission requests are numbered:

- a question: reply with an option number (`2`), a comma list for a multi-select question (`1,3`), or any other text as your own answer;
- a permission request: reply `1` to allow once, `2` to reject;
- several interactions at once: prefix the answer with `#<n>`, for example `#2 1`.

The first chat that speaks to the bot becomes the notification target, written into the profile's settings document so it survives restarts.

## How the pieces fit

| File | Role |
|---|---|
| `src/index.ts` | Loader entry: inject list, `apply`, route mounting |
| `src/bridge.ts` | The four judgements: notify, route, ask, reconnect |
| `src/feishu/client.ts` | Long connection in, REST out, normalized inbound messages |
| `src/feishu/format.ts` | Every message shape and the reply grammar's parser (pure) |
| `src/session/catalog.ts` | Workspaces + candidate sessions + digests, cached briefly |
| `src/session/extract.ts` | Session log → transcript lines (pure, total) |
| `src/llm/call.ts` | Buffered one-shot calls through `ctx.llm` |
| `src/llm/prompts.ts` | Prompt rendering and decision validation (pure) |
| `src/interaction.ts` | The waiting room for questions and approvals (pure) |
| `src/routes.ts` | Loopback-fenced HTTP for the settings page only |
| `src/client/` | The settings page |

Two design choices are worth knowing:

- **The inject list is long on purpose.** A cordis service proxy rebinds `this` to the *caller's* context, so the session controller's cold-prompt path reads `fileUploads`, `attachments`, `fileReferences`, `agentDefaultModel`, `remoteAccess`, `workingDirectory`, `sessionProjections`, `sessionQuery`, `sessions`, `agents`, `llm` and `workspaceRegistry` through *this* plugin's context. Leaving one out fails only the first resume of a cold session, intermittently.
- **Everything the model says is advisory.** `parseRouteDecision` consumes a model answer; ids, actions and required fields are validated, and the numeric `confidence` is clamped. A model answer cannot name a session the catalog did not offer.

### When the routing model fails

A routing answer is one JSON object. A model can still answer with prose, or stop
mid-object because its reasoning consumed the output budget. Three defences keep
that from becoming a dead end:

- the answer is parsed tolerantly: a fenced body, an object inside prose, and a
  truncated object that can be closed all count;
- the call is retried once with the answer contract repeated inside the user
  message, which also covers an adapter that drops the system slot;
- if neither attempt is usable, a deterministic fallback routes anyway — the
  workspace the message names, else the one with the newest activity — and the
  confirmation says the fallback decided.

`Routing output cap (tokens)` controls the first defence's budget: reasoning
tokens count against it, so 2000 is the shipped default rather than a tight 800.
The activity log records both attempts, including the length and opening of an
unusable answer.

### Nothing is dropped for want of a target

A session can stop before the chat has ever spoken to the bot — after a restart the
notification target is unknown until the first inbound message — and that is exactly
when a "stopped for lack of permission" push matters. Undeliverable messages are
held (bounded at 50, oldest dropped first) and delivered oldest-first once a chat and
a live socket exist; each carries a `⏳ Held since HH:MM:SS` line so a late arrival is
not mistaken for a fresh event. The status page shows the held count, and the chat
binding is written back to the profile so a restart starts already bound.

## Limitations

- **Text only.** Images, files, stickers and audio sent to the bot are reported as text-only, not routed.
- **Plugin notices are English.** Model summaries follow the sender's language (or the `reply language` setting); the bridge's own confirmations do not.
- **One chat at a time.** The bridge binds one notification chat; several chats can talk to it, but only that one receives pushes.
- **Approval policy stays the harness's.** When the session's approval policy is `never`, the permission surface never fires — there is nothing to answer.
- **A question is a foreground wait.** If you do not answer inside `answer timeout`, the request is delegated to the browser UI (which may then fail closed). Nothing is invented.

## Verification

What this build was checked against, and what it was not:

| Level | Result |
|---|---|
| Typecheck, both halves | clean (`tsc` host + tests, `tsc` client) |
| Unit and behavioural tests | **142 passed, 2 skipped-groups** — message shapes, reply grammar, router validation (including a truncated answer and structurally broken JSON), the routing failure path driven end to end, transcript digests, the route family over a real loopback server, the host half mounted on a stubbed harness with a `turn/end` travelling into the model call, and the built client bundle registering into `settings.section` through a fake client context |
| Built bundle behind a fake module loader | registers one entry under `dsh-feishu-session-manager`, exports `apply`/`inject`/`NS`/`SECTION_ID`, requests only React |
| Live host in the desktop profile | `GET /api/dsh-feishu-session-manager/status` answers `version 0.1.0`, and reports all eleven probed host services resolved |
| Rendered page in both themes | **not performed**: browser control was refused in this session, so the page's visual state is unverified |

After a restart, `curl http://127.0.0.1:<port>/api/dsh-feishu-session-manager/status` reports the running version, so "which code is live?" is one request away.

## 中文文档

完整的中文说明见 [README.zh-CN.md](README.zh-CN.md)：功能、安装、飞书应用配置、设置页字段、聊天命令与验证范围。

## License

MIT