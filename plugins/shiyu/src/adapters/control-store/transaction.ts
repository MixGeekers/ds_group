/**
 * Adapted from Store.atomic / afterCommit in deepseek-ai/dsh-superagent-prototype
 * src/app/store.ts, commit 6337fc823ce20251c8de8085948165c81aaa701e, lines 134–161.
 * Local changes: explicit outer BEGIN IMMEDIATE; synchronous-only callbacks;
 * stack updates after successful SAVEPOINT; failure aggregation and connection
 * quarantine; notification failures cannot change an already committed result;
 * synchronous outer-transaction hooks for the same-database commit watermark.
 *
 * MIT License — Copyright (c) 2026 DeepSeek Harness Team
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { isAsyncFunction, isPromise } from 'node:util/types';

export interface TransactionConnection {
  exec(sql: string): void;
  readonly isTransaction: boolean;
}
type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;
type Phase = 'begin' | 'operation' | 'commit';
type Outcome = 'not_started' | 'rolled_back' | 'unknown';
interface Frame { name: string | null; notifications: (() => unknown)[] }

export class SynchronousTransactionRequired extends TypeError {
  constructor() { super('Transaction callbacks and commit notifications must be synchronous'); }
}
export class TransactionPoisonedError extends Error {
  constructor(cause: unknown) { super('Transaction connection is quarantined; close and reconcile before reopening', { cause }); }
}
export class TransactionFailure extends AggregateError {
  constructor(
    readonly phase: Phase,
    readonly outcome: Outcome,
    readonly poisoned: boolean,
    errors: unknown[],
  ) {
    super(errors, `Transaction ${phase} failed (${outcome}${poisoned ? '; connection quarantined' : ''})`, { cause: errors[0] });
  }
}
export class PostCommitNotificationFailure extends AggregateError {
  constructor(errors: unknown[], readonly committed = true) { super(errors, 'In-memory commit notifications failed', { cause: errors[0] }); }
}
export interface TransactionOptions {
  /** A synchronous diagnostic sink, never a durable dispatcher. Its failures are retained too. */
  onNotificationFailure?: (failure: PostCommitNotificationFailure) => void;
}
/** Trusted same-connection bookkeeping, never external I/O or a dispatcher. */
export interface TransactionHooks {
  afterBegin(): void;
  beforeCommit(): void;
}

function rejectThenable(value: unknown): void {
  // Check native Promises before reading their possibly overridden `then`.
  if (isPromise(value)) {
    void Promise.prototype.then.call(value, undefined, () => undefined);
    throw new SynchronousTransactionRequired();
  }
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') {
    // Consume rejection of an already-created native Promise, without invoking
    // an arbitrary thenable or pretending this cancels already-started I/O.
    throw new SynchronousTransactionRequired();
  }
}

/**
 * A single, exclusively owned SQLite connection in its existing WorkerThread.
 * Keep Engine and synchronous repositories on this same execution boundary.
 * All repository entry points must call assertUsable() before accessing the DB.
 *
 * Only bounded synchronous database/domain operations belong inside atomic().
 * Network, model, filesystem and device calls MUST stay outside: rejecting a
 * returned Promise cannot undo an async action the callback already started.
 * Durable effects are written in the transaction; afterCommit only wakes their
 * scanner. Neither this class nor its notification callbacks implement a queue.
 * Do not issue transaction SQL or expose the connection to other owners.
 */
export class SqliteTransactions {
  private readonly frames: Frame[] = [];
  private sequence = 0;
  private quarantined = false;
  private fault: unknown;
  private notificationFailure?: PostCommitNotificationFailure;
  private hooks?: TransactionHooks;
  private controlling = false;

  constructor(private readonly db: TransactionConnection, private readonly options: TransactionOptions = {}) {}
  /** Exact identity check for composing repositories and effect records on one connection. */
  owns(connection: TransactionConnection): boolean { return this.db === connection; }
  get depth(): number { return this.frames.length; }
  get poisoned(): boolean { return this.quarantined; }
  /** Only the connection authorizer uses this to reject foreign transaction SQL. */
  get controlsTransaction(): boolean { return this.controlling; }
  installHooks(hooks: TransactionHooks): void {
    this.assertUsable(); this.assertExpectedState(false);
    if (this.frames.length || this.hooks) throw new Error('Transaction hooks are already installed or a transaction is active');
    if (typeof hooks.afterBegin !== 'function' || typeof hooks.beforeCommit !== 'function'
      || isAsyncFunction(hooks.afterBegin) || isAsyncFunction(hooks.beforeCommit)) throw new SynchronousTransactionRequired();
    this.hooks = Object.freeze({ afterBegin: hooks.afterBegin, beforeCommit: hooks.beforeCommit });
  }
  /** Most recent notification failure, retained even when its diagnostic sink throws. */
  get lastNotificationFailure(): PostCommitNotificationFailure | undefined { return this.notificationFailure; }
  assertUsable(): void { if (this.quarantined) throw new TransactionPoisonedError(this.fault); }
  private poison(error: unknown): void { if (!this.quarantined) this.fault = error; this.quarantined = true; }
  private transactionState(): boolean {
    try { return this.db.isTransaction; }
    catch (error) { this.poison(error); throw error; }
  }
  private assertExpectedState(active: boolean): void {
    if (this.transactionState() !== active) {
      const error = new Error('SQLite transaction state changed outside its owner');
      this.poison(error); throw error;
    }
  }
  private control(sql: string): void {
    this.controlling = true;
    try { this.db.exec(sql); } finally { this.controlling = false; }
  }

