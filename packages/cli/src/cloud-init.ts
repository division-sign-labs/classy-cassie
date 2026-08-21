// packages/cli/src/cloud-init.ts
// First-boot provisioning for a bot droplet. Nothing secret goes in here: the
// droplet metadata service serves user-data to anything running on the box.
// Credentials arrive afterwards, over SSH, on stdin.

export const DROPLET_IMAGE = "ubuntu-24-04-x64";
export const DEFAULT_REGION = "sgp1";
export const DEFAULT_SIZE = "s-1vcpu-1gb";
export const RUNTIME_PACKAGE = "@quotient-forecasting/cassie-runtime-node";
/** Written by cloud-init when provisioning finishes, and polled by `cassie deploy`. */
export const READY_MARKER = "/var/lib/cassie/.provisioned";
export const UNIT_PATH = "/etc/systemd/system/cassie@.service";

/** The systemd template unit. A redeploy rewrites it, so it lives on its own. */
export function renderUnit(runtimeVersion: string): string {
  return `[Unit]
Description=cassie trading bot (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cassie
Group=cassie
EnvironmentFile=/etc/cassie/%i.env
Environment=CASSIE_STATE_PATH=/var/lib/cassie/%i.sqlite
Environment=CASSIE_CONTROL_SOCKET=/run/cassie/%i.sock
Environment=CASSIE_RUNTIME_VERSION=${runtimeVersion}
ExecStart=/usr/bin/cassie-runtime
Restart=always
RestartSec=5
# The stop path cancels resting orders before exit. Give it room.
TimeoutStopSec=45
KillSignal=SIGTERM
RuntimeDirectory=cassie
RuntimeDirectoryMode=0750
StateDirectory=cassie
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=/var/lib/cassie
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

/** Shell command that installs the runtime at an exact version. */
export function installRuntimeCommand(runtimeVersion: string): string {
  return `npm install --global --omit=dev --no-audit --no-fund ${RUNTIME_PACKAGE}@${runtimeVersion}`;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n")
    .trimEnd();
}

export interface CloudInitParams {
  /** Runtime version to install. Pinned to the CLI's version so the two agree. */
  runtimeVersion: string;
  /** Overrides the npm install with a tarball uploaded after boot. */
  tarball?: boolean;
}

export function renderCloudInit(params: CloudInitParams): string {
  const install = params.tarball
    ? "echo 'awaiting runtime tarball from cassie deploy'"
    : installRuntimeCommand(params.runtimeVersion);

  return `#cloud-config
# Refresh the apt indexes, but skip a full distro upgrade: on a 1 vCPU droplet
# it regenerates initramfs for every kernel and adds minutes to first boot
# before Node is even installed. unattended-upgrades carries security patches
# from here.
package_update: true
packages:
  - curl
  - ca-certificates
  - ufw
  - unattended-upgrades
  - build-essential
  - python3

write_files:
  - path: ${UNIT_PATH}
    permissions: '0644'
    content: |
${indent(renderUnit(params.runtimeVersion), 6)}

  - path: /etc/systemd/journald.conf.d/cassie.conf
    permissions: '0644'
    content: |
      [Journal]
      Storage=persistent
      SystemMaxUse=200M

  - path: /etc/ssh/sshd_config.d/cassie.conf
    permissions: '0644'
    content: |
      PasswordAuthentication no
      PermitRootLogin prohibit-password
      KbdInteractiveAuthentication no

runcmd:
  # 1 GB of swap: a 1 vCPU / 1 GB droplet builds better-sqlite3 from source if
  # no prebuild matches, and the linker is what runs out of memory.
  - [ sh, -c, "fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab" ]
  - [ sh, -c, "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -" ]
  - [ sh, -c, "apt-get install -y nodejs" ]
  - [ sh, -c, "id -u cassie >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/cassie --shell /usr/sbin/nologin cassie" ]
  - [ sh, -c, "install -d -m 0750 -o cassie -g cassie /etc/cassie /var/lib/cassie" ]
  - [ sh, -c, "${install}" ]
  - [ sh, -c, "ufw --force reset >/dev/null 2>&1; ufw default deny incoming; ufw default allow outgoing; ufw allow 22/tcp; ufw --force enable" ]
  - [ systemctl, restart, systemd-journald ]
  - [ systemctl, restart, ssh ]
  - [ systemctl, daemon-reload ]
  - [ sh, -c, "install -d -m 0750 -o cassie -g cassie /var/lib/cassie && touch ${READY_MARKER} && chown cassie:cassie ${READY_MARKER}" ]
`;
}
