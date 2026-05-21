/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/**
 * The container runtime binary name.
 *
 * Defaults to `docker` (works with native Docker, Docker Desktop, Colima).
 * Override to `container` for Apple Container, `podman` for Podman, etc.
 * The runtime must accept the same `run / stop / ls --format json` surface
 * the rest of this module uses.
 */
export const CONTAINER_RUNTIME_BIN = process.env.CONTAINER_RUNTIME_BIN || 'docker';

/**
 * Whether the runtime supports `type=bind` mounts for individual files (vs.
 * only directories). Docker supports both; Apple Container rejects file
 * mounts with `Error: path '<file>' is not a directory`. Callers gate
 * per-file RO overlays on this so the spawn doesn't abort outright on
 * Apple Container — the surrounding directory mount still provides the
 * file content, just without RO enforcement on that single path.
 */
export function supportsFileMounts(): boolean {
  // Apple Container's CLI is `container`. Anything else (`docker`, `podman`)
  // is assumed Docker-compatible and supports file mounts.
  return CONTAINER_RUNTIME_BIN !== 'container';
}

/**
 * IP address containers use to reach the host machine. With Docker (incl.
 * Colima), `host.docker.internal` resolves to the host when the spawn
 * passes `--add-host=host.docker.internal:host-gateway`. With Apple
 * Container, host.docker.internal isn't injected; containers reach the
 * host via the bridge network gateway (192.168.64.1 typically).
 */
export const CONTAINER_HOST_GATEWAY = detectHostGateway();

function detectHostGateway(): string {
  if (CONTAINER_RUNTIME_BIN === 'container') {
    // Apple Container on macOS: containers reach the host via the bridge
    // network gateway. bridge100/bridge0 only exists while a VM is up;
    // fall back to the documented default.
    const ifaces = os.networkInterfaces();
    const bridge = ifaces['bridge100'] || ifaces['bridge0'];
    if (bridge) {
      const ipv4 = bridge.find((a) => a.family === 'IPv4');
      if (ipv4) return ipv4.address;
    }
    return '192.168.64.1';
  }
  // Docker / Colima / Podman: rely on the `--add-host=host.docker.internal:
  // host-gateway` arg that hostGatewayArgs() emits below. The literal
  // hostname resolves inside the container to the bridge gateway.
  return 'host.docker.internal';
}

/**
 * Address the credential proxy binds to.
 *
 * Docker / Colima can use `127.0.0.1` safely because the spawn passes
 * `--add-host=host.docker.internal:host-gateway`, so the container reaches
 * the proxy via the hostname rather than a host-side bind IP. For Apple
 * Container, the proxy must bind on an interface reachable from the
 * container's bridge network — typically `0.0.0.0` — and CREDENTIAL_PROXY_HOST
 * must be set in .env.
 *
 * Check is deferred to first use via getProxyBindHost() so test files
 * and CLI tools that transitively import this module without that env
 * var set don't crash at import time.
 */
export const PROXY_BIND_HOST = process.env.CREDENTIAL_PROXY_HOST;

