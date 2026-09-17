/**
 * Forced teardown of a `@solana/web3.js` `Connection`'s RPC websocket.
 *
 * `removeOnLogsListener` does not release a `Connection`. The client reconnects
 * its socket implicitly whenever it closes with subscriptions still registered,
 * so against a dead endpoint it settles into an endless reconnect loop whose
 * timers and socket handles pin the event loop. The executor is a subprocess
 * whose lifetime is controlled by its standard-input owner: if it cannot exit
 * when stdin closes, the owner cannot reliably restart it.
 *
 * So teardown does three things in order: empty the subscription registry so
 * there is nothing to re-establish, stop the client's own reconnect timer and
 * heartbeat, then drop the socket.
 *
 * **This module reaches into `Connection` and `ws` internals**, which is a
 * deliberate liability: web3.js has no public API for any of it, and a version
 * bump can rename these fields without warning. Everything here therefore fails
 * open — each step is individually guarded, and if the internals are gone the
 * only cost is the reconnect loop this exists to prevent. `bridge.ts` exits
 * explicitly as the backstop that guarantees termination regardless.
 */

/** The `ws`/`Connection` internals teardown touches, in one place. */
export interface SocketLike {
  close(): void;
  terminate?(): void;
  reconnect_timer_id?: ReturnType<typeof setTimeout> | null;
  on?(event: 'open', listener: () => void): unknown;
  off?(event: 'open', listener: () => void): unknown;
  removeListener?(event: 'open', listener: () => void): unknown;
}

interface ConnectionInternals {
  _rpcWebSocket?: SocketLike & Record<string, unknown>;
  _rpcWebSocketHeartbeat?: ReturnType<typeof setInterval> | null;
  _rpcWebSocketIdleTimeout?: ReturnType<typeof setTimeout> | null;
  _subscriptionsByHash?: Record<string, unknown>;
  _subscriptionHashByClientSubscriptionId?: Record<string, unknown>;
  _subscriptionCallbacksByServerSubscriptionId?: Record<string, unknown>;
  _subscriptionStateChangeCallbacksByHash?: Record<string, unknown>;
}

/** The socket underlying a connection, or null when there is none yet. */
export function rpcSocket(connection: unknown): SocketLike | null {
  const socket = (connection as ConnectionInternals)._rpcWebSocket;
  return socket ?? null;
}

/** Subscribe to socket reconnects so a dropped stream can be replayed. */
export function onSocketOpen(connection: unknown, listener: () => void): void {
  const socket = rpcSocket(connection);
  try {
    socket?.on?.('open', listener);
  } catch {
    // A socket without an emitter simply never reports a reconnect.
  }
}

export function offSocketOpen(connection: unknown, listener: () => void): void {
  const socket = rpcSocket(connection);
  try {
    if (socket?.off) socket.off('open', listener);
    else socket?.removeListener?.('open', listener);
  } catch {
    // Already detached.
  }
}

/** Forget every subscription so an implicit close has nothing to reconnect. */
export function clearSubscriptions(connection: unknown): void {
  const internals = connection as ConnectionInternals;
  try {
    if (internals._subscriptionsByHash) internals._subscriptionsByHash = {};
    if (internals._subscriptionHashByClientSubscriptionId) {
      internals._subscriptionHashByClientSubscriptionId = {};
    }
    if (internals._subscriptionCallbacksByServerSubscriptionId) {
      internals._subscriptionCallbacksByServerSubscriptionId = {};
    }
    if (internals._subscriptionStateChangeCallbacksByHash) {
      internals._subscriptionStateChangeCallbacksByHash = {};
    }
  } catch {
    // Read-only internals: fall through to dropping the socket.
  }
}

/** Cancel the timers `Connection` arms per socket: heartbeat and idle close. */
export function clearConnectionTimers(connection: unknown): void {
  const internals = connection as ConnectionInternals;
  try {
    if (internals._rpcWebSocketHeartbeat) {
      clearInterval(internals._rpcWebSocketHeartbeat);
      internals._rpcWebSocketHeartbeat = null;
    }
    if (internals._rpcWebSocketIdleTimeout) {
      clearTimeout(internals._rpcWebSocketIdleTimeout);
      internals._rpcWebSocketIdleTimeout = null;
    }
  } catch {
    // Timer fields are gone or read-only; the socket drop still happens.
  }
}

/**
 * Drop the socket without letting it keep the process alive.
 *
 * `unref` on everything the transport holds is what actually permits exit: the
 * `ws` client re-arms its reconnect timer on every failed connect, and a socket
 * waiting on a peer pins the loop independently.
 */
export function dropSocket(socket: SocketLike): void {
  try {
    const timer = socket.reconnect_timer_id;
    if (timer) {
      clearTimeout(timer);
      socket.reconnect_timer_id = null;
    }
  } catch {
    // No reconnect timer to cancel.
  }
  try {
    const owned = socket as unknown as Record<string, unknown>;
    for (const value of Object.values(owned)) {
      const handle = value as Handle | null;
      if (handle && typeof handle === 'object' && typeof handle.unref === 'function') {
        handle.unref();
      }
    }
    // `close()` waits for the peer; `terminate()` drops it immediately, which
    // is correct when shutting down rather than handshaking.
    if (typeof socket.terminate === 'function') socket.terminate();
    else socket.close();
  } catch {
    // A socket already torn down by the client is fine.
  }
}

/** Full teardown: registry, timers, then socket. Never throws. */
export function forceDisconnect(connection: unknown): void {
  clearSubscriptions(connection);
  clearConnectionTimers(connection);
  const socket = rpcSocket(connection);
  if (socket) dropSocket(socket);
}

interface Handle {
  unref?: () => unknown;
}
