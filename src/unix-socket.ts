import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { lstatSync, unlinkSync, type BigIntStats } from "node:fs";
import net from "node:net";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  sep,
} from "node:path";

const SOCKET_MODE = 0o600;
const PARENT_MODE = 0o700;
const PROBE_TIMEOUT_MS = 500;
const CLEANUP_SIGNALS: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  uid: bigint;
}

export interface UnixSocketBinding {
  socketPath: string;
  parentPath: string;
  parentIdentity: FileIdentity;
  socketIdentity: FileIdentity;
  backingPath: string;
  backingIdentity: FileIdentity;
}

export class UnixSocketPathError extends Error {
  constructor(
    message: string,
    public readonly socketPath: string,
    public readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UnixSocketPathError";
  }
}

interface ProcessCleanupState {
  bindings: Map<object, () => void>;
  signalHandlers: Map<NodeJS.Signals, () => void>;
  exitHandler: () => void;
  installed: boolean;
}

const PROCESS_CLEANUP_STATE = Symbol.for(
  "@sammorrowdrums/tool-cli.unix-socket-cleanup.v1",
);

/**
 * Bind a server to a securely published Unix socket path.
 *
 * Node removes its bind pathname when a server closes. The server therefore
 * binds to a private sibling and hard-links that socket inode to the requested
 * path. The private name remains reserved for Node's close-time cleanup, while
 * tool-cli verifies and unlinks only the public path.
 */
export async function bindUnixSocket(
  server: net.Server,
  socketPath: string,
): Promise<UnixSocketBinding> {
  try {
    return await bindUnixSocketInternal(server, socketPath);
  } catch (error) {
    throw wrapSocketError(error, socketPath);
  }
}

async function bindUnixSocketInternal(
  server: net.Server,
  socketPath: string,
): Promise<UnixSocketBinding> {
  const normalizedPath = await resolveUnixSocketPath(socketPath);
  const parentPath = dirname(normalizedPath);
  const parentIdentity = await ensureSecureParent(parentPath, normalizedPath);
  const backingPath = getBackingPath(normalizedPath);

  const publicEntry = await inspectExistingSocket(
    normalizedPath,
    normalizedPath,
    parentPath,
    parentIdentity,
  );
  const backingEntry = await inspectExistingSocket(
    backingPath,
    normalizedPath,
    parentPath,
    parentIdentity,
  );
  await removeStaleSocket(publicEntry, parentPath, parentIdentity);
  await removeStaleSocket(backingEntry, parentPath, parentIdentity);

  let listening = false;
  let publishedIdentity: FileIdentity | undefined;

  try {
    await listen(server, backingPath);
    listening = true;

    await assertParentUnchanged(parentPath, parentIdentity, normalizedPath);
    const boundStats = await lstatBigInt(backingPath);
    assertOwnedSocket(boundStats, backingPath, normalizedPath);
    const boundIdentity = identityOf(boundStats);

    await chmod(backingPath, SOCKET_MODE);
    const securedStats = await lstatBigInt(backingPath);
    assertSameEntry(securedStats, boundIdentity, backingPath, normalizedPath);
    if ((Number(securedStats.mode) & 0o777) !== SOCKET_MODE) {
      throw new UnixSocketPathError(
        `Unix socket permissions are not 0600: ${normalizedPath}`,
        normalizedPath,
        "EACCES",
      );
    }

    await link(backingPath, normalizedPath);
    const publishedStats = await lstatBigInt(normalizedPath);
    assertSameEntry(
      publishedStats,
      boundIdentity,
      normalizedPath,
      normalizedPath,
    );
    assertOwnedSocket(publishedStats, normalizedPath, normalizedPath);
    publishedIdentity = identityOf(publishedStats);

    return {
      socketPath: normalizedPath,
      parentPath,
      parentIdentity,
      socketIdentity: publishedIdentity,
      backingPath,
      backingIdentity: boundIdentity,
    };
  } catch (error) {
    if (publishedIdentity) {
      await tryUnlinkVerifiedSocket(
        normalizedPath,
        publishedIdentity,
        parentPath,
        parentIdentity,
      );
    }
    if (listening) {
      await closeServer(server);
    }
    throw error;
  }
}

