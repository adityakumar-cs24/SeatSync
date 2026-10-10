exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE events
      ALTER COLUMN event_time TYPE timestamptz USING event_time AT TIME ZONE 'UTC',
      ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
    ALTER TABLE seats
      ALTER COLUMN locked_until TYPE timestamptz USING locked_until AT TIME ZONE 'UTC',
      ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
    ALTER TABLE bookings
      ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE events
      ALTER COLUMN event_time TYPE timestamp USING event_time AT TIME ZONE 'UTC',
      ALTER COLUMN created_at TYPE timestamp USING created_at AT TIME ZONE 'UTC';
    ALTER TABLE seats
      ALTER COLUMN locked_until TYPE timestamp USING locked_until AT TIME ZONE 'UTC',
      ALTER COLUMN created_at TYPE timestamp USING created_at AT TIME ZONE 'UTC';
    ALTER TABLE bookings
      ALTER COLUMN created_at TYPE timestamp USING created_at AT TIME ZONE 'UTC';
  `);
};