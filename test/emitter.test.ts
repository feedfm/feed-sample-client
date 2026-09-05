import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/player/emitter.js';

type Events = { ping: (n: number) => void; pong: () => void };

describe('Emitter', () => {
  it('calls every handler registered for an event', () => {
    const emitter = new Emitter<Events>();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('ping', a);
    emitter.on('ping', b);

    emitter.emit('ping', 42);

    expect(a).toHaveBeenCalledWith(42);
    expect(b).toHaveBeenCalledWith(42);
  });

  it('does not call handlers for other events', () => {
    const emitter = new Emitter<Events>();
    const handler = vi.fn();
    emitter.on('pong', handler);

    emitter.emit('ping', 1);

    expect(handler).not.toHaveBeenCalled();
  });

  it('removes a handler with off', () => {
    const emitter = new Emitter<Events>();
    const handler = vi.fn();
    emitter.on('ping', handler);
    emitter.off('ping', handler);

    emitter.emit('ping', 1);

    expect(handler).not.toHaveBeenCalled();
  });

  it('is a no-op when emitting with no handlers', () => {
    expect(() => new Emitter<Events>().emit('ping', 1)).not.toThrow();
  });

  // One badly behaved consumer must not stop the player notifying the others.
  it('keeps calling later handlers when an earlier one throws', () => {
    const emitter = new Emitter<Events>();
    const later = vi.fn();
    emitter.on('ping', () => { throw new Error('consumer bug'); });
    emitter.on('ping', later);

    expect(() => emitter.emit('ping', 1)).not.toThrow();
    expect(later).toHaveBeenCalledWith(1);
  });

  it('tolerates a handler removing itself during emit', () => {
    const emitter = new Emitter<Events>();
    const once = vi.fn(() => emitter.off('ping', once));
    const after = vi.fn();
    emitter.on('ping', once);
    emitter.on('ping', after);

    emitter.emit('ping', 1);
    emitter.emit('ping', 2);

    expect(once).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(2);
  });
});