/** Register a live socket for process-exit and signal cleanup. */
export function registerUnixSocketCleanup(binding: UnixSocketBinding): void {
  const state = getProcessCleanupState();
  state.bindings.set(binding, () => cleanupUnixSocketBindingSync(binding));
  if (state.installed) return;

  state.installed = true;
  process.once("exit", state.exitHandler);
  for (const signal of CLEANUP_SIGNALS) {
    const handler = () => handleCleanupSignal(state, signal);
    state.signalHandlers.set(signal, handler);
    process.prependListener(signal, handler);
  }
}

/** Remove a socket from process cleanup tracking. */
export function unregisterUnixSocketCleanup(binding: UnixSocketBinding): void {
  const state = getProcessCleanupState();
  state.bindings.delete(binding);
  if (state.bindings.size === 0) removeProcessCleanupHandlers(state);
}

/** Remove the public socket only when it is still the socket we published. */
export async function unpublishUnixSocket(
  binding: UnixSocketBinding,
): Promise<void> {
  try {
    await unlinkVerifiedSocket(
      binding.socketPath,
      binding.socketIdentity,
      binding.parentPath,
      binding.parentIdentity,
      binding.socketPath,
      true,
    );
  } catch (error) {
    throw wrapSocketError(error, binding.socketPath, "clean up");
  }
}

/** Remove Node's private bind path after a normal server close. */
export async function cleanupUnixSocketBacking(
  binding: UnixSocketBinding,
): Promise<void> {
  try {
    await unlinkVerifiedSocket(
      binding.backingPath,
      binding.backingIdentity,
      binding.parentPath,
      binding.parentIdentity,
      binding.socketPath,
      true,
    );
  } catch (error) {
    throw wrapSocketError(error, binding.socketPath, "clean up");
  }
}

async function resolveUnixSocketPath(socketPath: string): Promise<string> {
  const normalizedPath = validateRequestedUnixSocketPath(socketPath);
  let existingParent = dirname(normalizedPath);
  const missingComponents: string[] = [];

  while (!(await tryLstat(existingParent))) {
    const parent = dirname(existingParent);
    if (parent === existingParent) {
      throw new UnixSocketPathError(
        `Unable to resolve an existing Unix socket ancestor: ${socketPath}`,
        socketPath,
        "ENOENT",
      );
    }
    missingComponents.unshift(basename(existingParent));
    existingParent = parent;
  }

  const canonicalParent = join(
    await realpath(existingParent),
    ...missingComponents,
  );
  const canonicalPath = join(canonicalParent, basename(normalizedPath));
  const maximumBytes = process.platform === "darwin" ? 103 : 107;
  const backingPath = getBackingPath(canonicalPath);
  if (
    Buffer.byteLength(canonicalPath) > maximumBytes ||
    Buffer.byteLength(backingPath) > maximumBytes
  ) {
    throw new UnixSocketPathError(
      `Unix socket path is too long for this platform (maximum ${maximumBytes} bytes): ${socketPath}`,
      socketPath,
      "ENAMETOOLONG",
    );
  }

  return canonicalPath;
}

function validateRequestedUnixSocketPath(socketPath: string): string {
  if (process.platform === "win32") {
    throw new UnixSocketPathError(
      "Unix-domain sockets are not supported on Windows",
      socketPath,
      "ENOTSUP",
    );
  }
  if (!socketPath) {
    throw new UnixSocketPathError(
      "Unix socket path must be a non-empty absolute path",
      socketPath,
      "EINVAL",
    );
  }
  if (socketPath.includes("\0")) {
    throw new UnixSocketPathError(
      "Unix socket path must not contain a NUL byte",
      socketPath,
      "EINVAL",
    );
  }
  if (!isAbsolute(socketPath)) {
    throw new UnixSocketPathError(
      `Unix socket path must be absolute: ${socketPath}`,
      socketPath,
      "EINVAL",
    );
  }

  const normalizedPath = normalize(socketPath);
  if (normalizedPath !== socketPath) {
    throw new UnixSocketPathError(
      `Unix socket path must be normalized and must not contain traversal segments: ${socketPath}`,
      socketPath,
      "EINVAL",
    );
  }

  return normalizedPath;
}

