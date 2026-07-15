/**
 * FORK: explicit host→container env passthrough.
 *
 * v2 deliberately does not dump the host .env into containers. Two narrow
 * exceptions this fork carries:
 *
 *  - Host browser service (the Mini): the host-browser container skill
 *    curls $HOST_BROWSER_URL with `X-Auth: $HOST_BROWSER_TOKEN` to read
 *    authed / bot-protected sites through real macOS Chrome. Fresh
 *    sessions need the token deterministically in env, not by luck of
 *    conversation context.
 *
 *  - CONTAINER_ENV_PASSTHROUGH: comma-separated var NAMES an install lists
 *    in its .env to forward (e.g. MS Graph client-credential vars that
 *    user-authored scheduled tasks reference). Names live only in the
 *    install's .env, never in shared code.
 */
export function hostEnvPassthroughArgs(): string[] {
  const args: string[] = [];
  const forward = ['HOST_BROWSER_URL', 'HOST_BROWSER_TOKEN'];
  forward.push(
    ...(process.env.CONTAINER_ENV_PASSTHROUGH || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const key of forward) {
    if (process.env[key]) args.push('-e', `${key}=${process.env[key]}`);
  }
  return args;
}
