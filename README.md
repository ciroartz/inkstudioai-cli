# inkstudioai

[![npm version](https://img.shields.io/npm/v/inkstudioai)](https://www.npmjs.com/package/inkstudioai)
[![npm downloads](https://img.shields.io/npm/dm/inkstudioai)](https://www.npmjs.com/package/inkstudioai)

AI tattoo generator for your terminal and your AI agents.

**One free design for new accounts, no card needed.**

`inkstudioai` is the official command line tool for [Ink Studio AI](https://inkstudioai.com). Describe a tattoo in words and get a finished design as an image file. It also runs as an MCP server, so Claude, Cursor, Windsurf, and other AI agents can create tattoo designs for you.

- Create tattoo designs from text in styles such as fine line, Japanese, traditional, and realism.
- Search the public gallery of tattoo designs for ideas, with no account.
- Check your plan and credits, and buy a plan from the terminal.
- Zero dependencies. Node.js 18.17 or newer.

## Install

Run it once with npx:

```sh
npx inkstudioai login
```

Or install it globally:

```sh
npm i -g inkstudioai
```

The package installs two command names, `inkstudioai` and the shorter `inkstudio`. They are the same tool.

## Quick start

```sh
# 1. Sign in. No account yet? Create one in the browser. New accounts get one free design.
npx inkstudioai login

# 2. Create a design. The image is saved in the current directory.
npx inkstudioai generate "a fox sleeping inside a crescent moon" --style fine-line

# 3. Look for ideas in the public gallery.
npx inkstudioai gallery dragon
```

Output of `generate` with the free design of a new account:

```text
✔ Design ready in 21s
  File      a-fox-sleeping-inside-a-crescent-moon.webp
  Image     https://cdn.inkstudioai.com/free-tattoo-designs/6718f0c2.webp
  Style     fine-line, black ink, white background
  Quality   free (0 free designs left)
  Saved to  https://inkstudioai.com/account?view=tattoos&utm_source=cli&utm_medium=referral

  Try it on your skin  https://inkstudioai.com/tools/try-tattoo?design=https%3A%2F%2Fcdn.inkstudioai.com%2F...
  Make a stencil       https://inkstudioai.com/tools/tattoo-to-stencil?utm_source=cli&utm_medium=referral
```

The try-on link opens the website's tattoo simulator with the new design loaded. Links to website pages carry `utm_source=cli`, so Ink Studio AI can count visits from the CLI. Image, API, and checkout links have no such parameters.

## Commands

Every command has `--help`, and `inkstudioai help <command>` shows the same text. Global options:

| Option            | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `--json`          | Print raw JSON for scripts and agents                     |
| `--api-key <key>` | Use this key instead of `INKSTUDIO_API_KEY` or the saved key |
| `--no-color`      | Turn off colors. `NO_COLOR` also works                    |
| `-h, --help`      | Show help                                                 |
| `-v, --version`   | Show the version                                          |

### login

Sign in with your browser. The terminal shows a code and opens a page. Check that the page shows the same code, then approve. The CLI saves an API key on your computer.

New to Ink Studio AI? Create an account on the same page. New accounts get one free tattoo design.

```sh
inkstudioai login
inkstudioai login --no-browser          # print the link, do not open a browser
inkstudioai login --key isk_...         # save a key from your account page
echo "$KEY" | inkstudioai login --with-key
```

In a terminal, `--with-key` asks you to paste the key and press Enter.

### generate (alias: gen)

Create a tattoo design from a text prompt.

```sh
inkstudioai generate "a fox in a crescent moon"
inkstudioai gen "koi fish with waves" --style japanese --color
inkstudioai gen "rose and dagger" --skin --open
inkstudioai gen "minimal mountain range" --out designs/
inkstudioai gen "lotus flower" --out lotus.webp
inkstudioai gen "compass rose" --negative "text, letters" --no-save
inkstudioai gen "lotus flower" --out lotus.webp --force   # replace lotus.webp
```

| Option              | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `-s, --style <id>`  | Style id from `inkstudioai styles`. Default: `minimal`           |
| `-c, --color`       | Color ink. Default: black ink                                    |
| `--skin`            | Show the design on skin instead of a white background            |
| `--negative <text>` | Things to leave out of the design                                |
| `-o, --out <path>`  | File or directory for the image. Default: the current directory |
| `--force`           | Overwrite the `--out` file if it exists                          |
| `--no-save`         | Do not download the image, only print its URL                   |
| `--open`            | Open the image when it is ready                                  |

Without `--out`, or with a directory, the file name comes from the prompt, for example `a-fox-in-a-crescent-moon.webp`. An existing file is never overwritten; the CLI adds `-2`, `-3`, and so on.

With `--out <file>`, the CLI refuses to overwrite an existing file unless you add `--force`. The extension always matches the image type that the server sends: `--out lotus.png` saves `lotus.webp` when the image is WebP, and the CLI tells you. The `File` line and the `file` field of `--json` show the real name.

If you have no free design left and no plan, `generate` shows the error and the plans. In an interactive terminal it then asks `Open checkout for 7-day-access ($12.99)? [Y/n]` for the cheapest plan, and opens Stripe checkout when you answer yes. It does not ask with `--json`, in CI (`CI` is set), or when stdin is not a terminal.

If the connection breaks after the server accepted the prompt, the design can still be finished and saved, and it can use a generation. The CLI then does not tell you to try again. Run `inkstudioai designs` to check if the design is in your account first.

### styles

List the style ids for `--style`.

```sh
inkstudioai styles
```

### designs

List the designs saved to your account, newest first.

```sh
inkstudioai designs
inkstudioai designs --limit 50 --page 2
```

### gallery

Search the public gallery. No login needed.

```sh
inkstudioai gallery
inkstudioai gallery "minimalist wave" --limit 5
```

### whoami (alias: status)

Show your plan, the time left on it, free designs, premium credits, and API use today. When less than 2 days are left, `whoami` tells you how to extend the plan.

```sh
inkstudioai whoami
```

```text
  Account          ana@example.com (Ana)
  Plan             Active, 8 days left (ends Nov 1, 10:00 UTC)
  Free designs     0
  Premium credits  28 (8 plan, 20 purchased) for the image tools on the website
  Designs made     14
  API today        3 of 50 generations
  Next design      Paid quality
  API key          isk_AbCdEfGh… (config file)
```

### pricing

Show the plans and credit packs.

```sh
inkstudioai pricing
```

### buy

Open Stripe checkout for a plan or credit pack. The purchase is added to the signed-in account.

```sh
inkstudioai buy 7-day-access
inkstudioai buy 7-day-access --no-browser   # only print the checkout link
```

### open

Open a page of the website.

```sh
inkstudioai open account
inkstudioai open pricing
inkstudioai open developers
```

### logout

Remove the saved key from this computer. The key still works on the server until you revoke it on your [account page](https://inkstudioai.com/account).

```sh
inkstudioai logout
```

## Use with AI agents (MCP)

`inkstudioai mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. It gives an agent these tools:

| Tool              | What it does                                                       |
| ----------------- | ------------------------------------------------------------------ |
| `login`           | Sign in from the chat: returns a link and code to approve in the browser |
| `generate_tattoo` | Create a design from a prompt, style, color, and background. Returns the image, so the client can show it in the chat |
| `list_styles`     | List the style ids                                                 |
| `get_account`     | Show the plan, free designs, credits, and usage                    |
| `search_gallery`  | Search the public gallery                                          |
| `get_pricing`     | List plans and credit packs                                        |
| `create_checkout` | Create a Stripe checkout link for the user to open. It charges nothing by itself |

There are three ways to sign in:

- No terminal needed: ask the agent to sign you in. It calls the `login` tool and gives you a link and a code. Approve the code in the browser (or create an account there), then tell the agent. It calls `login` again, which saves the API key on your computer.
- Run `npx inkstudioai login` in a terminal. The MCP server uses the same saved key.
- Create a key on your [account page](https://inkstudioai.com/account) and put it in `INKSTUDIO_API_KEY` in the client config. This key takes precedence over the saved key.

The server reads the saved key on each tool call, so a login while the client runs needs no restart.

`generate_tattoo` returns the image URL as text. It also returns the image itself (when it is smaller than 1.5 MB) and, on protocol `2025-06-18`, a `resource_link` to the image. If the download fails, the result has only the text. It sends `notifications/progress` messages when the client gives a `progressToken`. Links to website pages carry `utm_source=mcp`. The server supports MCP protocol versions `2025-06-18` and `2024-11-05`.

**Claude Code**

```sh
claude mcp add inkstudioai --env INKSTUDIO_API_KEY=isk_... -- npx -y inkstudioai mcp
```

If you ran `npx inkstudioai login`, or want to sign in with the `login` tool, you can leave out the key:

```sh
claude mcp add inkstudioai -- npx -y inkstudioai mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "inkstudioai": {
      "command": "npx",
      "args": ["-y", "inkstudioai", "mcp"],
      "env": { "INKSTUDIO_API_KEY": "isk_..." }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json` in a project)

```json
{
  "mcpServers": {
    "inkstudioai": {
      "command": "npx",
      "args": ["-y", "inkstudioai", "mcp"],
      "env": { "INKSTUDIO_API_KEY": "isk_..." }
    }
  }
}
```

Windsurf and other MCP clients use the same command, arguments, and environment variable. In every client you can leave out `env` and sign in with the `login` tool instead.

## Scripts and JSON output

Add `--json` to any command to get the raw API response on stdout. Errors are JSON too, with `error`, `code`, and `hints`, and the exit code is not 0. A wrong command or option has `"code": "usage"`.

If the design is ready but the image file could not be saved, `generate --json` prints the full result with `"file": null` and a `saveError` message, and exits with `3`. The design is in your account, so do not generate it again.

```sh
inkstudioai generate "a paper crane" --json | jq -r .imageUrl
```

Exit codes: `0` success, `1` error, `2` wrong command or options, `3` design created but the image file not saved.

## Configuration

| Setting                  | Where                                                                   |
| ------------------------ | ----------------------------------------------------------------------- |
| API key                  | `--api-key`, then `INKSTUDIO_API_KEY`, then the saved key               |
| Saved key                | `$XDG_CONFIG_HOME/inkstudioai/config.json`, default `~/.config/inkstudioai/config.json`, on Windows `%APPDATA%\inkstudioai\config.json`. Only your user can read it |
| API URL                  | `INKSTUDIO_API_URL`, default `https://inkstudioai.com/api/v1`           |
| Do not open a browser    | `INKSTUDIO_NO_BROWSER=1`                                                |
| No colors                | `NO_COLOR=1` or `--no-color`                                            |

## Pricing

Every new account gets one free design, and no card is needed for it. A plan gives unlimited text-to-tattoo designs (up to 50 a day through the API) and premium credits for the image tools on the website. Credit packs add premium credits to an active plan. See current prices with `inkstudioai pricing` or on the [pricing page](https://inkstudioai.com/pricing).

## API

The CLI uses the public Ink Studio AI API. You can call it from any language.

- Developer docs: https://inkstudioai.com/developers
- OpenAPI spec: https://inkstudioai.com/api/v1/openapi.json

## Privacy

Designs you create are saved privately to your account, in your design history on the website. The CLI sends your prompt and options to the Ink Studio AI API and stores only your API key on your computer.

## Support

Questions or problems: help@inkstudioai.com, or open an issue at https://github.com/ciroartz/inkstudioai-cli/issues. Report security problems by email, not in an issue (see SECURITY.md).

## License

MIT
