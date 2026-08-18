import { TransferActivityGate } from '../src/network/transferActivityGate';

describe('TransferActivityGate', () => {
  test('tracks unique incoming and outgoing transfer keys without double counting', () => {
    const gate = new TransferActivityGate();

    expect(gate.begin('out:file-1')).toBe(true);
    expect(gate.begin('out:file-1')).toBe(false);
    expect(gate.begin('in:file-1')).toBe(true);
    expect(gate.getActiveCount()).toBe(2);

    expect(gate.end('out:file-1')).toBeNull();
    expect(gate.getActiveCount()).toBe(1);
    expect(gate.end('out:file-1')).toBeNull();
    expect(gate.getActiveCount()).toBe(1);
  });

  test('defers terminal cleanup until the final active transfer ends', () => {
    const gate = new TransferActivityGate();
    const terminalTask = jest.fn();

    gate.begin('out:file-1');
    gate.begin('in:file-2');

    expect(gate.deferTerminal(terminalTask)).toBe(true);
    expect(gate.end('out:file-1')).toBeNull();
    expect(terminalTask).not.toHaveBeenCalled();

    const released = gate.end('in:file-2');
    expect(released).toBe(terminalTask);
    expect(gate.hasActiveTransfers()).toBe(false);
    expect(terminalTask).not.toHaveBeenCalled();

    released();
    expect(terminalTask).toHaveBeenCalledTimes(1);
  });

  test('retains only the first deferred terminal task and releases it once', () => {
    const gate = new TransferActivityGate();
    const first = jest.fn();
    const second = jest.fn();

    gate.begin('out:file-1');
    expect(gate.deferTerminal(first)).toBe(true);
    expect(gate.deferTerminal(second)).toBe(true);

    expect(gate.end('out:file-1')).toBe(first);
    expect(gate.end('out:file-1')).toBeNull();
    expect(second).not.toHaveBeenCalled();
  });

  test('does not defer when the data plane is already idle', () => {
    const gate = new TransferActivityGate();
    expect(gate.deferTerminal(jest.fn())).toBe(false);
  });

  test('reset clears both active transfer state and any deferred terminal task', () => {
    const gate = new TransferActivityGate();
    gate.begin('in:file-1');
    gate.deferTerminal(jest.fn());

    gate.reset();

    expect(gate.getActiveCount()).toBe(0);
    expect(gate.hasActiveTransfers()).toBe(false);
    expect(gate.end('in:file-1')).toBeNull();
  });
});
