'use client'

import { useState, useEffect } from 'react'
import { SECOND_MS } from '@/lib/core/time-constants'

/** Whole seconds left until the deadline (0 when null or past).
 *
 *  Callers arm with an EPOCH (a fresh `Date.now() + N·s` per server
 *  response), so a re-arm is always a value change — the identity-keyed
 *  reset and the value-keyed interval both re-fire, even when two
 *  consecutive server answers carry the identical remaining seconds
 *  (the same-second 429 that used to dead-arm the countdown). A repeated
 *  past deadline correctly reads 0 forever. */
export function useCountdown(deadlineMs: number | null): number {
  const [remaining, setRemaining] = useState(() => secondsLeft(deadlineMs))
  const [prevDeadline, setPrevDeadline] = useState(deadlineMs)

  // Reset when the caller passes a new deadline — the React-endorsed
  // "adjust state when a prop changes" pattern, set during render instead of
  // inside an effect (react-hooks/set-state-in-effect).
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  if (prevDeadline !== deadlineMs) {
    setPrevDeadline(deadlineMs)
    setRemaining(secondsLeft(deadlineMs))
  }

  useEffect(() => {
    if (deadlineMs == null || deadlineMs <= Date.now()) return

    const interval = setInterval(() => {
      setRemaining(secondsLeft(deadlineMs))
      if (Date.now() >= deadlineMs) clearInterval(interval)
    }, SECOND_MS)

    return () => { clearInterval(interval) }
  }, [deadlineMs])

  return remaining
}

/** Whole seconds left, armed by a remaining-seconds VALUE (poll-fed).
 *
 *  Some sources deliver "N seconds remaining" as a polled value, not a
 *  discrete event (the limits poll's cooldownSeconds) — there is no event
 *  handler in which to stamp an epoch. This variant captures a fresh
 *  deadline whenever the VALUE changes, using the same render-time
 *  adjustment pattern as useCountdown, with the clock read through the
 *  same helper-wrapped idiom as secondsLeft. A repeated value while live
 *  keeps the original deadline (the server repeating the same remaining
 *  time is the same deadline — no restart churn).
 *
 *  Residual (documented, bounded): a poll repeating the IDENTICAL value
 *  after the local 0 is invisible to the value-keyed capture — bounded
 *  to ≤1 s by the server's Math.ceil, self-healing (the next submit is
 *  server-rejected with a fresh, honest cooldown) and re-armed by the
 *  next value change. */
export function useCountdownFromSeconds(seconds: number): number {
  const [arm, setArm] = useState(() => ({ value: seconds, deadline: armDeadline(seconds) }))
  if (arm.value !== seconds) {
    setArm({ value: seconds, deadline: armDeadline(seconds) })
  }
  return useCountdown(arm.deadline)
}

function secondsLeft(deadlineMs: number | null): number {
  return deadlineMs == null ? 0 : Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000))
}

function armDeadline(seconds: number): number | null {
  return seconds > 0 ? Date.now() + seconds * SECOND_MS : null
}
