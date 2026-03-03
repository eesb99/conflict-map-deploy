import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { unzipSync } from "https://esm.sh/fflate@0.8.2";

// ====== CONFIGURATION ======

// GDELT raw event export: updated every 15 minutes, served from reliable CDN
const GDELT_LASTUPDATE = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt";

// FIPS country codes for Middle East region
const ME_COUNTRIES = new Set([
  "IR", // Iran
  "IS", // Israel
  "LE", // Lebanon
  "SY", // Syria
  "YM", // Yemen
  "IZ", // Iraq
  "JO", // Jordan
  "SA", // Saudi Arabia
  "GZ", // Gaza Strip
  "WE", // West Bank
]);

// GDELT Events CSV column indices (tab-separated, 0-indexed)
const COL = {
  GLOBAL_EVENT_ID: 0,
  SQLDATE:         1,
  ACTOR1_NAME:     6,
  ACTOR1_COUNTRY:  7,
  ACTOR2_NAME:    16,
  ACTOR2_COUNTRY: 17,
  EVENT_CODE:     26,
  EVENT_ROOT_CODE: 28,
  QUAD_CLASS:     29,   // 1=Verbal Coop, 2=Material Coop, 3=Verbal Conflict, 4=Material Conflict
  GOLDSTEIN:      30,   // -10 to +10
  NUM_MENTIONS:   31,
  AVG_TONE:       34,
  ACTION_GEO_FULLNAME: 52,
  ACTION_GEO_COUNTRY:  53,
  ACTION_GEO_LAT:      56,
  ACTION_GEO_LONG:     57,
  SOURCE_URL:     60,
};

// ====== CATEGORY CLASSIFICATION ======

// Classify based on actor names and geo location
function classify(row: string[]): { category: string; color: string } {
  const actor1 = (row[COL.ACTOR1_NAME] || "").toLowerCase();
  const actor2 = (row[COL.ACTOR2_NAME] || "").toLowerCase();
  const actor1Country = row[COL.ACTOR1_COUNTRY] || "";
  const actor2Country = row[COL.ACTOR2_COUNTRY] || "";
  const geoCountry = row[COL.ACTION_GEO_COUNTRY] || "";
  const combined = `${actor1} ${actor2}`;

  // Hezbollah (check first -- more specific)
  if (/hezbollah|hezballah|hizbollah/.test(combined)) {
    return { category: "hezbollah", color: "#f59e0b" };
  }

  // US-Israel actions
  if (
    actor1Country === "IS" || actor1Country === "US" ||
    /\bisrael|idf|united states|pentagon|centcom\b/.test(combined)
  ) {
    return { category: "us-israel", color: "#ef4444" };
  }

  // Iran
  if (
    actor1Country === "IR" || actor2Country === "IR" ||
    geoCountry === "IR" || /\biran|irgc\b/.test(combined)
  ) {
    return { category: "iran", color: "#06b6d4" };
  }

  // Lebanon strikes
  if (geoCountry === "LE" || /\blebanon|beirut\b/.test(combined)) {
    return { category: "lebanon-strike", color: "#eab308" };
  }

  return { category: "other", color: "#a0a0b8" };
}

// Build a readable event name from GDELT row
function buildEventName(row: string[]): string {
  const actor1 = row[COL.ACTOR1_NAME] || "Unknown";
  const actor2 = row[COL.ACTOR2_NAME] || "Unknown";
  const geo = row[COL.ACTION_GEO_FULLNAME] || "Unknown Location";
  const eventCode = row[COL.EVENT_CODE] || "";

  // Map common CAMEO root codes to readable verbs
  const verbs: Record<string, string> = {
    "14": "protests against",
    "17": "coerces",
    "18": "assaults",
    "19": "fights with",
    "20": "uses force against",
    "190": "uses conventional force against",
    "194": "fights with",
    "195": "employs aerial weapons against",
  };
  const rootCode = eventCode.slice(0, 3);
  const verb = verbs[rootCode] || verbs[eventCode.slice(0, 2)] || "conflict with";

  return `${actor1} ${verb} ${actor2} near ${geo}`.slice(0, 200);
}

// ====== LLM SEMANTIC DEDUP ======

