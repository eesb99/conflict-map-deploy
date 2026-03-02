# OSINT Dashboard - Progress

## Phase Overview

| Phase | Status | Date | Progress |
|-------|--------|------|----------|
| Phase 1: Static Dashboard | Complete | 2026-03-02 | 100% |
| Phase 2: Supabase Realtime | Complete | 2026-03-03 | 100% |
| Phase 3: Mac Mini Polling | Complete | 2026-03-03 | 100% |
| Phase 4: GDELT Bug Fix + Filters | Complete | 2026-03-03 | 100% |
| Phase 5: Startup Fetch | Complete | 2026-03-03 | 100% |

## Phase 1: Static Dashboard (2026-03-02) - COMPLETE

**Commits:** `9c2d282` - Initial commit
**Files:** index.html, style.css, countries-50m.json

- 3D globe with Three.js + TopoJSON
- 50 hardcoded conflict events (Feb 28 - Mar 2, 2026)
- Timeline filter, category filter, canvas charts
- Mobile responsive with tab toggle

## Phase 2: Supabase Realtime (2026-03-03) - COMPLETE

**Commits:** `fec68b0` - feat: add Supabase Realtime integration
**Duration:** ~2 hours

### Features
- Supabase edge function `poll-gdelt` (fetches/filters/inserts GDELT data)
- Frontend WebSocket subscription to `osint_events` table
- Live globe markers + strike list + connection status indicator
- RLS policies (anon read, service role write)
- Database migrations for osint_events table

### Files Created
- `supabase/functions/poll-gdelt/index.ts` - Edge function (291 lines)
- `supabase/migrations/` - 3 migration files
- `supabase/schema.sql` - Table schema
- `.gitignore`, `CLAUDE.md`

## Phase 3: Mac Mini Polling (2026-03-03) - COMPLETE

**Duration:** ~30 min

### Setup
- launchd agent on Mac Mini: `com.osint.poll-gdelt`
- Schedule: StartCalendarInterval at :00, :15, :30, :45
- Script: `/Users/thianseongyee/scripts/osint/poll-gdelt.sh`
- Log: `/Users/thianseongyee/scripts/osint/poll-gdelt.log`

### Validation
- Manual trigger: confirmed (fetched:1729, filtered:0, inserted:0)
- launchctl start: confirmed working
- Agent loaded and scheduled

## Phase 4: GDELT Bug Fix + Filters (2026-03-03) - COMPLETE

**Commits:** `41ed719` - fix: correct GDELT column indices
**Duration:** ~15 min

### Bug
- GDELT column 28 = EventRootCode, not QuadClass
- Filter checked root code === 4 ("Make Statement") instead of quad class === 4 (Material Conflict)
- Result: zero events ever passed through

### Fix
- Corrected: QuadClass=29, Goldstein=30, NumMentions=31, AvgTone=34
- Added EVENT_ROOT_CODE=28 for direct access

### Filter Tightening
- Added NumMentions >= 3 (multi-source corroboration)
- Added known Actor1 required (no "Unknown" actors)
- Added actor pair + location dedup (keeps highest-mention version)
- Result: 116 events/cycle -> 21 events/cycle (~80% noise reduction)

## Phase 5: Startup Fetch (2026-03-03) - COMPLETE

**Commits:** `04ee42e` - feat: load existing GDELT events on page startup
**Duration:** ~10 min

- Frontend fetches up to 500 existing events from Supabase on page load
- Extracted shared `rowToEvent()` function for Realtime + startup fetch
- Existing GDELT events now visible immediately, not just live inserts

## Metrics

- Total commits: 5
- Total files: 19 tracked
- Edge functions: 1 (poll-gdelt)
- External services: Supabase, GDELT, Vercel
- Infrastructure: Mac Mini (launchd cron)
- DB events: 137 (116 noisy + 21 clean -- pending cleanup)
