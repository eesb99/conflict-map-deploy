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
    const MIN_MENTIONS = 3; // filter out low-signal single-source events
    const allMeConflict = rows.filter((cols) => {
      const geoCountry = cols[COL.ACTION_GEO_COUNTRY] || "";
      const quadClass = parseInt(cols[COL.QUAD_CLASS]) || 0;
      const rootCode = cols[COL.EVENT_ROOT_CODE] || "";
      const mentions = parseInt(cols[COL.NUM_MENTIONS]) || 0;
      const actor1 = (cols[COL.ACTOR1_NAME] || "").trim();
      const lat = parseFloat(cols[COL.ACTION_GEO_LAT]);
      const lon = parseFloat(cols[COL.ACTION_GEO_LONG]);

      return (
        ME_COUNTRIES.has(geoCountry) &&
        quadClass === 4 &&                   // Material Conflict only
        STRIKE_CAMEO_ROOTS.has(rootCode) &&  // Military action codes
        mentions >= MIN_MENTIONS &&          // Multi-source corroboration
        actor1.length > 0 &&                 // Require known actor
        !isNaN(lat) && !isNaN(lon)
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
    const meConflictRows = Array.from(dedupMap.values());

    console.log(`Filtered to ${meConflictRows.length} ME conflict events (after dedup)`);

    if (meConflictRows.length === 0) {
      return new Response(
        JSON.stringify({ fetched: rows.length, filtered: 0, inserted: 0, skipped_dedup: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Init Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // 6. Batch dedup check by source_url
    const sourceUrls = meConflictRows
      .map((r) => r[COL.SOURCE_URL])
      .filter(Boolean);

    // Check in batches of 100 (Supabase .in() limit)
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

    // 7. Build event objects
    const newEvents = [];
    let skippedDedup = 0;

    for (const row of meConflictRows) {
      const url = row[COL.SOURCE_URL] || "";
      if (url && existingUrls.has(url)) {
        skippedDedup++;
        continue;
      }

      const lat = parseFloat(row[COL.ACTION_GEO_LAT]);
      const lon = parseFloat(row[COL.ACTION_GEO_LONG]);
      const { category, color } = classify(row);

      // Parse SQLDATE: "20260302" -> "2026-03-02"
      const d = row[COL.SQLDATE] || "";
      const eventDate = d.length >= 8
        ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
        : new Date().toISOString().slice(0, 10);

      // Confidence from Goldstein scale magnitude and mention count
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