async function ensureSecureParent(
  parentPath: string,
  socketPath: string,
): Promise<FileIdentity> {
  const uid = BigInt(currentUid(socketPath));
  const root = parse(parentPath).root;
  const components = relative(root, parentPath).split(sep).filter(Boolean);
  let current = root;

  for (const component of components) {
    current = join(current, component);
    let stats = await tryLstat(current);
    if (!stats) {
      let created = false;
      try {
        await mkdir(current, { mode: PARENT_MODE });
        created = true;
      } catch (error) {
        if (getErrorCode(error) !== "EEXIST") throw error;
      }
      stats = await lstatBigInt(current);
      if (stats.isSymbolicLink()) {
        throw new UnixSocketPathError(
          `Refusing Unix socket path with a symlinked parent component: ${current}`,
          socketPath,
          "ELOOP",
        );
      }
      if (!stats.isDirectory()) {
        throw new UnixSocketPathError(
          `Unix socket parent component is not a directory: ${current}`,
          socketPath,
          "ENOTDIR",
        );
      }
      if (created) {
        await chmod(current, PARENT_MODE);
        stats = await lstatBigInt(current);
      }
    }

    if (stats.isSymbolicLink()) {
      throw new UnixSocketPathError(
        `Refusing Unix socket path with a symlinked parent component: ${current}`,
        socketPath,
        "ELOOP",
      );
    }
    if (!stats.isDirectory()) {
      throw new UnixSocketPathError(
        `Unix socket parent component is not a directory: ${current}`,
        socketPath,
        "ENOTDIR",
      );
    }
    if (stats.uid !== uid && stats.uid !== 0n) {
      throw new UnixSocketPathError(
        `Refusing Unix socket path below an ancestor not owned by the current user or root: ${current}`,
        socketPath,
        "EACCES",
      );
    }
    const permissions = Number(stats.mode) & 0o7777;
    if ((permissions & 0o022) !== 0 && (permissions & 0o1000) === 0) {
      throw new UnixSocketPathError(
        `Refusing Unix socket path below a group- or world-writable directory without the sticky bit: ${current}`,
        socketPath,
        "EACCES",
      );
    }
  }

  const parentStats = await lstatBigInt(parentPath);
  if (parentStats.uid !== uid) {
    throw new UnixSocketPathError(
      `Unix socket parent directory is not owned by the current user: ${parentPath}`,
      socketPath,
      "EACCES",
    );
  }
  if ((Number(parentStats.mode) & 0o777) !== PARENT_MODE) {
    throw new UnixSocketPathError(
      `Unix socket parent directory must have permissions 0700: ${parentPath}`,
      socketPath,
      "EACCES",
    );
  }

  return identityOf(parentStats);
}

interface ExistingSocket {
  path: string;
  identity: FileIdentity;
}

async function inspectExistingSocket(
  path: string,
  socketPath: string,
  parentPath: string,
  parentIdentity: FileIdentity,
): Promise<ExistingSocket | undefined> {
  await assertParentUnchanged(parentPath, parentIdentity, socketPath);
  const stats = await tryLstat(path);
  if (!stats) return undefined;

  if (stats.isSymbolicLink()) {
    throw new UnixSocketPathError(
      `Refusing to replace a symlink at Unix socket path: ${path}`,
      socketPath,
      "ELOOP",
    );
  }
  assertOwnedSocket(stats, path, socketPath);

  const active = await probeSocket(path, socketPath);
  if (active) {
    throw new UnixSocketPathError(
      `Unix socket is already in use: ${path}`,
      socketPath,
      "EADDRINUSE",
    );
  }

  return { path, identity: identityOf(stats) };
}

