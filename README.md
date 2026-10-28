# multi-gdrive-mcp

A local MCP server that lets Claude search, download, upload, trash, and
share **Google Drive files across several Google accounts** through one
connection. It runs on your own computer (stdio) and plugs into the Claude
desktop app.

Accounts come from the shared [google-mcp-accounts](../google-mcp-accounts)
login, the same one the Gmail, Calendar, and Docs/Sheets/Slides servers use.

## Scopes: `drive.file` by default, whole-Drive read only if you opt in

| Scope | Default? | What it allows |
| --- | --- | --- |
| `drive.file` | **Yes.** This server checks for it on every call. | Only files these Google MCP servers **created or opened** with this OAuth client. That covers files you upload here, decks made by `create_presentation`, and so on. It does **not** reach the rest of your Drive. |
| `drive.readonly` | **No.** It's a deliberate, per-account escalation. | Read access to **every file** in that account's Drive. |

What that means for each tool:

| Tool | With `drive.file` only | With `drive.readonly` added |
| --- | --- | --- |
| `search_files` | Finds only app-created/opened files | Searches the whole Drive |
| `get_file_metadata`, `download_file` | Only app-created/opened files. Others return "not found", plus an explanation | Any file |
| `upload_file` (new file) | Works | Works |
| `create_folder` | Works (into My Drive, or a folder these servers created) | Same |
| `upload_file` (replace), `move_to_trash`, `share_file`, `rename_file`, `move_file` | Only app-created/opened files (and for `move_file`, a destination folder these servers created) | **Same.** `drive.readonly` doesn't grant write access. |

To escalate one account, run this once in google-mcp-accounts:

```bash
node auth.js work --with-drive-readonly
```

`list_accounts` and every `search_files` result say which mode the account
is in. When a file can't be **read** under `drive.file`, the error names the
exact command above rather than leaving a bare 404. When a **change** (trash,
share, replace, rename, move, or upload into a folder) is refused, the error says instead
that these servers only change files they created, and that `drive.readonly`
won't help, so you're not sent to an opt-in that can't fix it. The full
`drive` scope (read **and write** everything) is never requested.

## Tools

| Tool | What it does | Safety |
| --- | --- | --- |
| `list_accounts` | Accounts, nicknames, emails, and Drive access mode | |
| `search_files` | Name / full-text / type / folder / modified-date search | Read-only, retried on 429/5xx |
| `get_file_metadata` | Owners, size, link, who it's shared with, and export formats | Read-only, retried |
| `download_file` | Saves into the files folder. Google Docs/Sheets/Slides/Drawings are exported (pdf, docx, xlsx, pptx, csv, ...) | Never overwrites unless `overwrite: true`. Writes via a temp file, so a failed download never corrupts an existing one. 100MB cap, counted on actual bytes |
| `upload_file` | Uploads from the files folder | A **new file runs right away** and can't overwrite anything. **Replacing** an existing file (`replace_file_id`) is a dry run until `confirm_overwrite: true`, and the preview shows the file and who it's shared with. 100MB cap, checked on the real file and re-counted while streaming |
| `create_folder` | Creates an empty folder in My Drive or inside `parent_folder_id` | Runs right away: it touches nothing that exists. Not retried, so a timeout can't create two |
| `rename_file` | Renames a file or folder | Runs right away and notifies nobody. Returns `previous_name` so it can be put back. Retried on transient errors |
| `move_file` | Moves a file or folder into another folder (out of its current one, not a copy) | Dry run until `confirm_move: true`. The preview shows who has access to the file **and** to the destination folder (see below) |
| `move_to_trash` | Moves a file or folder to Trash (recoverable for 30 days) | Dry run until `confirm_trash: true` |
| `share_file` | Grants one named person or group reader/commenter/writer access | Dry run until `confirm_share: true` (see below) |

### Judgment calls

- **`share_file` is treated at least as carefully as `send_email`.** Once
  someone has access, they can copy the file. The preview shows the file,
  everyone who already has access, exactly what would be granted, and
  warnings: writer can re-share and delete, this changes an existing role,
  the file is already link-shared. Guard rails:
  - one plain email address only (no lists or display names);
  - roles are `reader`, `commenter`, or `writer` only, and **ownership
    transfer is not possible**;
  - types are `user` or `group` only. **"Anyone with the link" and
    domain-wide sharing are deliberately not supported**, since they
    expose the file to people nobody named. Do those in the Drive UI if you
    really mean to;
  - never auto-retried, because a retry could send a second notification
    email.
