import fs from "fs";
import path from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { google } from "googleapis";
import {
  getAccountInfo,
  createAuthClient,
  hasScope,
  REQUIRED_SCOPES,
  DRIVE_READONLY_SCOPE,
} from "google-mcp-accounts";
import { markUntrusted } from "./mcp.js";

// Cache one authed drive client per account (keyed by main alias) per process run.
const clientCache = new Map();

export function driveClientFor(name) {
  const { alias } = getAccountInfo(name);
  if (clientCache.has(alias)) return clientCache.get(alias);
  const auth = createAuthClient(alias, { OAuth2: google.auth.OAuth2, requiredScopes: REQUIRED_SCOPES.drive });
  const drive = google.drive({ version: "v3", auth });
  clientCache.set(alias, drive);
  return drive;
}

// --- What this account can see ------------------------------------------------
// drive.file only covers files this OAuth client created or opened. Accounts
// re-authorized with --with-drive-readonly can also read everything else.
export function canReadWholeDrive(info) {
  return hasScope(info, DRIVE_READONLY_SCOPE);
}

export function visibilityNote(info) {
  return canReadWholeDrive(info)
    ? "This account granted drive.readonly: results cover the whole Drive."
    : "This account granted drive.file only: results cover just the files these Google MCP servers created or opened, not the whole Drive. Re-authorize with --with-drive-readonly to see everything.";
}

// Under drive.file, a file the app never touched looks exactly like a missing
// one (404), so say that instead of leaving a bare "File not found".
export function explainDriveError(err, info) {
  const status = err?.code || err?.response?.status;
  if ((status === 404 || status === 403) && !canReadWholeDrive(info)) {
    err.message =
      `${err.message} - With only drive.file access, this server can reach files these Google MCP servers created or opened, not others in your Drive. ` +
      `To read other files, re-authorize this account once with: node auth.js ${info.alias} --with-drive-readonly (in google-mcp-accounts).`;
  }
  return err;
}

// --- Input validation -----------------------------------------------------
export const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/;
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_SHARE_MESSAGE_LENGTH = 1000;
// Deliberately strict: one plain address, no display name, no list.
const EMAIL = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

export function assertEmail(value) {
  const email = String(value || "").trim();
  if (email.length > 320 || !EMAIL.test(email)) {
    throw new Error(`"${value}" isn't a single plain email address.`);
  }
  return email.toLowerCase();
}

// Values inside a Drive query string are single-quoted; escape so a name
// containing ' or \ can't break out and change the query.
export function escapeQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function buildSearchQuery({
  name_contains,
  full_text,
  mime_type,
  folder_id,
  modified_after,
  include_trashed,
}) {
  const clauses = [];
  if (name_contains) clauses.push(`name contains '${escapeQueryValue(name_contains)}'`);
  if (full_text) clauses.push(`fullText contains '${escapeQueryValue(full_text)}'`);
  if (mime_type) clauses.push(`mimeType = '${escapeQueryValue(mime_type)}'`);
  if (folder_id) {
    if (!FILE_ID.test(folder_id)) throw new Error(`"${folder_id}" isn't a valid folder id.`);
    clauses.push(`'${folder_id}' in parents`);
  }
  if (modified_after) {
    if (!RFC3339.test(modified_after))
      throw new Error(`modified_after "${modified_after}" isn't an RFC 3339 date.`);
    clauses.push(`modifiedTime > '${modified_after}'`);
  }
  if (!include_trashed) clauses.push("trashed = false");
  return clauses.join(" and ");
}

// --- Google-native files (Docs, Sheets, Slides, Drawings) -------------------
// They have no bytes of their own; downloading one means exporting it.
const GOOGLE_NATIVE = "application/vnd.google-apps.";
const OOXML = "application/vnd.openxmlformats-officedocument";
export const EXPORT_FORMATS = {
  [`${GOOGLE_NATIVE}document`]: {
    pdf: "application/pdf",
    docx: `${OOXML}.wordprocessingml.document`,
    odt: "application/vnd.oasis.opendocument.text",
    txt: "text/plain",
    md: "text/markdown",
    rtf: "application/rtf",
  },
  [`${GOOGLE_NATIVE}spreadsheet`]: {
    pdf: "application/pdf",
    xlsx: `${OOXML}.spreadsheetml.sheet`,
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    csv: "text/csv",
  },
  [`${GOOGLE_NATIVE}presentation`]: {
    pdf: "application/pdf",
    pptx: `${OOXML}.presentationml.presentation`,
    odp: "application/vnd.oasis.opendocument.presentation",
    txt: "text/plain",
  },
  [`${GOOGLE_NATIVE}drawing`]: {
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    jpg: "image/jpeg",
  },
};