async function removeStaleSocket(
  entry: ExistingSocket | undefined,
  parentPath: string,
  parentIdentity: FileIdentity,
): Promise<void> {
  if (!entry) return;
  await unlinkVerifiedSocket(
    entry.path,
    entry.identity,
    parentPath,
    parentIdentity,
    entry.path,
  );
}

async function probeSocket(path: string, socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection({ path });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new UnixSocketPathError(
            `Timed out while verifying existing Unix socket: ${path}`,
            socketPath,
            "ETIMEDOUT",
          ),
        ),
      );
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();

    socket.once("connect", () => finish(() => resolve(true)));
    socket.once("error", (error) => {
      const code = getErrorCode(error);
      if (code === "ECONNREFUSED" || code === "ENOENT") {
        finish(() => resolve(false));
      } else {
        finish(() => reject(wrapSocketError(error, socketPath)));
      }
    });
  });
}

async function listen(server: net.Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      path,
      readableAll: false,
      writableAll: false,
    });
  });
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function unlinkVerifiedSocket(
  path: string,
  expected: FileIdentity,
  parentPath: string,
  parentIdentity: FileIdentity,
  socketPath: string,
  missingParentIsSuccess = false,
): Promise<void> {
  const parentExists = await assertParentUnchanged(
    parentPath,
    parentIdentity,
    socketPath,
    missingParentIsSuccess,
  );
  if (!parentExists) return;
  const stats = await tryLstat(path);
  if (!stats) return;
  assertSameEntry(stats, expected, path, socketPath);
  assertOwnedSocket(stats, path, socketPath);
  await unlink(path);
}

async function tryUnlinkVerifiedSocket(
  path: string,
  expected: FileIdentity,
  parentPath: string,
  parentIdentity: FileIdentity,
): Promise<void> {
  try {
    await unlinkVerifiedSocket(
      path,
      expected,
      parentPath,
      parentIdentity,
      path,
    );
  } catch {
    // The original error remains the actionable startup failure.
  }
}

async function assertParentUnchanged(
  parentPath: string,
  expected: FileIdentity,
  socketPath: string,
  missingIsSuccess = false,
): Promise<boolean> {
  const stats = await tryLstat(parentPath);
  if (!stats) {
    if (missingIsSuccess) return false;
    throw new UnixSocketPathError(
      `Unix socket parent directory does not exist: ${parentPath}`,
      socketPath,
      "ENOENT",
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new UnixSocketPathError(
      `Unix socket parent directory changed during setup: ${parentPath}`,
      socketPath,
      "ESTALE",
    );
  }
  assertSameIdentity(stats, expected, parentPath, socketPath);
  return true;
}

function assertOwnedSocket(
  stats: BigIntStats,
  path: string,
  socketPath: string,
): void {
  if (!stats.isSocket()) {
    throw new UnixSocketPathError(
      `Refusing to replace a non-socket filesystem entry: ${path}`,
      socketPath,
      "EEXIST",
    );
  }
  if (stats.uid !== BigInt(currentUid(socketPath))) {
    throw new UnixSocketPathError(
      `Refusing Unix socket not owned by the current user: ${path}`,
      socketPath,
      "EACCES",
    );
  }
}

function assertSameEntry(
  stats: BigIntStats,
  expected: FileIdentity,
  path: string,
  socketPath: string,
): void {
  if (stats.isSymbolicLink()) {
    throw new UnixSocketPathError(
      `Refusing to remove a symlink at Unix socket path: ${path}`,
      socketPath,
      "ELOOP",
    );
  }
  assertSameIdentity(stats, expected, path, socketPath);
}

function assertSameIdentity(
  stats: BigIntStats,
  expected: FileIdentity,
  path: string,
  socketPath: string,
): void {
  if (
    stats.dev !== expected.dev ||
    stats.ino !== expected.ino ||
    stats.uid !== expected.uid
  ) {
    throw new UnixSocketPathError(
      `Unix socket path changed; refusing to remove it: ${path}`,
      socketPath,
      "ESTALE",
    );
  }
}

function identityOf(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, uid: stats.uid };
}

