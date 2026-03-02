# OSINT Intelligence Dashboard - Session Context

## Current State

- **Branch**: main (up to date with origin)
- **Deployment**: Vercel (auto-deploy from main)
- **Backend**: Supabase (edge function + Realtime + Postgres)
- **Polling**: Mac Mini launchd agent, every 15 min at :00/:15/:30/:45
- **Status**: Full pipeline operational, awaiting real GDELT conflict events

## Session 1 Summary (2026-03-03)

### Goals
- Set up 24/7 GDELT polling on Mac Mini to trigger Supabase edge function
- Merge realtime feature branch to main and deploy

### Decisions Made
- **launchd over crontab**: macOS TCC blocks crontab; launchd is native and preferred
- **Absolute paths in script**: launchd runs without HOME or shell profile; `~` doesn't expand
- **StartCalendarInterval over StartInterval**: Fixed clock times (:00/:15/:30/:45) align with GDELT's 15-min update cycle
- **Anon key for trigger, service role for DB writes**: Edge function uses auto-injected SUPABASE_SERVICE_ROLE_KEY; Mac Mini only needs anon key to POST

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

### Data Pipeline
```
Mac Mini (launchd :00/:15/:30/:45)
  -> curl POST to Supabase edge function (poll-gdelt)
    -> Fetches GDELT CSV export (~1700 global events)
    -> Filters: ME countries + quad_class=4 + CAMEO 18/19/20
    -> Inserts into osint_events table (service role key)
      -> Supabase Realtime pushes INSERT to browsers
        -> Vercel frontend adds globe marker + strike list entry
```

### Challenges & Solutions
1. **crontab blocked on macOS**: Switched to launchd (native macOS scheduler)
2. **Fish shell on Mac Mini**: Used `bash -c` wrappers for heredocs
3. **~ not expanding in launchd**: Rewrote script with absolute paths
4. **RLS blocks anon INSERT for test events**: Would need service role key or dashboard SQL editor

### Learnings
- GDELT updates every 15 min, free, no API key, but noisy (duplicates, false positives, centroid geolocation)
- For production intelligence: combine GDELT (speed) with ACLED (accuracy)
- launchd `StartCalendarInterval` fires at exact clock times; `StartInterval` drifts from load time
- Supabase edge functions auto-inject SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY

### Next Steps
- [ ] Monitor poll-gdelt.log for first real inserted events (filtered > 0)
- [ ] Consider loosening CAMEO filters if no events appear (add quad_class=3 verbal conflict)
- [ ] Add ACLED as secondary source for verification
- [ ] Test event insertion via Supabase dashboard SQL editor to verify Realtime end-to-end
- [ ] Add log rotation for poll-gdelt.log (will grow indefinitely)