- **New uploads don't need a confirm.** A new file can't overwrite
  anything, and you can trash it afterwards. It is audit-logged, and it's
  not auto-retried, since a retry after a timeout could create a duplicate.
  One caveat: uploading into a folder that's shared makes the file visible
  to that folder's members.
- **`move_file` gets a dry run; `rename_file` and `create_folder` don't.**
  Moving changes who can open a file. Everyone with access to the
  destination folder can open it afterwards, and any access inherited from
  the old folder is gone. That's a sharing change, so it's previewed like
  one. Renaming and creating a folder change no one's access and are easy to
  undo, so they run right away, like a new upload. All three are
  audit-logged.
- **`move_to_trash` is retried on transient errors.** Trashing is
  idempotent and notifies nobody. Sharing, uploading, and overwriting are
  never retried.

Every share, trash, upload, overwrite, folder creation, rename, and move, including dry runs and failures,
is appended to `~/.google-mcp/audit.log`, tagged
`"server": "multi-gdrive-mcp"`. File contents are never logged.

## The files folder

`upload_file` can only read from, and `download_file` can only write to,
`~/Downloads/drive-mcp` (created on first use). Paths are checked after
resolving `../` and symlinks, so a prompt-injected call can't upload
`~/.ssh/id_rsa` or overwrite a file elsewhere. To use a different folder,
set `MULTI_GDRIVE_MCP_FILES_DIR` (see the config below).

**To attach Drive files to emails, give this server and multi-gmail-mcp the
same folder.** Set `MULTI_GDRIVE_MCP_FILES_DIR` and multi-gmail-mcp's
`MULTI_GMAIL_MCP_FILES_DIR` to the same path. Then a file `download_file`
saves is right where Gmail's `attach_document` can read it. Without this,
"attach this Drive doc to my email" fails, because each server only reads its
own folder. Only the config changes, no code. See "One files folder for all
the servers" in google-mcp-accounts' README.

## Setup

1. Set up [google-mcp-accounts](../google-mcp-accounts) and connect your
   accounts. Make sure the **Google Drive API** is enabled on the Cloud
   project.
2. Install:

   ```bash
   cd multi-gdrive-mcp
   npm install
   ```

   Requires Node.js 20+. This repo depends on google-mcp-accounts as a
   local folder, `"google-mcp-accounts": "file:../google-mcp-accounts"`.
   That works only while the two repos are **siblings in the same parent
   folder**. If you clone this somewhere they aren't, switch that line to a
   git dependency pinned to a tag, e.g.
   `"github:<you>/google-mcp-accounts#v1.0.0"`. The tradeoff: `file:` picks
   up shared changes immediately, and a git tag picks them up only when you
   bump it.

### Claude Desktop config

Add this under `mcpServers` in
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS),
then fully quit and reopen Claude Desktop:

```json
{
  "mcpServers": {
    "multi-gdrive": {
      "command": "node",
      "args": ["/absolute/path/to/multi-gdrive-mcp/src/server.js"],
      "env": { "MULTI_GDRIVE_MCP_FILES_DIR": "/Users/you/Downloads/google-mcp-files" }
    }
  }
}
```

The `env` line is optional. Leave it out to use `~/Downloads/drive-mcp`.
Use the same path as multi-gmail-mcp's `MULTI_GMAIL_MCP_FILES_DIR` if you
want to attach Drive files to emails.

## Security notes

- **Untrusted names.** Anyone can share a file with you, so file names and
  descriptions come back wrapped in `<untrusted_drive_content>` tags, with
  a notice telling Claude to treat them as data. That helps against prompt
  injection but doesn't prevent it. The dry runs and Claude Desktop's
  approval prompts are the real checks.
- **Query injection.** Search values are escaped before they go into
  Drive's query language. Folder ids and dates are validated, never spliced
  in raw.
- **Every tool call is wrapped.** API errors and validation failures become
  MCP error results and never crash the server.
- This server never writes to `~/.google-mcp/accounts.json`. It only reads
  tokens.

## Development

```bash
npm test      # node:test - query escaping, export formats, size limits, safe file writes, share checks
npm run lint
npm run format
```
