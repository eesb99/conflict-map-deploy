-- OSINT Events table
CREATE TABLE IF NOT EXISTS osint_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lat DECIMAL(9,6) NOT NULL,
  lon DECIMAL(9,6) NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('us-israel','iran','lebanon-strike','hezbollah','other')),
  event_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  source_url TEXT,
  confidence DECIMAL(3,2) DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  color TEXT DEFAULT '#06b6d4',
  is_verified BOOLEAN DEFAULT FALSE,
  raw_response JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_events_geo ON osint_events(lat, lon);
CREATE INDEX IF NOT EXISTS idx_events_date ON osint_events(event_date);
CREATE INDEX IF NOT EXISTS idx_events_category ON osint_events(category);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE osint_events;
