// packages/cli/src/remote-write.ts
// One shell string for writing a file on a droplet from stdin: content never
// touches argv or the process list, and a dropped connection cannot leave a
// half-written file because the move is the last step.

export function remoteWriteCommand(path: string, mode: string, owner: string): string {
  const tmp = `${path}.tmp`;
  return `umask 077 && cat > '${tmp}' && chown ${owner} '${tmp}' && chmod ${mode} '${tmp}' && mv '${tmp}' '${path}'`;
}
