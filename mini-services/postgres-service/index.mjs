// ============================================================
// index.mjs — embedded PostgreSQL for the controller dev database
//
// Drives the @embedded-postgres/linux-x64 binaries directly
// (initdb / pg_ctl / postgres). The umbrella `embedded-postgres`
// package is NOT used on purpose: its initialise() hardcodes
// --lc-messages=en_US.UTF-8, a locale this container doesn't ship
// (only C / C.utf8 / POSIX) — initdb dies with code 1.
//
// Cluster: port 5432, superuser postgres/postgres (trust auth —
// DEV ONLY; production uses Supabase, docs/DEPLOYMENT.md),
// database `controller`. Data persists in ./pgdata (gitignored).
// pg_ctl daemonizes postgres, so the server survives this script
// being killed; the script stays alive to handle graceful stop.
// ============================================================

import { existsSync, openSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { initdb, pg_ctl, postgres } from '@embedded-postgres/linux-x64'

const here = dirname(fileURLToPath(import.meta.url))
const PGDATA = join(here, 'pgdata')
const LOGFILE = join(here, 'postgres.log')
const PORT = 5432
const USER = 'postgres'
const DATABASE = 'controller'

function log(msg) {
  console.log(`[postgres-service] ${msg}`)
}

function run(bin, args, opts = {}) {
  return spawnSync(bin, args, { encoding: 'utf8', ...opts })
}

/** Create the cluster (idempotent guard by caller). */
function initialiseCluster() {
  log(`initialising cluster at ${PGDATA}`)
  const res = run(initdb, [
    '--pgdata', PGDATA,
    '--username', USER,
    '--auth', 'trust',     // dev-only: local socket + localhost TCP
    '--no-locale',         // container ships only C/C.utf8/POSIX
  ])
  if (res.status !== 0) {
    log(`initdb failed (${res.status}):\n${res.stdout ?? ''}\n${res.stderr ?? ''}`)
    process.exit(1)
  }
}

/** Create the app database via single-user mode (no psql binary shipped). */
function createDatabase() {
  const res = run(postgres, ['--single', '-D', PGDATA, 'postgres'], {
    input: `CREATE DATABASE ${DATABASE};\n`,
  })
  if (res.status !== 0) {
    log(`create database failed (${res.status}):\n${res.stdout ?? ''}\n${res.stderr ?? ''}`)
    process.exit(1)
  }
}

function startCluster() {
  // -w: wait until the server accepts connections before returning.
  // The log fd is inherited so pg_ctl's own messages land there too.
  const logFd = openSync(LOGFILE, 'a')
  const res = run(pg_ctl, ['-D', PGDATA, '-w', '-l', LOGFILE, '-o', `-p ${PORT}`, 'start'], {
    stdio: ['ignore', 'inherit', 'inherit', logFd],
  })
  if (res.status !== 0) {
    log(`pg_ctl start failed (${res.status}) — see ${LOGFILE}`)
    process.exit(1)
  }
}

function stopCluster() {
  const res = run(pg_ctl, ['-D', PGDATA, '-m', 'fast', 'stop'])
  if (res.status === 0) {
    log('postgres stopped cleanly')
  } else {
    // 1 = not running — fine during shutdown races
    log(`pg_ctl stop exited ${res.status} (ok if already stopped)`)
  }
}

const fresh = !existsSync(join(PGDATA, 'PG_VERSION'))
if (fresh) {
  initialiseCluster()
  createDatabase()
}

startCluster()
log(`postgres up on :${PORT} (${fresh ? 'fresh cluster' : 'existing pgdata'})`)
log(`ready — postgresql://${USER}:***@localhost:${PORT}/${DATABASE}`)

// Stay alive as the service supervisor; shut postgres down politely
// on SIGTERM/SIGINT. If this script is killed hard, postgres simply
// keeps running (pg_ctl daemonized it) and recovers on next start.
let stopping = false
function shutdown(signal) {
  if (stopping) return
  stopping = true
  log(`${signal} — stopping postgres…`)
  stopCluster()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
setInterval(() => {}, 1 << 30)