export function isGoogleNative(mimeType) {
  return Boolean(mimeType?.startsWith(GOOGLE_NATIVE));
}

// The export MIME type for a Google-native file, or null for a regular file
// (downloaded as-is). Throws with the valid choices when they don't fit.
export function exportMimeFor(mimeType, format) {
  if (!isGoogleNative(mimeType)) {
    if (format)
      throw new Error(
        `export_format only applies to Google Docs/Sheets/Slides/Drawings; this is ${mimeType}.`
      );
    return null;
  }
  const formats = EXPORT_FORMATS[mimeType];
  if (!formats) throw new Error(`Google files of type ${mimeType} can't be downloaded or exported.`);
  const chosen = format || "pdf";
  if (!formats[chosen]) {
    throw new Error(`Can't export this file as "${chosen}". Options: ${Object.keys(formats).join(", ")}.`);
  }
  return formats[chosen];
}

// --- Local files ---------------------------------------------------------------
// Counts bytes as they flow and fails once more than maxBytes have passed, so
// a size Drive reported (or a file that grew after it was checked) is never
// trusted on its own.
export function byteLimit(maxBytes, label) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new Error(`${label} is over the ${(maxBytes / 1024 / 1024).toFixed(0)}MB limit.`));
      } else {
        callback(null, chunk);
      }
    },
  });
}

// Streams into a temp file next to `target`, then puts it in place: rename
// when overwriting (atomic, so a failed download never leaves a half-written
// file where a good one was), hard link when not (fails if something appeared
// at `target` meanwhile, instead of clobbering it). Returns bytes written.
export async function saveStreamToFile(source, target, { overwrite, maxBytes }) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.part`);
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      source,
      byteLimit(maxBytes, "The download"),
      counter,
      fs.createWriteStream(tmp, { flags: "wx", mode: 0o600 })
    );
    if (overwrite) {
      fs.renameSync(tmp, target);
    } else {
      try {
        fs.linkSync(tmp, target);
      } catch (err) {
        if (err.code === "EEXIST") {
          throw new Error(`A file already exists at ${target}. Pass overwrite: true to replace it.`, {
            cause: err,
          });
        }
        throw err;
      }
      fs.unlinkSync(tmp);
    }
    return bytes;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const EXT_TO_MIME = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".doc": "application/msword",
  ".docx": `${OOXML}.wordprocessingml.document`,
  ".xls": "application/vnd.ms-excel",
  ".xlsx": `${OOXML}.spreadsheetml.sheet`,
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": `${OOXML}.presentationml.presentation`,
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
};

export function guessMimeType(filename) {
  const match = /\.[a-z0-9]+$/i.exec(filename || "");
  const ext = match ? match[0].toLowerCase() : "";
  return EXT_TO_MIME[ext] || "application/octet-stream";
}

// --- Display -------------------------------------------------------------------
export const FILE_FIELDS =
  "id, name, mimeType, size, modifiedTime, owners(emailAddress), webViewLink, parents, trashed, shared, description";

// Compact view of a file. The name and description were written by whoever
// owns the file - possibly a stranger who shared it - so they're untrusted.
export function summarizeFile(f) {
  return {
    id: f.id,
    name: markUntrusted(f.name),
    mime_type: f.mimeType,
    size_bytes: f.size != null ? Number(f.size) : undefined,
    modified: f.modifiedTime,
    owners: (f.owners || []).map((o) => o.emailAddress),
    shared: f.shared,
    trashed: f.trashed,
    parents: f.parents,
    link: f.webViewLink,
    description: markUntrusted(f.description),
  };
}

export function summarizePermissions(permissions) {
  return (permissions || []).map((p) => ({
    type: p.type,
    role: p.role,
    who: p.emailAddress || p.domain || (p.type === "anyone" ? "anyone with the link" : undefined),
  }));
}

// --- Sharing -------------------------------------------------------------------
// "owner" is left out on purpose: transferring ownership can't be undone.
export const SHARE_ROLES = ["reader", "commenter", "writer"];
// Only named people or groups. "anyone" / "domain" link-sharing would expose
// the file to people nobody named, so this server can't create it at all.
export const SHARE_TYPES = ["user", "group"];

export function shareWarnings({ role, existing, email }) {
  const warnings = [];
  if (role === "writer") {
    warnings.push("writer can edit, re-share with others, and move the file to trash.");
  }
  const current = (existing || []).find((p) => p.emailAddress?.toLowerCase() === email);
  if (current) warnings.push(`${email} already has ${current.role} access; this changes it to ${role}.`);
  if ((existing || []).some((p) => p.type === "anyone")) {
    warnings.push("This file is already shared with anyone who has the link.");
  }
  return warnings;
}
