/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/**
 * Whether the runtime supports `type=bind` mounts for individual files (vs.
 * only directories). Docker supports both; Apple Container (CONTAINER_RUNTIME_BIN
 * = "container") rejects file mounts with `Error: path '<file>' is not a
 * directory`. Callers gate per-file RO overlays on this so the spawn doesn't
 * abort outright on Apple Container — the surrounding directory mount still
 * provides the file content, just without RO enforcement on that single path.
 */
export function supportsFileMounts(): boolean {
  // Apple Container's CLI is `container`. Anything else (`docker`, `podman`)
  // is assumed Docker-compatible and supports file mounts.
  return CONTAINER_RUNTIME_BIN !== 'container';
}

/**
 * IP address containers use to reach the host machine.
 * Apple Container VMs use a bridge network (192.168.64.x); the host is at the gateway.
 * Detected from the bridge0 interface, falling back to 192.168.64.1.
 */
export const CONTAINER_HOST_GATEWAY = detectHostGateway();

function detectHostGateway(): string {
  // Apple Container on macOS: containers reach the host via the bridge network gateway
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'] || ifaces['bridge0'];
  if (bridge) {
    const ipv4 = bridge.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  // Fallback: Apple Container's default gateway
  return '192.168.64.1';
}

/**
 * Address the credential proxy binds to.
 * Must be set via CREDENTIAL_PROXY_HOST in .env — there is no safe default
 * for Apple Container because bridge100 only exists while containers run,
 * but the proxy must start before any container.
 * The /convert-to-apple-container skill sets this during setup.
 *
 * Check is deferred to first use via getProxyBindHost() so test files
 * and CLI tools that transitively import this module without that env
 * var set don't crash at import time.
 */
export const PROXY_BIND_HOST = process.env.CREDENTIAL_PROXY_HOST;

export function getProxyBindHost(): string {
  if (!PROXY_BIND_HOST) {
    throw new Error('CREDENTIAL_PROXY_HOST is not set in .env. Run /convert-to-apple-container to configure.');
  }
  return PROXY_BIND_HOST;
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
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
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch {
    log.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      log.info('Container runtime started');
    } catch (err) {
      log.error('Failed to start container runtime', { err });
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Container runtime failed to start                      ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without a container runtime. To fix:        ║');
      console.error('║  1. Ensure Apple Container is installed                        ║');
      console.error('║  2. Run: container system start                                ║');
      console.error('║  3. Restart NanoClaw                                           ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
      throw new Error('Container runtime is required but failed to start', {
        cause: err,
      });
    }
  }
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
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