async function tryLstat(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstatBigInt(path);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function getBackingPath(socketPath: string): string {
  const hash = createHash("sha256")
    .update(socketPath)
    .digest("hex")
    .slice(0, 12);
  return join(dirname(socketPath), `.tc-${hash}`);
}

function currentUid(socketPath: string): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new UnixSocketPathError(
      "Unix socket ownership cannot be verified on this platform",
      socketPath,
      "ENOTSUP",
    );
  }
  return uid;
}

async function lstatBigInt(path: string): Promise<BigIntStats> {
  return lstat(path, { bigint: true });
}

function getProcessCleanupState(): ProcessCleanupState {
  const existing = Reflect.get(globalThis, PROCESS_CLEANUP_STATE) as
    ProcessCleanupState | undefined;
  if (existing) return existing;

  const state: ProcessCleanupState = {
    bindings: new Map(),
    signalHandlers: new Map(),
    exitHandler: () => {},
    installed: false,
  };
  state.exitHandler = () => cleanupAllSocketsSync(state);
  Reflect.set(globalThis, PROCESS_CLEANUP_STATE, state);
  return state;
}

function cleanupAllSocketsSync(state: ProcessCleanupState): void {
  for (const cleanup of state.bindings.values()) {
    cleanup();
  }
  state.bindings.clear();
}

function cleanupUnixSocketBindingSync(binding: UnixSocketBinding): void {
  unlinkVerifiedSocketSync(binding.socketPath, binding.socketIdentity, binding);
  unlinkVerifiedSocketSync(
    binding.backingPath,
    binding.backingIdentity,
    binding,
  );
}

function unlinkVerifiedSocketSync(
  path: string,
  expected: FileIdentity,
  binding: UnixSocketBinding,
): void {
  try {
    const parentStats = lstatSync(binding.parentPath, { bigint: true });
    if (
      parentStats.isSymbolicLink() ||
      !parentStats.isDirectory() ||
      parentStats.dev !== binding.parentIdentity.dev ||
      parentStats.ino !== binding.parentIdentity.ino ||
      parentStats.uid !== binding.parentIdentity.uid
    ) {
      return;
    }

    const socketStats = lstatSync(path, { bigint: true });
    if (
      socketStats.isSymbolicLink() ||
      !socketStats.isSocket() ||
      socketStats.dev !== expected.dev ||
      socketStats.ino !== expected.ino ||
      socketStats.uid !== expected.uid
    ) {
      return;
    }
    unlinkSync(path);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") return;
  }
}

function handleCleanupSignal(
  state: ProcessCleanupState,
  signal: NodeJS.Signals,
): void {
  if (process.listenerCount(signal) > 1) return;
  cleanupAllSocketsSync(state);
  removeProcessCleanupHandlers(state);
  process.kill(process.pid, signal);
}

function removeProcessCleanupHandlers(state: ProcessCleanupState): void {
  if (!state.installed) return;
  state.installed = false;
  process.removeListener("exit", state.exitHandler);
  for (const [signal, handler] of state.signalHandlers) {
    process.removeListener(signal, handler);
  }
  state.signalHandlers.clear();
}

function wrapSocketError(
  error: unknown,
  socketPath: string,
  operation = "bind",
): UnixSocketPathError {
  if (error instanceof UnixSocketPathError) return error;
  const code = getErrorCode(error);
  const detail = error instanceof Error ? error.message : String(error);
  return new UnixSocketPathError(
    `Failed to ${operation} Unix socket ${socketPath}: ${detail}`,
    socketPath,
    code,
    error instanceof Error ? { cause: error } : undefined,
  );
}

function getErrorCode(error: unknown): string | undefined {
  return error instanceof Error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}
