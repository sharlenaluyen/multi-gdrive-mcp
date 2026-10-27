import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import {
  assertEmail,
  escapeQueryValue,
  buildSearchQuery,
  exportMimeFor,
  isGoogleNative,
  byteLimit,
  saveStreamToFile,
  guessMimeType,
  summarizeFile,
  summarizePermissions,
  shareWarnings,
  explainDriveError,
  canReadWholeDrive,
  FILE_ID,
} from "../src/drive.js";

const G = "https://www.googleapis.com/auth/";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gdrive-test-")));

test("escapeQueryValue stops a name from breaking out of the quoted Drive query", () => {
  assert.equal(escapeQueryValue("it's"), "it\\'s");
  assert.equal(escapeQueryValue("a\\b"), "a\\\\b");
  assert.equal(
    buildSearchQuery({ name_contains: "x' or trashed = true or name contains '" }),
    "name contains 'x\\' or trashed = true or name contains \\'' and trashed = false"
  );
});

test("buildSearchQuery combines filters and excludes trash by default", () => {
  assert.equal(buildSearchQuery({}), "trashed = false");
  assert.equal(
    buildSearchQuery({
      full_text: "budget",
      mime_type: "application/pdf",
      folder_id: "abc_123",
      include_trashed: true,
    }),
    "fullText contains 'budget' and mimeType = 'application/pdf' and 'abc_123' in parents"
  );
  assert.equal(
    buildSearchQuery({ modified_after: "2026-10-01" }),
    "modifiedTime > '2026-10-01' and trashed = false"
  );
});

