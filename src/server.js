#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { pipeline } from "stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getConnectedAliases,
  getAccountInfo,
  withRetry,
  createAuditLogger,
  statRegularFile,
} from "google-mcp-accounts";
import { createToolDefiner, jsonResult, aliasEnumHint, markUntrusted, UNTRUSTED_NOTICE } from "./mcp.js";
import { FILES_DIR, resolveReadablePath, resolveWritablePath } from "./files.js";
import {
  driveClientFor,
  canReadWholeDrive,
  visibilityNote,
  explainDriveError,
  assertEmail,
  buildSearchQuery,
  exportMimeFor,
  isGoogleNative,
  byteLimit,
  saveStreamToFile,
  guessMimeType,
  summarizeFile,
  summarizePermissions,
  shareWarnings,
  assertFileName,
  moveParams,
  FILE_ID,
  FOLDER_MIME,
  MAX_NAME_LENGTH,
  FILE_FIELDS,
  EXPORT_FORMATS,
  SHARE_ROLES,
  SHARE_TYPES,
  MAX_DOWNLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_SHARE_MESSAGE_LENGTH,
} from "./drive.js";

const server = new McpServer({ name: "multi-gdrive-mcp", version: "1.0.0" });

// Shared ~/.google-mcp/audit.log, every line tagged with this server's name.
const logAuditEvent = createAuditLogger("multi-gdrive-mcp");

// MCP tool annotations: hints that let the client (Claude Desktop) decide
// which calls to auto-approve and which always need the user's OK. The
// confirm flags are set by the model, so the client's approval prompt is the
// real human check - these hints are what drive it.
const READ_ONLY = { readOnlyHint: true, openWorldHint: true };
const TOOL_ANNOTATIONS = {
  list_accounts: { readOnlyHint: true, openWorldHint: false },
  search_files: READ_ONLY,
  get_file_metadata: READ_ONLY,
  // Writes a new local file; only overwrites with an explicit overwrite: true.
  download_file: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Can replace an existing Drive file's contents (only with confirm_overwrite).
  upload_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  move_to_trash: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  // Only adds an empty folder; touches nothing that exists.
  create_folder: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  // Changes what collaborators see; the old name is returned so it can be put back.
  rename_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  // Moving into or out of a shared folder changes who can open the file.
  move_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  // Gives another person access to your file and usually emails them - as
  // irreversible in practice as send_email (they may copy it right away).
  share_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};
const defineTool = createToolDefiner(server, TOOL_ANNOTATIONS);

const fileId = z.string().regex(FILE_ID, "not a Drive file id").describe("Drive file id from search_files");

// Runs a Drive call, adding the "drive.file can't see that" explanation to a
// 404/403 so it isn't mistaken for a missing file. Pass { write: true } for the
// lookup a write tool does first, so the hint is about changing the file.
async function driveCall(info, fn, { write = false } = {}) {
  try {
    return await fn();
  } catch (err) {
    throw explainDriveError(err, info, { write });
  }
}

