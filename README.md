# Summer

Summer is a local, open-source tool for AI-coding **usage and spend**, built by
[Autumn](https://useautumn.com). Per developer, across **Claude Code**, **Codex**, and
**opencode**, it answers: how much is each engineer using, on what models, and what's it worth?

![Summer dashboard](docs/dashboard.png)

## How it works

Summer needs **zero hosting**. It uses [Autumn](https://useautumn.com) as its backend and comes
with a local dashboard — Autumn stores every usage event, prices tokens (via
[Models.dev](https://models.dev)), and aggregates usage across your whole team.

## Get started

> **Note:** If you already have an Autumn org, create a **new org** to use with Summer.

```bash
bun -g install @useautumn/summer   # install Summer

summer start                        # set up, then track usage in the background

summer dash                         # open the usage dashboard
```

`summer start` does everything first-time setup needs:

1. **Authenticates with Autumn** via OAuth — logs you in (or signs you up) and sets up your org.
2. **Offers to backfill** your history.
3. **Starts a local daemon** to collect Claude Code + Codex usage and send it to Autumn.

`summer dash` serves a local UI (and opens it in your browser): a usage chart you can
**group by** harness / model / user / billing mode, **filter** by any property, search
**per-developer** usage, and inspect the raw **events**.

> **Note:** Summer installs an autostart service (launchd/systemd) so it survives reboots.
> Pass `--no-service` for a plain background process.

> **Claude Code requires a restart to send usage after `summer start`.** Either start new sessions, or for existing ones, restart and `/resume`. (Codex/opencode don't need a restart.)

## Invite your team

Summer rolls up usage across everyone in your Autumn org.

1. Open your Autumn org settings →
   [**Members**](https://app.useautumn.com/sandbox/settings?tab=members).
2. Invite a teammate by email.
3. They accept the invite in Autumn, run `summer start` themselves, **then restart Claude Code**
   (see the note above — otherwise only their backfill shows up, not live Claude usage).

That's it — their usage shows up alongside yours in the dashboard.

## Commands

| Command | What it does |
| --- | --- |
| `summer start` | Set up (if needed) and start tracking. |
| `summer dash` | Open the usage dashboard (alias: `dashboard`). |
| `summer backfill` | Import historical Claude Code + Codex usage (backdated). |
| `summer report` | Usage rollup in the terminal. |
| `summer status` | Auth + local state. |
| `summer stop` | Stop and restore harness settings (also removes autostart). |
| `summer service install` / `uninstall` / `status` | Manage on-boot autostart. |
| `summer login` / `logout` | Manage Autumn auth. |

## Harnesses Supported

Claude Code, Codex, OpenCode
