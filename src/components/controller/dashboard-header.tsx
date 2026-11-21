'use client'

import { Clock, Layers, LogOut, RefreshCw, ScrollText, User, Wallet } from 'lucide-react'
import type { OverviewResponse } from '@/lib/controller/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { XLogo } from '@/components/shared/x-logo'
import { formatIdrCompact } from '@/components/shared/format-idr'
import { cn } from '@/lib/core/utils'

// ============================================================
// dashboard-header.tsx — sticky aggregate header (PRD §11.1)
//
// Brand + aggregate chips (pending / instances up / revenue today /
// submitters), manual refresh, account menu (audit log, logout).
// Chips render as skeletons during the first fan-out; on mobile they
// collapse into one compact horizontally scrollable row.
// ============================================================

interface DashboardHeaderProps {
  data: OverviewResponse | null
  isRefreshing: boolean
  onRefresh: () => void
  onOpenAudit: () => void
  onLogout: () => void
}

interface ChipSpec {
  icon: typeof Clock
  label: string
  value: string
  /** amber = needs attention (pending > 0). */
  tone?: 'amber' | undefined
}

function buildChips(data: OverviewResponse): ChipSpec[] {
  const { aggregate } = data
  return [
    {
      icon: Clock,
      label: 'Menunggu',
      value: String(aggregate.totalPending),
      tone: aggregate.totalPending > 0 ? 'amber' : undefined,
    },
    {
      icon: Layers,
      label: 'Instance',
      value: `${aggregate.instancesUp}/${aggregate.instancesEnabled}`,
    },
    {
      icon: Wallet,
      label: 'Pendapatan hari ini',
      value: formatIdrCompact(aggregate.revenueTodayIdr),
    },
    {
      icon: User,
      label: 'Pengirim',
      value: String(aggregate.submitters),
    },
  ]
}

function AggregateChip({ chip, compact = false }: { chip: ChipSpec; compact?: boolean }) {
  return (
    // `relative` anchors the sr-only twin INSIDE the scroll container — an
    // unanchored absolutely-positioned sr-only escapes the row's overflow
    // clip and grows the page (the 360px overflow this fixed).
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1',
        compact ? 'text-xs' : 'text-sm',
        chip.tone === 'amber'
          ? 'border-cerah-amber-line bg-cerah-amber-soft text-cerah-amber-strong'
          : 'border-line bg-surface text-ink-2',
      )}
    >
      <chip.icon className={cn(compact ? 'size-3' : 'size-3.5', chip.tone === 'amber' && 'text-cerah-amber-strong')} aria-hidden />
      <span className="font-semibold [font-variant-numeric:tabular-nums] text-ink">{chip.value}</span>
      <span aria-hidden>{chip.label}</span>
      <span className="sr-only">{`${chip.label}: ${chip.value}`}</span>
    </span>
  )
}

function ChipSkeletonRow({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="cerah-skeleton h-7 w-24 shrink-0 rounded-full sm:w-28" aria-hidden />
      ))}
      <span className="sr-only">Memuat ringkasan…</span>
    </>
  )
}

export function DashboardHeader({ data, isRefreshing, onRefresh, onOpenAudit, onLogout }: DashboardHeaderProps) {
  const chips = data != null ? buildChips(data) : null

  return (
    // Glass surface — the admin-header legibility idiom: a sticky bar over
    // scrolling content needs the blur; nothing else in this panel blurs.
    <header className="sticky top-0 z-40 border-b border-line bg-white/[0.82] backdrop-blur-[14px]">
      <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        <div className="flex h-[60px] items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-surface">
              <XLogo className="size-4.5 text-ink" />
            </span>
            <div className="flex min-w-0 flex-col leading-[1.2]">
              <span className="text-[0.7rem] font-semibold tracking-[0.04em] text-ink-3">Tweetfess</span>
              <h1 className="truncate text-[1.05rem] font-bold tracking-[-0.01em] text-ink">Controller</h1>
            </div>
          </div>

          {/* Aggregate chips — desktop row, hidden while the first fan-out runs. */}
          <div className="hidden items-center gap-1.5 md:flex">
            {chips != null
              ? chips.map((chip) => <AggregateChip key={chip.label} chip={chip} />)
              : <ChipSkeletonRow count={4} />}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              onClick={onRefresh}
              disabled={isRefreshing}
              aria-label="Muat ulang data"
              className="size-11 rounded-full p-0 text-ink-3 hover:text-ink"
            >
              <RefreshCw className={cn('size-4', isRefreshing && 'animate-spin')} />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="size-11 rounded-full p-0 text-ink-3 hover:text-ink"
                  aria-label="Menu akun"
                >
                  <User className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => { onOpenAudit() }}>
                  <ScrollText />
                  Log Audit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => { onLogout() }}>
                  <LogOut />
                  Keluar
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Aggregate chips — mobile: one compact, swipeable row. `relative`
            makes the row the containing block for absolutely-positioned
            sr-only twins so they stay inside the overflow clip. */}
        <div
          className="relative flex items-center gap-1.5 overflow-x-auto pb-2 md:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="Ringkasan"
        >
          {chips != null
            ? chips.map((chip) => <AggregateChip key={chip.label} chip={chip} compact />)
            : <ChipSkeletonRow count={4} />}
        </div>
      </div>
    </header>
  )
}
