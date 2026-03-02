-- Enable RLS on osint_events
ALTER TABLE osint_events ENABLE ROW LEVEL SECURITY;

-- Allow anonymous users to read events (for real-time subscription)
CREATE POLICY "Allow public read access" ON osint_events
  FOR SELECT USING (true);
