export class TransferActivityGate {
  constructor() {
    this.activeKeys = new Set();
    this.pendingTerminalTask = null;
  }

  begin(key) {
    if (!key) return false;
    const sizeBefore = this.activeKeys.size;
    this.activeKeys.add(key);
    return this.activeKeys.size > sizeBefore;
  }

  end(key) {
    if (key) this.activeKeys.delete(key);
    if (this.activeKeys.size > 0 || !this.pendingTerminalTask) return null;

    const task = this.pendingTerminalTask;
    this.pendingTerminalTask = null;
    return task;
  }

  hasActiveTransfers() {
    return this.activeKeys.size > 0;
  }

  getActiveCount() {
    return this.activeKeys.size;
  }

  deferTerminal(task) {
    if (typeof task !== 'function' || !this.hasActiveTransfers()) return false;
    if (!this.pendingTerminalTask) this.pendingTerminalTask = task;
    return true;
  }

  clearPendingTerminal() {
    this.pendingTerminalTask = null;
  }

  reset() {
    this.activeKeys.clear();
    this.pendingTerminalTask = null;
  }
}

export default TransferActivityGate;
