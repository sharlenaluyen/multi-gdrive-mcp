import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// files.js reads the folder from the environment at import time, so point it
// at a throwaway directory first - never the real ~/Downloads/drive-mcp.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gdrive-files-")));
const filesDir = path.join(tmp, "files");
process.env.MULTI_GDRIVE_MCP_FILES_DIR = filesDir;

const { FILES_DIR, resolveReadablePath, resolveWritablePath } = await import("../src/files.js");
fs.writeFileSync(path.join(tmp, "secret.txt"), "do not upload");

test("the files folder comes from MULTI_GDRIVE_MCP_FILES_DIR", () => {
  assert.equal(FILES_DIR, filesDir);
  assert.equal(resolveWritablePath("x.pdf"), path.join(filesDir, "x.pdf"));
});

test("upload_file can't read, and download_file can't write, outside the folder", () => {
  assert.throws(() => resolveReadablePath("../secret.txt"), /outside the allowed files folder/);
  assert.throws(() => resolveReadablePath(path.join(os.homedir(), ".ssh", "id_rsa")), /outside|not found/);
  assert.throws(() => resolveWritablePath("../evil.sh"), /outside the allowed files folder/);
});
