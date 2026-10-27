import path from "path";
import os from "os";
import { createFilesFolder } from "google-mcp-accounts";

// The only folder upload_file may read from and download_file may write to.
// Without this, a prompt-injected tool call could upload any file you can
// read (e.g. ~/.ssh/id_rsa) to Drive, or overwrite files anywhere. Override
// with the MULTI_GDRIVE_MCP_FILES_DIR environment variable.
export const { FILES_DIR, resolveReadablePath, resolveWritablePath } = createFilesFolder(
  process.env.MULTI_GDRIVE_MCP_FILES_DIR
    ? path.resolve(process.env.MULTI_GDRIVE_MCP_FILES_DIR)
    : path.join(os.homedir(), "Downloads", "drive-mcp")
);
