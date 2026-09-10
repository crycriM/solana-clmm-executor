import { describe, expect, it, vi } from 'vitest';
import {
  clearConnectionTimers,
  clearSubscriptions,
  dropSocket,
  forceDisconnect,
  offSocketOpen,
  onSocketOpen,
  rpcSocket,
  type SocketLike,
} from './socketTeardown.js';

function fakeConnection(socket?: Partial<SocketLike>): Record<string, unknown> {
  return {
    _rpcWebSocket: {
      close: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      reconnect_timer_id: null,
      ...socket,
    },
    _rpcWebSocketHeartbeat: null,
    _rpcWebSocketIdleTimeout: null,
    _subscriptionsByHash: { a: 1 },
    _subscriptionHashByClientSubscriptionId: { b: 2 },
    _subscriptionCallbacksByServerSubscriptionId: { c: 3 },
    _subscriptionStateChangeCallbacksByHash: { d: 4 },
  };
}

describe('rpc socket teardown', () => {
  it('finds the socket a Connection created for its subscriptions', () => {
    const connection = fakeConnection();
    expect(rpcSocket(connection)).toBe(connection._rpcWebSocket);
  });

  it('returns null when no socket exists yet', () => {
    expect(rpcSocket({})).toBeNull();
  });

  it('empties the subscription registry so an implicit close cannot reconnect', () => {
    const connection = fakeConnection();
    clearSubscriptions(connection);
    expect(connection._subscriptionsByHash).toEqual({});
    expect(connection._subscriptionHashByClientSubscriptionId).toEqual({});
    expect(connection._subscriptionCallbacksByServerSubscriptionId).toEqual({});
    expect(connection._subscriptionStateChangeCallbacksByHash).toEqual({});
  });

  it('clears the heartbeat and idle timers', () => {
    const connection = fakeConnection();
    const heartbeat = setInterval(() => undefined, 1000);
    const idle = setTimeout(() => undefined, 1000);
    connection._rpcWebSocketHeartbeat = heartbeat;
    connection._rpcWebSocketIdleTimeout = idle;
    clearConnectionTimers(connection);
    expect(connection._rpcWebSocketHeartbeat).toBeNull();
    expect(connection._rpcWebSocketIdleTimeout).toBeNull();
    clearInterval(heartbeat);
    clearTimeout(idle);
  });

  it('cancels the ws reconnect timer and terminates the socket', () => {
    const timer = setTimeout(() => undefined, 1000);
    const socket: SocketLike = {
      close: vi.fn(),
      terminate: vi.fn(),
      reconnect_timer_id: timer,
    };
    dropSocket(socket);
    expect(socket.reconnect_timer_id).toBeNull();
    // terminate over close: we are shutting down, not waiting on a peer.
    expect(socket.terminate).toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    clearTimeout(timer);
  });

  it('falls back to close when the client has no terminate', () => {
    const socket: SocketLike = { close: vi.fn() };
    dropSocket(socket);
    expect(socket.close).toHaveBeenCalled();
  });

  it('unrefs every handle the transport holds so the process can exit', () => {
    const unref = vi.fn();
    const socket: SocketLike = { close: vi.fn(), terminate: vi.fn() };
    Object.defineProperty(socket, 'transport', { value: { unref }, enumerable: true });
    dropSocket(socket);
    expect(unref).toHaveBeenCalled();
  });

  it('never throws on a socket that is already gone', () => {
    expect(() => dropSocket({ close: () => { throw new Error('EBADF'); } })).not.toThrow();
    // A connection with no socket at all must also be safe.
    expect(() => forceDisconnect({})).not.toThrow();
  });

  it('forceDisconnect clears the registry, timers, and socket in one call', () => {
    const connection = fakeConnection();
    forceDisconnect(connection);
    expect(connection._subscriptionsByHash).toEqual({});
    expect((connection._rpcWebSocket as SocketLike).terminate).toHaveBeenCalled();
  });

  it('attaches and detaches the reconnect listener', () => {
    const connection = fakeConnection();
    const listener = vi.fn();
    onSocketOpen(connection, listener);
    const socket = connection._rpcWebSocket as { on: unknown; off: unknown };
    expect(socket.on).toHaveBeenCalledWith('open', listener);
    offSocketOpen(connection, listener);
    expect(socket.off).toHaveBeenCalledWith('open', listener);
  });

  it('tolerates a socket without an emitter', () => {
    const connection = { _rpcWebSocket: { close: vi.fn() } };
    expect(() => onSocketOpen(connection, () => undefined)).not.toThrow();
    expect(() => offSocketOpen(connection, () => undefined)).not.toThrow();
  });
});
