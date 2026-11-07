// One writer per plugin home. dsh Web and dsh Desktop share ~/.dsh, and each host keeps
// the team in memory and writes state.json whole, so two hosts at once would undo each
// other's changes. The first host to load takes `state.lock`; a second one only reads.
//
// The lock is a small JSON file (pid, host, a random token) whose mtime the holder bumps
// on a timer. Modified by DSCord: a live local PID keeps the lease even if its event
// loop pauses past `staleMs`; stealing it could run a task twice when it wakes.
// Remote hosts still use the heartbeat. The token, not the pid, decides ownership:
// a holder that finds another token has lost the lock.
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

export function homeLock(path, { staleMs = 60_000, beatMs = 15_000, host = hostname(), pid = process.pid, isAlive = pidAlive, now = Date.now } = {}) {
  const token = randomUUID()
  let timer

  // undefined: no lock file; null: a file that does not parse (being written right now).
  const read = () => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      return error?.code === 'ENOENT' ? undefined : null
    }
  }
  const age = () => {
    try { return now() - statSync(path).mtimeMs } catch { return Infinity }
  }
  const live = (holder) => {
    if (holder === undefined) return false
    if (holder === null) return age() < staleMs
    // Distinct runtimes in the same process are distinct writers too. Only this
    // lock's token, checked by owns(), may re-enter a claim.
    if (holder.host === host) return isAlive(holder.pid)
    return age() < staleMs
  }
  const owns = () => read()?.token === token

  const beat = () => {
    if (!owns()) {
      stop()
      return
    }
    const time = new Date(now())
    try { utimesSync(path, time, time) } catch {}
  }
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  // Take the lock if it is free or its holder is gone. Returns undefined when this
  // process holds it, else what the lock file says about the holder.
  function claim() {
    if (owns()) return undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeFileSync(path, JSON.stringify({ pid, host, token, since: now() }), { flag: 'wx' })
        stop()
        timer = setInterval(beat, beatMs)
        timer.unref?.()
        return undefined
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      const holder = read()
      if (live(holder)) return holder ?? {}
      const current = read()
      const unchanged = holder === null
        ? current === null
        : holder?.token !== undefined
          ? current?.token === holder.token
          : JSON.stringify(current) === JSON.stringify(holder)
      if (unchanged) {
        try { unlinkSync(path) } catch {}
      }
    }
    return read() ?? {}
  }

  function release() {
    stop()
    if (owns()) {
      try { unlinkSync(path) } catch {}
    }
  }

  return { claim, owns, release, read }
}
