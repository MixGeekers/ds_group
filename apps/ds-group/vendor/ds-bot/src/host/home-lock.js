// One writer per plugin home. dsh Web and dsh Desktop share ~/.dsh, and each host keeps
// the team in memory and writes state.json whole, so two hosts at once would undo each
// other's changes. The first host to load takes `state.lock`; a second one only reads.
//
// Modified by DSCord: a SQLite write transaction owns the cross-process lock.
// The JSON PID/host/token file remains compatible with older DS-Bot instances;
// stale-file inspection and removal happen only while holding that OS lock.
// Neither age nor a paused event loop can release the SQLite reservation.
import { randomUUID } from 'node:crypto'
import { closeSync, constants, linkSync, lstatSync, openSync, readFileSync, readSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const APPLICATION_ID = 0x4453434f
const invalidDatabase = path => Object.assign(new Error(`Unrecognized runtime lock database: ${path}`), { code: 'DSCORD_LOCK_DATABASE_INVALID' })

function reserveDatabase(path, token) {
  try { lstatSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // Publish a fully initialized DB with an atomic no-overwrite link. A crash
    // during initialization can leave only a private temporary file, never an
    // unidentifiable canonical lock or a stale reclamation guard.
    const temporary = `${path}.${token}.tmp`
    let owned = false, initialization
    try {
      const fd = openSync(temporary, 'wx', 0o600); owned = true; closeSync(fd)
      initialization = new DatabaseSync(temporary)
      initialization.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1`)
      initialization.close(); initialization = undefined
      try { linkSync(temporary, path) } catch (error) { if (error.code !== 'EEXIST') throw error }
    } finally {
      try { initialization?.close() } finally { if (owned) unlinkSync(temporary) }
    }
  }
  // An unknown pre-existing file is never opened for write, replaced or deleted.
  const info = lstatSync(path)
  if (!info.isFile()) throw invalidDatabase(path)
  const header = Buffer.alloc(100)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let length
  try { length = readSync(fd, header, 0, header.length, 0) } finally { closeSync(fd) }
  if (length !== 100 || header.toString('binary', 0, 16) !== 'SQLite format 3\0'
    || header.readUInt32BE(68) !== APPLICATION_ID || header.readUInt32BE(60) !== 1) throw invalidDatabase(path)
  const database = new DatabaseSync(path)
  try { database.exec('BEGIN IMMEDIATE'); return database }
  catch (error) { database.close(); throw error }
}

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
  let timer, database

  // undefined: no lock file; null: a file that does not parse (being written right now).
  const read = () => {
    try {
      if (!lstatSync(path).isFile()) return null
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
    if (holder === null) return true
    // Distinct runtimes in the same process are distinct writers too. Only this
    // lock's token, checked by owns(), may re-enter a claim.
    if (holder.host === host) return isAlive(holder.pid)
    return age() < staleMs
  }
  const recognized = holder => holder !== null && !Array.isArray(holder) && Number.isSafeInteger(holder?.pid) && holder.pid > 0
    && typeof holder.host === 'string' && holder.host.length > 0 && typeof holder.token === 'string' && holder.token.length > 0
    && Number.isFinite(holder.since)
  const description = holder => holder !== null && typeof holder === 'object' && !Array.isArray(holder) ? holder : {}
  const owns = () => database !== undefined && read()?.token === token
  const unreserve = () => {
    const held = database; database = undefined
    if (held === undefined) return
    try { held.exec('ROLLBACK') } finally { held.close() }
  }

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
  const publishPid = () => {
    const temporary = `${path}.${token}.tmp`
    let fd, owned = false
    try {
      fd = openSync(temporary, 'wx', 0o600); owned = true
      writeFileSync(fd, JSON.stringify({ pid, host, token, since: now() }))
      closeSync(fd); fd = undefined
      linkSync(temporary, path)
    } finally {
      try { if (fd !== undefined) closeSync(fd) } finally {
        // Only this claim creates this private path. A failed or partial write
        // must never publish an unreadable canonical PID record.
        if (owned) try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }
  }

  // Take the lock if it is free or its holder is gone. Returns undefined when this
  // process holds it, else what the lock file says about the holder.
  function claim() {
    if (owns()) return undefined
    try {
      stop(); unreserve()
      database = reserveDatabase(`${path}.sqlite`, token)
      for (let attempt = 0; attempt < 3; attempt++) {
        const holder = read()
        if (holder !== undefined) {
          if (!recognized(holder)) {
            unreserve(); return { ...description(holder), reason: 'unrecognized-legacy-lock' }
          }
          if (live(holder)) { unreserve(); return holder }
          // Current DSCord contenders cannot alter this file while this
          // transaction is held. Preserve a changed legacy/unknown record.
          if (read()?.token !== holder.token) continue
          unlinkSync(path)
        }
        try {
          publishPid()
          timer = setInterval(beat, beatMs); timer.unref?.()
          return undefined
        } catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      const holder = read() ?? {}; unreserve(); return holder
    } catch (error) {
      // A failed claim must retain neither its SQLite reservation nor its PID.
      try { if (database !== undefined && read()?.token === token) unlinkSync(path) } catch {}
      finally { stop(); unreserve() }
      return { ...description(read()), reason: 'runtime-lock-unavailable', error: error.code ?? error.message }
    }
  }

  function release() {
    stop()
    // Remove only our PID while still owning the OS reservation. A repeated
    // release cannot remove a successor's file after it acquires that lock.
    try { if (owns()) unlinkSync(path) } catch {}
    finally { unreserve() }
  }

  return { claim, owns, release, read }
}