  atomic<T>(operation: () => T & Synchronous<T>): T {
    this.assertUsable();
    this.assertExpectedState(this.frames.length > 0);
    // Native async callbacks can be rejected before their body gets any chance
    // to write. A sync callback returning a Promise is also rejected below.
    if (isAsyncFunction(operation)) throw new SynchronousTransactionRequired();
    const frame: Frame = { name: this.frames.length ? `shiyu_atomic_${++this.sequence}` : null, notifications: [] };
    try {
      this.control(frame.name ? `SAVEPOINT ${frame.name}` : 'BEGIN IMMEDIATE');
      this.assertExpectedState(true);
    } catch (error) {
      // A failed outer BEGIN with no open transaction has acquired no ownership
      // and is retryable by its caller. Failed nested control is quarantined.
      let active: boolean | undefined;
      const stateErrors: unknown[] = [];
      try { active = this.transactionState(); } catch (stateError) { stateErrors.push(stateError); }
      if (!frame.name && !this.quarantined && active === false) throw new TransactionFailure('begin', 'not_started', false, [error]);
      this.poison(error);
      const cleanup = frame.name || active === undefined ? { errors: stateErrors, outcome: 'unknown' as const } : this.rollback(frame);
      throw new TransactionFailure('begin', cleanup.outcome, true, [error, ...cleanup.errors]);
    }
    // Never advance nesting depth until SQLite successfully created the level.
    this.frames.push(frame);
    let phase: Phase = 'operation';
    let value: T;
    try {
      if (!frame.name && this.hooks) {
        try { rejectThenable(this.hooks.afterBegin()); } catch (error) { this.poison(error); throw error; }
      }
      value = operation();
      rejectThenable(value);
      // An inner failure may have been caught by domain code. Quarantine still
      // prevents this outer transaction from committing any subsequent writes.
      this.assertUsable();
      this.assertExpectedState(true);
      phase = 'commit';
      try {
        if (!frame.name && this.hooks) rejectThenable(this.hooks.beforeCommit());
        this.control(frame.name ? `RELEASE SAVEPOINT ${frame.name}` : 'COMMIT');
        this.assertExpectedState(frame.name !== null);
      } catch (error) { this.poison(error); throw error; }
    } catch (error) {
      const cleanup = this.rollback(frame);
      if (cleanup.errors.length || this.quarantined) throw new TransactionFailure(phase, cleanup.outcome, this.quarantined, [error, ...cleanup.errors]);
      throw error;
    } finally { this.frames.pop(); }

    const parent = this.frames.at(-1);
    if (parent) parent.notifications.push(...frame.notifications);
    else this.notify(frame.notifications);
    return value;
  }

  /** Register an in-memory wake-up; rollback discards it. Outside a transaction it runs now. */
  afterCommit<T>(notification: () => T & Synchronous<T>): void {
    this.assertUsable();
    this.assertExpectedState(this.frames.length > 0);
    const frame = this.frames.at(-1);
    if (frame) frame.notifications.push(notification);
    else this.notify([notification], false);
  }

  private rollback(frame: Frame): { errors: unknown[]; outcome: Outcome } {
    const errors: unknown[] = [];
    let active: boolean;
    try { active = this.transactionState(); }
    catch (error) { return { errors: [error], outcome: 'unknown' }; }
    if (!active) {
      const error = new Error('Cannot prove rollback: owned transaction is no longer active');
      this.poison(error);
      return { errors: [error], outcome: 'unknown' };
    }
    const statements = frame.name ? [`ROLLBACK TO SAVEPOINT ${frame.name}`, `RELEASE SAVEPOINT ${frame.name}`] : ['ROLLBACK'];
    for (const statement of statements) {
      try { this.control(statement); }
      catch (error) { errors.push(error); this.poison(error); }
    }
    try { this.assertExpectedState(frame.name !== null); }
    catch (error) { errors.push(error); }
    return { errors, outcome: errors.length ? 'unknown' : 'rolled_back' };
  }

  private notify(notifications: (() => unknown)[], committed = true): void {
    const errors: unknown[] = [];
    for (const notification of notifications) {
      try {
        if (isAsyncFunction(notification)) throw new SynchronousTransactionRequired();
        rejectThenable(notification());
      } catch (error) { errors.push(error); }
    }
    if (!errors.length) return;
    const failure = this.notificationFailure = new PostCommitNotificationFailure(errors, committed);
    try {
      const sink = this.options.onNotificationFailure;
      if (sink) {
        if (isAsyncFunction(sink)) throw new SynchronousTransactionRequired();
        rejectThenable(sink(failure));
      }
    } catch (error) { this.notificationFailure = new PostCommitNotificationFailure([...errors, error], committed); }
  }
}