test("buildSearchQuery rejects a malformed folder id or date instead of splicing it in", () => {
  assert.throws(() => buildSearchQuery({ folder_id: "x' in parents or '1" }), /isn't a valid folder id/);
  assert.throws(() => buildSearchQuery({ modified_after: "last week" }), /isn't an RFC 3339 date/);
});

test("FILE_ID accepts Drive ids and nothing that could reach a path or query", () => {
  assert.ok(FILE_ID.test("1aB-_xYz"));
  for (const bad of ["../x", "a b", "a'b", "a/b", ""]) assert.ok(!FILE_ID.test(bad), bad);
});

test("exportMimeFor: Google-native files export (pdf by default), regular files don't", () => {
  const doc = "application/vnd.google-apps.document";
  assert.ok(isGoogleNative(doc));
  assert.equal(exportMimeFor(doc), "application/pdf");
  assert.match(exportMimeFor(doc, "docx"), /wordprocessingml/);
  assert.equal(exportMimeFor("application/vnd.google-apps.spreadsheet", "csv"), "text/csv");
  assert.throws(() => exportMimeFor(doc, "xlsx"), /Options: pdf, docx/);
  assert.equal(exportMimeFor("application/pdf"), null);
  assert.throws(() => exportMimeFor("application/pdf", "docx"), /only applies to Google/);
  assert.throws(() => exportMimeFor("application/vnd.google-apps.folder"), /can't be downloaded/);
});

test("byteLimit passes data under the limit and fails once it's exceeded", async () => {
  const chunks = [];
  await pipeline(Readable.from([Buffer.alloc(3), Buffer.alloc(2)]), byteLimit(5, "x"), async (src) => {
    for await (const c of src) chunks.push(c);
  });
  assert.equal(Buffer.concat(chunks).length, 5);
  await assert.rejects(
    pipeline(Readable.from([Buffer.alloc(3), Buffer.alloc(3)]), byteLimit(5, "The upload"), async (src) => {
      for await (const c of src) chunks.push(c);
    }),
    /The upload is over the/
  );
});

test("saveStreamToFile writes the file and counts the real bytes", async () => {
  const target = path.join(tmp, "a.bin");
  const bytes = await saveStreamToFile(Readable.from([Buffer.from("hello")]), target, {
    overwrite: false,
    maxBytes: 100,
  });
  assert.equal(bytes, 5);
  assert.equal(fs.readFileSync(target, "utf8"), "hello");
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test("saveStreamToFile never clobbers an existing file without overwrite, and leaves no temp files", async () => {
  const target = path.join(tmp, "a.bin");
  await assert.rejects(
    saveStreamToFile(Readable.from([Buffer.from("new")]), target, { overwrite: false, maxBytes: 100 }),
    /already exists.*overwrite: true/
  );
  assert.equal(fs.readFileSync(target, "utf8"), "hello");
  await saveStreamToFile(Readable.from([Buffer.from("new")]), target, { overwrite: true, maxBytes: 100 });
  assert.equal(fs.readFileSync(target, "utf8"), "new");
  assert.deepEqual(
    fs.readdirSync(tmp).filter((f) => f.endsWith(".part")),
    []
  );
});

test("an oversized download fails without touching the existing file", async () => {
  const target = path.join(tmp, "a.bin");
  await assert.rejects(
    saveStreamToFile(Readable.from([Buffer.alloc(50), Buffer.alloc(60)]), target, {
      overwrite: true,
      maxBytes: 100,
    }),
    /over the/
  );
  assert.equal(fs.readFileSync(target, "utf8"), "new");
  assert.deepEqual(
    fs.readdirSync(tmp).filter((f) => f.endsWith(".part")),
    []
  );
});

test("guessMimeType maps known extensions case-insensitively and falls back otherwise", () => {
  assert.equal(guessMimeType("Report.PDF"), "application/pdf");
  assert.equal(guessMimeType("noext"), "application/octet-stream");
});

test("assertEmail accepts exactly one plain address", () => {
  assert.equal(assertEmail("Ann@X.com"), "ann@x.com");
  for (const bad of ["a@x.com,b@x.com", "Ann <ann@x.com>", "anyone", "x@y"]) {
    assert.throws(() => assertEmail(bad), /single plain email/, bad);
  }
});

test("summarizeFile wraps the owner-written name and description as untrusted", () => {
  const s = summarizeFile({ id: "1", name: "Q3 plan", size: "42", owners: [{ emailAddress: "o@x.com" }] });
  assert.equal(s.size_bytes, 42);
  assert.deepEqual(s.owners, ["o@x.com"]);
  assert.match(s.name, /^<untrusted_drive_content>\nQ3 plan\n<\/untrusted_drive_content>$/);
  assert.equal(s.description, undefined);
});

test("summarizePermissions describes link sharing plainly", () => {
  assert.deepEqual(summarizePermissions([{ type: "anyone", role: "reader" }]), [
    { type: "anyone", role: "reader", who: "anyone with the link" },
  ]);
});

test("shareWarnings flags writer access, role changes, and existing link sharing", () => {
  const existing = [
    { type: "user", role: "reader", emailAddress: "Bob@x.com" },
    { type: "anyone", role: "reader" },
  ];
  const warnings = shareWarnings({ role: "writer", existing, email: "bob@x.com" });
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /re-share/);
  assert.match(warnings[1], /already has reader access/);
  assert.match(warnings[2], /anyone who has the link/);
  assert.deepEqual(shareWarnings({ role: "reader", existing: [], email: "c@x.com" }), []);
});

test("explainDriveError explains drive.file's limited view on a 404, only when that's the cause", () => {
  const fileOnly = { alias: "work", scopes: [`${G}drive.file`] };
  const whole = { alias: "work", scopes: [`${G}drive.file`, `${G}drive.readonly`] };
  assert.ok(!canReadWholeDrive(fileOnly));
  assert.ok(canReadWholeDrive(whole));
  const e1 = explainDriveError(Object.assign(new Error("File not found: x."), { code: 404 }), fileOnly);
  assert.match(e1.message, /File not found: x\. - With only drive\.file access.*--with-drive-readonly/);
  const e2 = explainDriveError(Object.assign(new Error("File not found: x."), { code: 404 }), whole);
  assert.equal(e2.message, "File not found: x.");
  const e3 = explainDriveError(Object.assign(new Error("Bad request"), { code: 400 }), fileOnly);
  assert.equal(e3.message, "Bad request");
});