export function getProxyBindHost(): string {
  if (PROXY_BIND_HOST) return PROXY_BIND_HOST;
  // Docker default: localhost is fine because hostGatewayArgs() routes the
  // container to it via host.docker.internal. Apple Container has no such
  // shortcut and requires an explicit bind host in .env.
  if (CONTAINER_RUNTIME_BIN === 'container') {
    throw new Error('CREDENTIAL_PROXY_HOST is not set in .env. Required for Apple Container.');
  }
  return '127.0.0.1';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  if (CONTAINER_RUNTIME_BIN === 'container') {
    // Apple Container has no host.docker.internal shortcut; containers
    // resolve the host via the bridge gateway directly (see
    // CONTAINER_HOST_GATEWAY). No extra args.
    return [];
  }
  // Docker / Colima / Podman: inject host.docker.internal → host bridge.
  // Native Docker Desktop already provides this on macOS/Windows, but
  // Colima and Linux Docker don't, so we add it unconditionally — Docker
  // tolerates the duplicate.
  return ['--add-host=host.docker.internal:host-gateway'];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['--mount', `type=bind,source=${hostPath},target=${containerPath},readonly`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  // Apple Container uses `system status` / `system start`. Docker uses
  // `info` for daemon health and has no in-CLI start command (the daemon
  // is started by the OS — Docker Desktop, Colima, dockerd, etc.). Pick
  // the right pair based on which binary we're calling.
  const isAppleContainer = CONTAINER_RUNTIME_BIN === 'container';
  const healthCheck = isAppleContainer
    ? `${CONTAINER_RUNTIME_BIN} system status`
    : `${CONTAINER_RUNTIME_BIN} info --format '{{.ServerVersion}}'`;

  try {
    execSync(healthCheck, { stdio: 'pipe', timeout: 10000 });
    log.debug('Container runtime already running');
    return;
  } catch (err) {
    // For Apple Container only: try to start the runtime in-band.
    if (isAppleContainer) {
      log.info('Starting container runtime...');
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
          stdio: 'pipe',
          timeout: 30000,
        });
        log.info('Container runtime started');
        return;
      } catch (startErr) {
        log.error('Failed to start container runtime', { err: startErr });
        printRuntimeFatal();
        throw new Error('Container runtime is required but failed to start', { cause: startErr });
      }
    }
    // Docker: no in-CLI start command. Surface a clear message and fail.
    log.error('Docker daemon not reachable', { err });
    printRuntimeFatal();
    throw new Error('Container runtime is required but failed to start', { cause: err });
  }
}

function printRuntimeFatal(): void {
  const isAppleContainer = CONTAINER_RUNTIME_BIN === 'container';
  console.error('\n╔════════════════════════════════════════════════════════════════╗');
  console.error('║  FATAL: Container runtime failed to start                      ║');
  console.error('║                                                                ║');
  if (isAppleContainer) {
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Apple Container is installed                        ║');
    console.error('║  2. Run: container system start                                ║');
    console.error('║  3. Restart NanoClaw                                           ║');
  } else {
    console.error('║  Agents cannot run without a Docker daemon. To fix:            ║');
    console.error('║  • Native Docker:    sudo systemctl start docker               ║');
    console.error('║  • Colima (macOS):   brew services start colima                ║');
    console.error('║  • Docker Desktop:   open Docker Desktop                       ║');
    console.error('║  Then restart NanoClaw.                                        ║');
  }
  console.error('╚════════════════════════════════════════════════════════════════╝\n');
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    if (CONTAINER_RUNTIME_BIN === 'container') {
      cleanupOrphansAppleContainer();
    } else {
      cleanupOrphansDocker();
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}

function cleanupOrphansDocker(): void {
  // Docker supports `--filter label=key=value` natively — use it. `-q` gives
  // us just IDs; status=running scopes to live containers only.
  const output = execSync(
    `${CONTAINER_RUNTIME_BIN} ps -q --filter status=running --filter label=${CONTAINER_INSTALL_LABEL}`,
    { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
  );
  const ids = output
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const id of ids) {
    try {
      stopContainer(id);
    } catch {
      /* already stopped */
    }
  }
  if (ids.length > 0) {
    log.info('Stopped orphaned containers', { count: ids.length, names: ids });
  }
}

function cleanupOrphansAppleContainer(): void {
  // Apple Container doesn't support `--filter label=` like Docker; we must
  // list everything as JSON and filter in-process. We still scope by this
  // install's label so peer installs on the same host aren't reaped.
  const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  const containers: {
    status: string;
    configuration: { id: string; labels?: Record<string, string> | string[] };
  }[] = JSON.parse(output || '[]');
  const orphans = containers
    .filter((c) => {
      if (c.status !== 'running') return false;
      if (!c.configuration.id.startsWith('nanoclaw-')) return false;
      // Match this install's label. Apple Container may serialize labels as
      // either a map (`{key: value}`) or as `key=value` strings — handle both.
      const labels = c.configuration.labels;
      if (!labels) return false;
      if (Array.isArray(labels)) return labels.includes(CONTAINER_INSTALL_LABEL);
      const [labelKey, labelValue] = CONTAINER_INSTALL_LABEL.split('=');
      return labels[labelKey] === labelValue;
    })
    .map((c) => c.configuration.id);
  for (const name of orphans) {
    try {
      stopContainer(name);
    } catch {
      /* already stopped */
    }
  }
  if (orphans.length > 0) {
    log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
  }
}