interface LLMCluster {
  name: string;
  description: string;
  lat: number;
  lon: number;
  total_mentions: number;
  cluster_indices: number[];
}

async function deduplicateWithLLM(rows: string[][]): Promise<LLMCluster[] | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.log("LLM dedup: ANTHROPIC_API_KEY not set, skipping");
    return null;
  }

  // Build compact event summaries for the LLM
  const events = rows.map((row, i) => ({
    i,
    actor1: row[COL.ACTOR1_NAME] || "",
    actor2: row[COL.ACTOR2_NAME] || "",
    code: row[COL.EVENT_CODE] || "",
    location: row[COL.ACTION_GEO_FULLNAME] || "",
    lat: parseFloat(row[COL.ACTION_GEO_LAT]),
    lon: parseFloat(row[COL.ACTION_GEO_LONG]),
    mentions: parseInt(row[COL.NUM_MENTIONS]) || 0,
    goldstein: parseFloat(row[COL.GOLDSTEIN]) || 0,
  }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: `You are a conflict event deduplication engine for GDELT Middle East monitoring.
Given an array of candidate events, cluster those describing the same real-world incident and return one entry per cluster.

Rules:
- Events with similar coordinates (<50km apart) and overlapping actors = same incident
- Normalize actor names: IRANIAN/IRAN/TEHERAN -> Iran, ISRAELI/ISRAEL -> Israel, etc.
- Write concise journalist-style "name" (max 80 chars)
- Write 1-sentence "description" with weapon type, target, context if inferrable
- Pick the most specific lat/lon from the cluster (avoid round numbers)
- Sum mentions across cluster members into "total_mentions"

Return ONLY a JSON array (no markdown, no explanation):
[{"name":"...","description":"...","lat":0,"lon":0,"total_mentions":0,"cluster_indices":[0,3]}]`,
      messages: [{ role: "user", content: JSON.stringify(events) }],
    }),
  });

  if (!res.ok) {
    console.error(`LLM dedup: Anthropic API returned ${res.status}`);
    return null;
  }

  const body = await res.json();
  const text = body.content?.[0]?.text || "";

  // Parse JSON, stripping any accidental markdown fencing
  const jsonStr = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
  const clusters: LLMCluster[] = JSON.parse(jsonStr);

  // Validate output
  const maxIdx = rows.length - 1;
  for (const c of clusters) {
    if (
      !Array.isArray(c.cluster_indices) ||
      c.cluster_indices.some((i) => i < 0 || i > maxIdx) ||
      !c.name || !c.description ||
      typeof c.lat !== "number" || typeof c.lon !== "number"
    ) {
      console.error("LLM dedup: invalid cluster in response, falling back");
      return null;
    }
  }

  return clusters;
}

// ====== MAIN HANDLER ======

serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Fetch latest export file URL from GDELT CDN
    console.log("Fetching GDELT lastupdate...");
    const updateRes = await fetch(GDELT_LASTUPDATE, {
      headers: { "User-Agent": "OSINT-Dashboard/1.0" },
    });
    if (!updateRes.ok) {
      throw new Error(`GDELT lastupdate returned ${updateRes.status}`);
    }
    const updateText = await updateRes.text();

    // Parse: "96616 hash http://data.gdeltproject.org/gdeltv2/TIMESTAMP.export.CSV.zip"
    const exportLine = updateText.split("\n").find((l) => l.includes(".export.CSV.zip"));
    if (!exportLine) {
      throw new Error("No export file found in lastupdate.txt");
    }
    const exportUrl = exportLine.trim().split(/\s+/).pop()!;
    console.log("Export URL:", exportUrl);

    // 2. Fetch and decompress the ZIP
    const zipRes = await fetch(exportUrl, {
      headers: { "User-Agent": "OSINT-Dashboard/1.0" },
    });
    if (!zipRes.ok) {
      throw new Error(`Export download returned ${zipRes.status}`);
    }
    const zipBuffer = new Uint8Array(await zipRes.arrayBuffer());
    const unzipped = unzipSync(zipBuffer);
    const csvFileName = Object.keys(unzipped)[0];
    const csvBytes = unzipped[csvFileName];
    const csvText = new TextDecoder().decode(csvBytes);

    // 3. Parse tab-separated CSV (no headers)
    const rows = csvText.split("\n")
      .map((line) => line.split("\t"))
      .filter((cols) => cols.length > 60);

    console.log(`Parsed ${rows.length} events from GDELT export`);

    // 4. Filter for Middle East military strike events only
    const STRIKE_CAMEO_ROOTS = new Set(["18", "19", "20"]); // assault, fight, mass violence
    const MIN_MENTIONS = 5; // require stronger multi-source corroboration (was 3)
    const MAX_EVENTS_PER_POLL = 15; // cap to prioritize highest-signal events

    // Country centroid coordinates (FIPS codes) -- events at these coords
    // have no real location precision and clutter the globe
    const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
      IR: [32.0, 53.0],
      IS: [31.5, 34.75],
      IZ: [33.0, 44.0],
      SY: [35.0, 38.0],
      YM: [15.5, 48.0],
      LE: [33.83, 35.83],
      JO: [31.0, 36.0],
      SA: [25.0, 45.0],
      GZ: [31.42, 34.35],
      WE: [31.95, 35.25],
    };

    const isCentroid = (geoCountry: string, lat: number, lon: number): boolean => {
      const c = COUNTRY_CENTROIDS[geoCountry];
      if (!c) return false;
      return Math.abs(lat - c[0]) < 0.5 && Math.abs(lon - c[1]) < 0.5;
    };

    // Fake actors: GDELT misparses newspaper bylines, city datelines,
    // and humanitarian orgs as conflict participants
    const FAKE_ACTORS = new Set([
      "NEW YORK", "WASHINGTON", "LONDON", "PARIS", "MOSCOW", "BEIJING",
      "EUROPE", "AFRICA", "ASIA", "AUSTRALIA", "CHINA", "CHINESE",
      "RUSSIA", "RUSSIAN", "INDIA", "INDIAN", "BRAZIL", "MEXICO",
      "SCHOOL", "HOSPITAL", "UNIVERSITY", "MEDIA", "PRESS",
      "RED CRESCENT", "RED CROSS",
    ]);

    // Capital-city default coordinates GDELT falls back to (e.g. Tehran 35.75,51.51)
    const CAPITAL_DEFAULTS: Array<[number, number]> = [
      [35.75, 51.5148],   // Tehran
      [24.6408, 46.7728], // Riyadh
      [31.9522, 35.2332], // Amman
    ];
    const isCapitalDefault = (lat: number, lon: number): boolean =>
      CAPITAL_DEFAULTS.some(([clat, clon]) => Math.abs(lat - clat) < 0.01 && Math.abs(lon - clon) < 0.01);

    const allMeConflict = rows.filter((cols) => {
      const geoCountry = cols[COL.ACTION_GEO_COUNTRY] || "";
      const quadClass = parseInt(cols[COL.QUAD_CLASS]) || 0;
      const rootCode = cols[COL.EVENT_ROOT_CODE] || "";
      const mentions = parseInt(cols[COL.NUM_MENTIONS]) || 0;
      const actor1 = (cols[COL.ACTOR1_NAME] || "").trim();
      const actor2 = (cols[COL.ACTOR2_NAME] || "").trim();
      const lat = parseFloat(cols[COL.ACTION_GEO_LAT]);
      const lon = parseFloat(cols[COL.ACTION_GEO_LONG]);
      const goldstein = parseFloat(cols[COL.GOLDSTEIN]) || 0;
      const tone = parseFloat(cols[COL.AVG_TONE]) || 0;

      return (
        ME_COUNTRIES.has(geoCountry) &&
        quadClass === 4 &&                   // Material Conflict only
        STRIKE_CAMEO_ROOTS.has(rootCode) &&  // Military action codes
        mentions >= MIN_MENTIONS &&          // Multi-source corroboration
        goldstein <= -7 &&                   // Severe negative events only (-10 to +10 scale)
        tone < -3 &&                         // Negatively-reported events (not diplomatic/analytical)
        actor1.length > 0 &&                 // Require known actor1
        actor2.length > 0 &&                 // Require known actor2
        !FAKE_ACTORS.has(actor1) &&          // Skip newspaper/city/humanitarian misparses
        !FAKE_ACTORS.has(actor2) &&
        !isNaN(lat) && !isNaN(lon) &&
        !isCentroid(geoCountry, lat, lon) && // Skip low-precision centroid coordinates
        !isCapitalDefault(lat, lon)          // Skip capital-city default fallback coords
      );
    });

    console.log(`Pre-dedup ME conflict events: ${allMeConflict.length}`);

    // 4b. Deduplicate by actor pair + geo location (keep highest-mention version)
    const dedupMap = new Map<string, string[]>();
    for (const cols of allMeConflict) {
      const actor1 = (cols[COL.ACTOR1_NAME] || "").toLowerCase().trim();
      const actor2 = (cols[COL.ACTOR2_NAME] || "").toLowerCase().trim();
      const geo = (cols[COL.ACTION_GEO_FULLNAME] || "").toLowerCase().trim();
      const key = `${actor1}|${actor2}|${geo}`;
      const existing = dedupMap.get(key);
      if (!existing || (parseInt(cols[COL.NUM_MENTIONS]) || 0) > (parseInt(existing[COL.NUM_MENTIONS]) || 0)) {
        dedupMap.set(key, cols);
      }
    }
    // Sort by mentions desc and cap at MAX_EVENTS_PER_POLL
    const meConflictSorted = Array.from(dedupMap.values()).sort((a, b) =>
      (parseInt(b[COL.NUM_MENTIONS]) || 0) - (parseInt(a[COL.NUM_MENTIONS]) || 0)
    );
    const meConflictRows = meConflictSorted.slice(0, MAX_EVENTS_PER_POLL);

    console.log(`Filtered to ${meConflictRows.length} ME conflict events (after dedup, capped at ${MAX_EVENTS_PER_POLL})`);

    if (meConflictRows.length === 0) {
      return new Response(
        JSON.stringify({ fetched: rows.length, filtered: 0, inserted: 0, skipped_dedup: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4c. LLM semantic dedup + enrichment
    let llmClusters: LLMCluster[] | null = null;
    try {
      llmClusters = await deduplicateWithLLM(meConflictRows);
      if (llmClusters) {
        console.log(`LLM dedup: ${meConflictRows.length} events -> ${llmClusters.length} clusters`);
      }
    } catch (err) {
      console.error("LLM dedup failed, falling back to raw events:", (err as Error).message);
    }

    // 5. Init Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 6. Batch dedup check by source_url AND global_event_id
    const sourceUrls = meConflictRows
      .map((r) => r[COL.SOURCE_URL])
      .filter(Boolean);
    const globalEventIds = meConflictRows
      .map((r) => r[COL.GLOBAL_EVENT_ID])
      .filter(Boolean);

    // Check source_url dedup in batches of 100 (Supabase .in() limit)
    const existingUrls = new Set<string>();
    for (let i = 0; i < sourceUrls.length; i += 100) {
      const batch = sourceUrls.slice(i, i + 100);
      const { data } = await supabase
        .from("osint_events")
        .select("source_url")
        .in("source_url", batch);
      for (const r of data ?? []) {
        existingUrls.add(r.source_url);
      }
    }

    // Check global_event_id dedup via raw_response JSONB (->> extracts as text)
    const existingEventIds = new Set<string>();
    for (let i = 0; i < globalEventIds.length; i += 100) {
      const batch = globalEventIds.slice(i, i + 100);
      const { data } = await supabase
        .from("osint_events")
        .select("raw_response->>global_event_id")
        .in("raw_response->>global_event_id", batch);
      for (const r of data ?? []) {
        const eid = (r as Record<string, unknown>)["global_event_id"];
        if (eid) existingEventIds.add(String(eid));
      }
    }

    // 7. Build event objects
    const newEvents = [];
    let skippedDedup = 0;

    if (llmClusters) {
      // -- LLM-enriched path: build from semantic clusters --
      for (const cluster of llmClusters) {
        const memberRows = cluster.cluster_indices.map((i) => meConflictRows[i]);

        // Skip cluster if any member already exists in DB
        const alreadyExists = memberRows.some((row) => {
          const url = row[COL.SOURCE_URL] || "";
          const globalId = row[COL.GLOBAL_EVENT_ID] || "";
          return (url && existingUrls.has(url)) || (globalId && existingEventIds.has(globalId));
        });
        if (alreadyExists) {
          skippedDedup++;
          continue;
        }

        const primaryRow = memberRows[0];
        const { category, color } = classify(primaryRow);
        const d = primaryRow[COL.SQLDATE] || "";
        const eventDate = d.length >= 8
          ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
          : new Date().toISOString().slice(0, 10);

        // Higher confidence for multi-source clusters
        const confidence = Math.min(0.95,
          0.4 + (memberRows.length * 0.05) + (Math.min(cluster.total_mentions, 20) / 40));

        // Best source URL from highest-mentions member
        const bestRow = memberRows.reduce((a, b) =>
          (parseInt(b[COL.NUM_MENTIONS]) || 0) > (parseInt(a[COL.NUM_MENTIONS]) || 0) ? b : a
        );

        newEvents.push({
          lat: cluster.lat,
          lon: cluster.lon,
          name: cluster.name,
          description: cluster.description,
          category,
          event_date: eventDate,
          source: "gdelt+llm",
          source_url: bestRow[COL.SOURCE_URL] || null,
          confidence: Math.round(confidence * 100) / 100,
          color,
          is_verified: false,
          raw_response: {
            cluster: cluster.cluster_indices.map((i) => ({
              global_event_id: meConflictRows[i][COL.GLOBAL_EVENT_ID],
              event_code: meConflictRows[i][COL.EVENT_CODE],
              actor1: meConflictRows[i][COL.ACTOR1_NAME],
              actor2: meConflictRows[i][COL.ACTOR2_NAME],
            })),
            llm_name: cluster.name,
            total_mentions: cluster.total_mentions,
          },
        });
      }
    } else {
      // -- Raw fallback path (no LLM) --
      for (const row of meConflictRows) {
        const url = row[COL.SOURCE_URL] || "";
        const globalId = row[COL.GLOBAL_EVENT_ID] || "";
        if ((url && existingUrls.has(url)) || (globalId && existingEventIds.has(globalId))) {
          skippedDedup++;
          continue;
        }

        const lat = parseFloat(row[COL.ACTION_GEO_LAT]);
        const lon = parseFloat(row[COL.ACTION_GEO_LONG]);
        const { category, color } = classify(row);

        const d = row[COL.SQLDATE] || "";
        const eventDate = d.length >= 8
          ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
          : new Date().toISOString().slice(0, 10);

        const goldstein = Math.abs(parseFloat(row[COL.GOLDSTEIN]) || 0);
        const mentions = parseInt(row[COL.NUM_MENTIONS]) || 1;
        const confidence = Math.min(0.95, 0.3 + (goldstein / 20) + (Math.min(mentions, 10) / 20));

        newEvents.push({
          lat,
          lon,
          name: buildEventName(row),
          description: `CAMEO ${row[COL.EVENT_CODE]} | ${row[COL.ACTION_GEO_FULLNAME]} | Goldstein: ${row[COL.GOLDSTEIN]} | Mentions: ${row[COL.NUM_MENTIONS]}`,
          category,
          event_date: eventDate,
          source: "gdelt",
          source_url: url || null,
          confidence: Math.round(confidence * 100) / 100,
          color,
          is_verified: false,
          raw_response: {
            global_event_id: row[COL.GLOBAL_EVENT_ID],
            event_code: row[COL.EVENT_CODE],
            quad_class: row[COL.QUAD_CLASS],
            goldstein: row[COL.GOLDSTEIN],
            avg_tone: row[COL.AVG_TONE],
            actor1: row[COL.ACTOR1_NAME],
            actor2: row[COL.ACTOR2_NAME],
          },
        });
      }
    }

    // 8. Batch insert (Supabase max ~1000 per insert)
    let insertedCount = 0;
    for (let i = 0; i < newEvents.length; i += 500) {
      const batch = newEvents.slice(i, i + 500);
      const { data, error } = await supabase
        .from("osint_events")
        .insert(batch)
        .select("id");
      if (error) throw error;
      insertedCount += data?.length ?? 0;
    }

    const result = {
      fetched: rows.length,
      filtered: meConflictRows.length,
      llm_clusters: llmClusters?.length ?? null,
      inserted: insertedCount,
      skipped_dedup: skippedDedup,
    };

    console.log("poll-gdelt result:", JSON.stringify(result));

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("poll-gdelt error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
