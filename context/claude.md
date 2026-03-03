# OSINT Intelligence Dashboard - Session Context

## Current State

- **Branch**: main
- **Deployment**: Vercel (auto-deploy from main)
- **Backend**: Supabase (edge function v3 + Realtime + Postgres)
- **Polling**: Mac Mini launchd agent, every 15 min at :00/:15/:30/:45
- **DB**: 208 high-quality GDELT events in osint_events (cleaned from 2,096)
- **Status**: Pipeline operational with strict v3 filters (~5-7 events/poll)

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
  -> curl POST to Supabase edge function (poll-gdelt v3)
    -> Fetches GDELT CSV export (~1300-1700 global events)
    -> Filters (v3):
       ME countries + quad_class=4 + CAMEO 18/19/20
       + 5+ mentions + Goldstein <= -7 + tone < -3
       + both actors required + no fake actors
       + no centroid coords + no capital-default coords
    -> Dedup by actor pair + location (keeps highest-mention version)
    -> Sort by mentions desc, cap at 15 per poll
    -> DB dedup by source_url + global_event_id
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
- [x] Delete 116 noisy first-batch events (already done prior session)
- [x] Retroactive cleanup: 2,096 -> 535 (v2 filter criteria) -> 208 (actor audit + Tehran defaults)

### Next Steps
- [ ] Add ACLED as secondary source for verification
- [ ] Add log rotation for poll-gdelt.log
- [ ] Monitor v3 filters for a few days to validate signal quality

## Session 2 Summary (2026-03-03)

### Goals
- Implement v2 filter tightening plan (6 changes to poll-gdelt edge function)
- Clean up noisy historical events in Supabase DB
- Audit remaining events for ME conflict relevance
- Deploy v3 filters with actor validation

### Decisions Made
- **MIN_MENTIONS 3->5**: 3-mention events are often single-source with reposts; 5+ indicates genuine multi-outlet coverage
- **Goldstein <= -7**: Only severe negative events (-10 to +10 scale); above -7 includes mild actions like sanctions threats
- **AvgTone < -3**: Neutral/positive articles mentioning conflict actors are diplomatic/analytical, not incident reports
- **Capital-default coord filter**: GDELT defaults Iran-related articles to Tehran (35.75, 51.51) even when incident is elsewhere; same for Riyadh and Amman
- **Fake actor blocklist**: GDELT misparses newspaper bylines (NEW YORK, WASHINGTON), city datelines (LONDON), and humanitarian orgs (RED CRESCENT) as combatants
- **Require both actors**: Events with unknown/missing actor2 are too ambiguous for the dashboard
- **15 event cap per poll**: Prioritizes highest-mention events; cap didn't engage in practice (6-7 < 15)

### Implementation

**Edge function changes (3 deployments):**
1. v2: MIN_MENTIONS=5, Goldstein<=-7, tone<-3, centroid skip, global_event_id dedup, 15/poll cap
2. v3: Added fake actor blocklist, actor2 required, capital-default coord filter

**DB cleanup (via REST API with service role key):**
1. First-batch 116 events: already deleted (prior session)
2. v2 noise removal: 2,096 -> 535 (deleted 1,561 centroid/low-mention/neutral-tone events)
3. Actor audit: 535 -> 208 (deleted 327 fake-actor + Tehran-default events)

### Filter Evolution
| Version | Events/poll | Filters added |
|---------|-------------|---------------|
| v1 | ~30 | quad_class=4, CAMEO 18/19/20, 3+ mentions, known actor1 |
| v2 | ~6 | 5+ mentions, Goldstein<=-7, tone<-3, centroid skip, event_id dedup, 15 cap |
| v3 | ~3-5 (est.) | Fake actor blocklist, actor2 required, capital-default coords |

### Challenges & Solutions
1. **No `supabase db execute` for remote SQL**: Used REST API with service role key for batch DELETE operations
2. **System Python SSL cert error**: Used Homebrew Python (`/opt/homebrew/bin/python3`) for scripts
3. **REST API 1000-row limit**: Paginated fetches (3 batches) for full dataset analysis
4. **GDELT actor misattribution**: Newspaper bylines parsed as combatants -- added blocklist of known fake actors
5. **Tehran coordinate overconcentration**: 47% of events at Tehran default coords (35.75, 51.51) -- added capital-default filter

### Learnings
- GDELT's biggest noise source is centroid/capital-default geolocation (58% of events)
- Actor parsing is GDELT's second-worst problem: NEW YORK Times, WASHINGTON Post bylines become "combatants"
- Supabase REST API `.in()` on JSONB fields requires `->>` (text extraction), not `->` (JSON extraction)
- Retroactive cleanup was 10x more impactful than filter tightening alone (2,096 -> 208 vs new events ~6/poll -> ~5/poll)