function writeError(action, info, detail, err) {
  logAuditEvent({
    action,
    account: info.alias,
    email: info.email,
    outcome: "error",
    detail: { ...detail, error: err?.message },
  });
  return explainDriveError(err, info, { write: true });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

defineTool(
  "list_accounts",
  "List every Google account connected to this server, with its alias, nicknames, email, and whether this server can read its whole Drive (drive.readonly) or only files these servers created or opened (drive.file). Always call this first if you don't already know the aliases.",
  {},
  async () => {
    const accounts = getConnectedAliases().map((alias) => {
      const info = getAccountInfo(alias);
      return {
        alias,
        nicknames: info.nicknames,
        email: info.email,
        drive_access: canReadWholeDrive(info) ? "whole Drive (read)" : "app-created/opened files only",
      };
    });
    return jsonResult({ accounts });
  }
);

defineTool(
  "search_files",
  `Search one account's Drive by name, full text, type, folder, or modified date. Unless the account granted drive.readonly, this only finds files these Google MCP servers created or opened - not everything in the Drive.${aliasEnumHint()}`,
  {
    account: z.string(),
    name_contains: z.string().max(500).optional(),
    full_text: z.string().max(500).optional().describe("Matches file contents and names"),
    mime_type: z
      .string()
      .max(255)
      .optional()
      .describe(
        'e.g. "application/pdf", "application/vnd.google-apps.document", "application/vnd.google-apps.folder"'
      ),
    folder_id: z.string().max(200).optional().describe("Only files directly inside this folder"),
    modified_after: z.string().max(64).optional().describe("RFC 3339 date, e.g. 2026-10-01"),
    include_trashed: z.boolean().default(false),
    max_results: z.number().int().min(1).max(100).default(25),
  },
  async ({ account, max_results, ...filters }) => {
    const info = getAccountInfo(account);
    const drive = driveClientFor(account);
    const q = buildSearchQuery(filters);
    const { data } = await driveCall(info, () =>
      withRetry(() =>
        drive.files.list({
          q,
          pageSize: max_results,
          orderBy: "modifiedTime desc",
          fields: `files(${FILE_FIELDS})`,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        })
      )
    );
    return jsonResult({
      notice: UNTRUSTED_NOTICE,
      visibility: visibilityNote(info),
      account: info.alias,
      email: info.email,
      count: (data.files || []).length,
      files: (data.files || []).map(summarizeFile),
    });
  }
);

defineTool(
  "get_file_metadata",
  `Get one file's details: name, type, size, owners, modified time, link, and who it's shared with.${aliasEnumHint()}`,
  { account: z.string(), file_id: fileId },
  async ({ account, file_id }) => {
    const info = getAccountInfo(account);
    const drive = driveClientFor(account);
    const { data } = await driveCall(info, () =>
      withRetry(() =>
        drive.files.get({
          fileId: file_id,
          fields: `${FILE_FIELDS}, permissions(type, role, emailAddress, domain)`,
          supportsAllDrives: true,
        })
      )
    );
    return jsonResult({
      notice: UNTRUSTED_NOTICE,
      file: summarizeFile(data),
      shared_with: summarizePermissions(data.permissions),
      export_formats: isGoogleNative(data.mimeType)
        ? Object.keys(EXPORT_FORMATS[data.mimeType] || {})
        : undefined,
    });
  }
);

defineTool(
  "download_file",
  `Download a Drive file into the server's files folder (${FILES_DIR}); files can't be saved anywhere else. Google Docs/Sheets/Slides/Drawings are exported (export_format, default pdf). Up to ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB, counted on the actual bytes received.${aliasEnumHint()}`,
  {
    account: z.string(),
    file_id: fileId,
    save_path: z.string().max(4096).describe(`File name (or path) inside ${FILES_DIR}, e.g. report.pdf`),
    export_format: z
      .string()
      .max(10)
      .optional()
      .describe(
        "For Google-native files only: pdf, docx, xlsx, pptx, csv, txt, md, odt, ods, odp, png, svg, ..."
      ),
    overwrite: z
      .boolean()
      .default(false)
      .describe("Must be true to overwrite a file that already exists at save_path"),
  },
  async ({ account, file_id, save_path, export_format, overwrite }) => {
    const resolved = resolveWritablePath(save_path);
    if (fs.existsSync(resolved) && !overwrite) {
      throw new Error(`A file already exists at ${resolved}. Pass overwrite: true to replace it.`);
    }
    const info = getAccountInfo(account);
    const drive = driveClientFor(account);
    const { data: meta } = await driveCall(info, () =>
      withRetry(() =>
        drive.files.get({ fileId: file_id, fields: "id, name, mimeType, size", supportsAllDrives: true })
      )
    );
    const exportMime = exportMimeFor(meta.mimeType, export_format);
    if (!exportMime && Number(meta.size) > MAX_DOWNLOAD_BYTES) {
      throw new Error(
        `File is ${(Number(meta.size) / 1024 / 1024).toFixed(1)}MB, over the ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB limit.`
      );
    }
    // A download is a read, so a transient failure is retried; each attempt
    // starts a fresh temp file, and a failed one never touches save_path.
    const bytes = await driveCall(info, () =>
      withRetry(async () => {
        const res = exportMime
          ? await drive.files.export({ fileId: file_id, mimeType: exportMime }, { responseType: "stream" })
          : await drive.files.get(
              { fileId: file_id, alt: "media", supportsAllDrives: true },
              { responseType: "stream" }
            );
        return saveStreamToFile(res.data, resolved, { overwrite, maxBytes: MAX_DOWNLOAD_BYTES });
      })
    );
    return jsonResult({
      account: info.alias,
      file_id,
      saved_to: resolved,
      size_bytes: bytes,
      exported_as: exportMime || undefined,
    });
  }
);

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

defineTool(
  "upload_file",
  `Upload a file from the server's files folder (${FILES_DIR}) to Drive, up to ${MAX_UPLOAD_BYTES / 1024 / 1024}MB. Files anywhere else are refused. Without replace_file_id this always creates a NEW file and never overwrites anything. With replace_file_id it replaces that file's contents - that is a DRY RUN by default that shows what would be overwritten; pass confirm_overwrite: true only once that's been reviewed.${aliasEnumHint()}`,
  {
    account: z.string(),
    local_path: z.string().max(4096).describe(`File name (or path) inside ${FILES_DIR}`),
    name: z.string().min(1).max(255).optional().describe("Name in Drive. Defaults to the local file name."),
    folder_id: z
      .string()
      .regex(FILE_ID)
      .optional()
      .describe("Drive folder to put a new file in. Defaults to My Drive."),
    mime_type: z.string().max(255).optional().describe("Defaults to a guess from the file extension"),
    replace_file_id: z
      .string()
      .regex(FILE_ID)
      .optional()
      .describe("Overwrite this existing Drive file's contents instead of creating a new file"),
    confirm_overwrite: z
      .boolean()
      .default(false)
      .describe("Must be true to actually overwrite replace_file_id. Ignored for new uploads."),
  },
  async ({ account, local_path, name, folder_id, mime_type, replace_file_id, confirm_overwrite }) => {
    const resolved = resolveReadablePath(local_path);
    // The real file on disk decides the size - and the stream below re-counts
    // it, in case it grows between this check and the upload.
    const stat = statRegularFile(resolved, MAX_UPLOAD_BYTES);
    const info = getAccountInfo(account);
    const drive = driveClientFor(account);
    const mimeType = mime_type || guessMimeType(resolved);
    const media = () => {
      const limited = byteLimit(MAX_UPLOAD_BYTES, "The local file");
      pipeline(fs.createReadStream(resolved), limited, () => {});
      return { mimeType, body: limited };
    };

    if (replace_file_id) {
      if (folder_id || name)
        throw new Error("folder_id and name only apply to new uploads, not replace_file_id.");
      const { data: target } = await driveCall(
        info,
        () =>
          withRetry(() =>
            drive.files.get({
              fileId: replace_file_id,
              fields: `${FILE_FIELDS}, permissions(type, role, emailAddress, domain)`,
              supportsAllDrives: true,
            })
          ),
        { write: true }
      );
      if (isGoogleNative(target.mimeType)) {
        throw new Error(
          "That's a Google Doc/Sheet/Slides file; its contents can't be replaced by uploading a file."
        );
      }
      const detail = { file_id: replace_file_id, local_file: path.basename(resolved), size_bytes: stat.size };
      if (!confirm_overwrite) {
        logAuditEvent({
          action: "upload_file",
          account: info.alias,
          email: info.email,
          outcome: "dry_run",
          detail,
        });
        return jsonResult({
          dry_run: true,
          notice: UNTRUSTED_NOTICE,
          would_overwrite: summarizeFile(target),
          shared_with: summarizePermissions(target.permissions),
          with_local_file: { path: resolved, size_bytes: stat.size, mime_type: mimeType },
          note: "Everyone the file is shared with will see the new contents. Drive keeps the old version in the file's version history (normally for 30 days). Re-call with confirm_overwrite: true to replace it.",
        });
      }
      try {
        const { data } = await drive.files.update({
          fileId: replace_file_id,
          media: media(),
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        });
        logAuditEvent({
          action: "upload_file",
          account: info.alias,
          email: info.email,
          outcome: "overwritten",
          detail,
        });
        return jsonResult({ overwritten: summarizeFile(data) });
      } catch (err) {
        throw writeError("upload_file", info, detail, err);
      }
    }

    // A new file. Not retried: a retry after a timeout could create a duplicate.
    const driveName = name || path.basename(resolved);
    const detail = { name: driveName, folder_id, size_bytes: stat.size };
    try {
      const { data } = await drive.files.create({
        requestBody: { name: driveName, ...(folder_id ? { parents: [folder_id] } : {}) },
        media: media(),
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      logAuditEvent({
        action: "upload_file",
        account: info.alias,
        email: info.email,
        outcome: "created",
        detail: { ...detail, file_id: data.id },
      });
      return jsonResult({ created: summarizeFile(data) });
    } catch (err) {
      throw writeError("upload_file", info, detail, err);
    }
  }
);

// ---------------------------------------------------------------------------
// Organize
// ---------------------------------------------------------------------------

defineTool(
  "create_folder",
  `Create a new, empty folder in Drive (in My Drive, or inside parent_folder_id). Runs immediately - it doesn't touch anything that exists and notifies nobody. Under drive.file, a parent folder must be one these servers created.${aliasEnumHint()}`,
  {
    account: z.string(),
    name: z.string().max(MAX_NAME_LENGTH),
    parent_folder_id: z
      .string()
      .regex(FILE_ID, "not a Drive folder id")
      .optional()
      .describe("Folder to create it in. Defaults to My Drive."),
  },
  async ({ account, name, parent_folder_id }) => {
    const folderName = assertFileName(name);
    const info = getAccountInfo(account);
    const drive = driveClientFor(account);
    const detail = { name: folderName, parent_folder_id };
    try {
      // Not retried: a retry after a timeout could create a duplicate folder.
      const { data } = await drive.files.create({
        requestBody: {
          name: folderName,
          mimeType: FOLDER_MIME,
          ...(parent_folder_id ? { parents: [parent_folder_id] } : {}),
        },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      logAuditEvent({
        action: "create_folder",
        account: info.alias,
        email: info.email,
        outcome: "created",
        detail: { ...detail, file_id: data.id },
      });
      return jsonResult({ created: summarizeFile(data) });
    } catch (err) {
      throw writeError("create_folder", info, detail, err);
    }
  }
);

defineTool(
  "rename_file",
  `Rename a file or folder. Runs immediately and notifies nobody, but everyone with access sees the new name; the old name is returned so it can be put back. Only works on files these servers created.${aliasEnumHint()}`,
  { account: z.string(), file_id: fileId, new_name: z.string().max(MAX_NAME_LENGTH) },
  async ({ account, file_id, new_name }) => {
    const name = assertFileName(new_name);
    const info = getAccountInfo(account);
    const drive = driveClientFor(account);
    const { data: target } = await driveCall(
      info,
      () =>
        withRetry(() => drive.files.get({ fileId: file_id, fields: FILE_FIELDS, supportsAllDrives: true })),
      { write: true }
    );
    if (target.name === name) return jsonResult({ unchanged: true, file: summarizeFile(target) });
    const detail = { file_id, new_name: name };
    try {
      // Setting a name is idempotent and notifies nobody, so it's safe to retry.
      const { data } = await withRetry(() =>
        drive.files.update({
          fileId: file_id,
          requestBody: { name },
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        })
      );
      logAuditEvent({
        action: "rename_file",
        account: info.alias,
        email: info.email,
        outcome: "renamed",
        detail,
      });
      return jsonResult({ renamed: summarizeFile(data), previous_name: markUntrusted(target.name) });
    } catch (err) {
      throw writeError("rename_file", info, detail, err);
    }
  }
);

defineTool(
  "move_file",
  `Move a file or folder into another folder (it is taken out of its current folder, not copied). Moving changes who can open it: everyone with access to the destination folder gains access, and access inherited from the old folder is lost. By default this is a DRY RUN that shows the file, the destination, and who has access to each; pass confirm_move: true only once that's been reviewed. Under drive.file, both the file and the destination folder must be ones these servers created.${aliasEnumHint()}`,
  {
    account: z.string(),
    file_id: fileId,
    folder_id: z.string().regex(FILE_ID, "not a Drive folder id").describe("Destination folder id"),
    confirm_move: z
      .boolean()
      .default(false)
      .describe("Must be explicitly true to actually move the file. False (default) returns a preview only."),
  },
  async ({ account, file_id, folder_id, confirm_move }) => {
    if (file_id === folder_id) throw new Error("A folder can't be moved into itself.");
    const info = getAccountInfo(account);
    const drive = driveClientFor(account);
    const getWithAccess = (id) =>
      driveCall(
        info,
        () =>
          withRetry(() =>
            drive.files.get({
              fileId: id,
              fields: `${FILE_FIELDS}, permissions(type, role, emailAddress, domain)`,
              supportsAllDrives: true,
            })
          ),
        { write: true }
      );
    const [{ data: target }, { data: folder }] = await Promise.all([
      getWithAccess(file_id),
      getWithAccess(folder_id),
    ]);
    if (folder.mimeType !== FOLDER_MIME) throw new Error("folder_id is not a folder.");
    if (folder.trashed) throw new Error("The destination folder is in the trash.");
    if ((target.parents || []).length === 1 && target.parents[0] === folder_id) {
      return jsonResult({ unchanged: true, note: "The file is already in that folder." });
    }
    const detail = { file_id, folder_id, from_parents: target.parents };

    if (!confirm_move) {
      logAuditEvent({
        action: "move_file",
        account: info.alias,
        email: info.email,
        outcome: "dry_run",
        detail,
      });
      return jsonResult({
        dry_run: true,
        notice: UNTRUSTED_NOTICE,
        would_move: summarizeFile(target),
        file_shared_with: summarizePermissions(target.permissions),
        into_folder: summarizeFile(folder),
        destination_shared_with: summarizePermissions(folder.permissions),
        note:
          "Everyone the destination folder is shared with will be able to open this file. " +
          "Re-call with confirm_move: true to move it.",
      });
    }
    try {
      // Setting the parents is idempotent and notifies nobody, so it's safe to retry.
      const { data } = await withRetry(() =>
        drive.files.update({
          fileId: file_id,
          ...moveParams(target.parents, folder_id),
          requestBody: {},
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        })
      );
      logAuditEvent({
        action: "move_file",
        account: info.alias,
        email: info.email,
        outcome: "moved",
        detail,
      });
      return jsonResult({ moved: summarizeFile(data) });
    } catch (err) {
      throw writeError("move_file", info, detail, err);
    }
  }
);

defineTool(
  "move_to_trash",
  `Move a file (or folder, with everything in it) to the Drive trash. Recoverable from Drive's Trash for 30 days. By default this is a DRY RUN that shows what would be trashed; pass confirm_trash: true to do it.${aliasEnumHint()}`,
  {
    account: z.string(),
    file_id: fileId,
    confirm_trash: z
      .boolean()
      .default(false)
      .describe(
        "Must be explicitly true to actually trash the file. False (default) returns a preview only."
      ),
  },
  async ({ account, file_id, confirm_trash }) => {
    const info = getAccountInfo(account);
    const drive = driveClientFor(account);
    const { data: target } = await driveCall(
      info,
      () =>
        withRetry(() =>
          drive.files.get({
            fileId: file_id,
            fields: `${FILE_FIELDS}, permissions(type, role, emailAddress, domain)`,
            supportsAllDrives: true,
          })
        ),
      { write: true }
    );
    const detail = { file_id, mime_type: target.mimeType, shared: target.shared };
    if (!confirm_trash) {
      logAuditEvent({
        action: "move_to_trash",
        account: info.alias,
        email: info.email,
        outcome: "dry_run",
        detail,
      });
      return jsonResult({
        dry_run: true,
        notice: UNTRUSTED_NOTICE,
        would_trash: summarizeFile(target),
        shared_with: summarizePermissions(target.permissions),
        note:
          (target.mimeType === "application/vnd.google-apps.folder"
            ? "This is a folder: everything inside goes to trash too. "
            : "") + "Re-call with confirm_trash: true to move it to the trash.",
      });
    }
    try {
      // Trashing is idempotent and notifies nobody, so a transient error is safe to retry.
      const { data } = await withRetry(() =>
        drive.files.update({
          fileId: file_id,
          requestBody: { trashed: true },
          fields: FILE_FIELDS,
          supportsAllDrives: true,
        })
      );
      logAuditEvent({
        action: "move_to_trash",
        account: info.alias,
        email: info.email,
        outcome: "trashed",
        detail,
      });
      return jsonResult({ trashed: summarizeFile(data) });
    } catch (err) {
      throw writeError("move_to_trash", info, detail, err);
    }
  }
);

defineTool(
  "share_file",
  `Give one named person or Google group access to a file - treat this with the same care as sending an email: once they have it they can copy it, and by default Google emails them. By default this is a DRY RUN that shows the file, who already has access, and exactly what would be granted; pass confirm_share: true only once that's been reviewed and approved. Link sharing ("anyone with the link") and ownership transfer are deliberately not supported.${aliasEnumHint()}`,
  {
    account: z.string(),
    file_id: fileId,
    email: z.string().max(320).describe("One email address - a person or a Google group"),
    role: z.enum(SHARE_ROLES),
    type: z.enum(SHARE_TYPES).default("user"),
    notify: z.boolean().default(true).describe("Have Google email them about the share (default true)"),
    message: z
      .string()
      .max(MAX_SHARE_MESSAGE_LENGTH)
      .optional()
      .describe("Note included in Google's notification email (only sent when notify is true)"),
    confirm_share: z
      .boolean()
      .default(false)
      .describe("Must be explicitly true to actually share. False (default) returns a preview only."),
  },
  async ({ account, file_id, email, role, type, notify, message, confirm_share }) => {
    const grantee = assertEmail(email);
    if (message && !notify)
      throw new Error("message is only delivered in the notification email; set notify: true or drop it.");
    const info = getAccountInfo(account);
    const drive = driveClientFor(account);
    const { data: target } = await driveCall(
      info,
      () =>
        withRetry(() =>
          drive.files.get({
            fileId: file_id,
            fields: `${FILE_FIELDS}, permissions(type, role, emailAddress, domain)`,
            supportsAllDrives: true,
          })
        ),
      { write: true }
    );
    const detail = { file_id, grantee, type, role, notify };
    const warnings = shareWarnings({ role, existing: target.permissions, email: grantee });

    if (!confirm_share) {
      logAuditEvent({
        action: "share_file",
        account: info.alias,
        email: info.email,
        outcome: "dry_run",
        detail,
      });
      return jsonResult({
        dry_run: true,
        notice: UNTRUSTED_NOTICE,
        file: summarizeFile(target),
        currently_shared_with: summarizePermissions(target.permissions),
        would_grant: { to: grantee, type, role, notification_email: notify, message },
        warnings,
        note: "Re-call with confirm_share: true to actually share this file.",
      });
    }

    try {
      // Not retried: a retry after a timeout could send a second notification email.
      const { data } = await drive.permissions.create({
        fileId: file_id,
        sendNotificationEmail: notify,
        emailMessage: notify ? message : undefined,
        supportsAllDrives: true,
        requestBody: { type, role, emailAddress: grantee },
        fields: "id, type, role, emailAddress",
      });
      logAuditEvent({
        action: "share_file",
        account: info.alias,
        email: info.email,
        outcome: "shared",
        detail: { ...detail, permission_id: data.id },
      });
      return jsonResult({
        shared: { file_id, with: data.emailAddress, role: data.role, permission_id: data.id },
        warnings,
      });
    } catch (err) {
      throw writeError("share_file", info, detail, err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
