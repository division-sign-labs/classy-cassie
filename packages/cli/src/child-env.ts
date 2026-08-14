// packages/cli/src/child-env.ts
// Minimal inherited environments for pinned third-party CLIs. Operator and
// venue secrets unrelated to the child process never cross the exec boundary.

const SYSTEM_NAMES = new Set([
  "ALL_PROXY",
  "APPDATA",
  "BROWSER",
  "CI",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
]);

export function restrictedChildEnv(servicePrefixes: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const normalized = name.toUpperCase();
    if (SYSTEM_NAMES.has(normalized) || servicePrefixes.some((prefix) => normalized.startsWith(prefix))) {
      env[name] = value;
    }
  }
  return env;
}
