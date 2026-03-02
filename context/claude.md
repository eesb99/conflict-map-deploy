# OSINT Intelligence Dashboard - Session Context

## Current State

- **Branch**: main (up to date with origin)
- **Deployment**: Vercel (auto-deploy from main)
- **Backend**: Supabase (edge function + Realtime + Postgres)
- **Polling**: Mac Mini launchd agent, every 15 min at :00/:15/:30/:45
- **DB**: 137 GDELT events in osint_events (116 noisy + 21 clean -- needs cleanup)
- **Status**: Pipeline operational, frontend loads existing + live events

## Session 1 Summary (2026-03-03)

### Goals
- Set up 24/7 GDELT polling on Mac Mini to trigger Supabase edge function
- Merge realtime feature branch to main and deploy
- Fix GDELT column index bug and tighten filters
- Add startup fetch so existing DB events show on page load

### Decisions Made
- **launchd over crontab**: macOS TCC blocks crontab; launchd is native and preferred
- **Absolute paths in script**: launchd runs without HOME or shell profile; `~` doesn't expand
- **StartCalendarInterval over StartInterval**: Fixed clock times (:00/:15/:30/:45) align with GDELT's 15-min update cycle
- **Anon key for trigger, service role for DB writes**: Edge function uses auto-injected SUPABASE_SERVICE_ROLE_KEY; Mac Mini only needs anon key to POST
- **Tightened GDELT filters**: 3+ mentions, known Actor1, actor+location dedup (116 -> 21 events per cycle)

### Implementation

**Mac Mini setup:**
- `~/scripts/osint/poll-gdelt.sh` - curl script calling Supabase edge function
- `~/Library/LaunchAgents/com.osint.poll-gdelt.plist` - launchd config (StartCalendarInterval)
- `~/scripts/osint/poll-gdelt.log` - timestamped JSON results

**Git:**
- Merged `feat/realtime-minimal` to `main` (fast-forward)
- Pushed to origin, Vercel auto-deployed

**Commits:**
- `fec68b0` - feat: add Supabase Realtime integration for live OSINT events
- `03ca3da` - docs: add session context for realtime + Mac Mini polling setup
- `41ed719` - fix: correct GDELT column indices for QuadClass, Goldstein, NumMentions
- `04ee42e` - feat: load existing GDELT events on page startup

### Data Pipeline
```
Mac Mini (launchd :00/:15/:30/:45)
  -> curl POST to Supabase edge function (poll-gdelt)
    -> Fetches GDELT CSV export (~1700 global events)
    -> Filters: ME countries + quad_class=4 + CAMEO 18/19/20 + 3+ mentions + known actor
    -> Dedup by actor pair + location (keeps highest-mention version)
    -> Inserts into osint_events table (service role key)
      -> Supabase Realtime pushes INSERT to open browsers
      -> Frontend startup fetch loads existing events from DB
```

### Bug Fixed: GDELT Column Indices
- Column 28 was `EventRootCode`, not `QuadClass` (off by one)
- Filter was checking root code === 4 ("Make Statement") instead of quad class === 4 (Material Conflict)
- Fixed: QuadClass=29, Goldstein=30, NumMentions=31, AvgTone=34

### Challenges & Solutions
1. **crontab blocked on macOS**: Switched to launchd (native macOS scheduler)
2. **Fish shell on Mac Mini**: Used `bash -c` wrappers for heredocs
3. **~ not expanding in launchd**: Rewrote script with absolute paths
4. **RLS blocks anon INSERT for test events**: Use Supabase Dashboard SQL Editor
5. **GDELT column indices off by 2**: Columns 27-28 (EventBaseCode, EventRootCode) were skipped in original mapping
6. **Noisy GDELT events**: Added 3+ mention threshold, known actor requirement, actor+location dedup
7. **Existing DB events not showing on page load**: Added startup fetch from Supabase

### Learnings
- GDELT updates every 15 min, free, no API key, but noisy (duplicates, false positives, centroid geolocation)
- GDELT column indices: EventRootCode=28, QuadClass=29, Goldstein=30, NumMentions=31 (0-indexed)
- For production intelligence: combine GDELT (speed) with ACLED (accuracy)
- launchd `StartCalendarInterval` fires at exact clock times; `StartInterval` drifts from load time
- Supabase edge functions auto-inject SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
- Supabase Realtime only pushes new INSERTs -- need explicit fetch for existing rows

### Pending Cleanup
- [ ] Delete 116 noisy GDELT events from first batch via Supabase SQL Editor:
      `DELETE FROM osint_events WHERE source = 'gdelt' AND created_at < '2026-03-02T17:54:00Z';`

### Next Steps
- [ ] Clean up noisy events from DB (see above)
- [ ] Add ACLED as secondary source for verification
- [ ] Add log rotation for poll-gdelt.log
- [ ] Consider adding NumMentions >= 5 if still too noisy
