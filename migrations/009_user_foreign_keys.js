exports.up = (pgm) => {
  // Development data from before authentication existed used made-up user ids. It cannot satisfy
  // the new constraints, so it is cleaned up first. Do not run this blindly against real data.
  pgm.sql(`
    DELETE FROM bookings WHERE user_id NOT IN (SELECT id FROM users);

    UPDATE seats
    SET status = 'AVAILABLE', locked_by = NULL, locked_until = NULL
    WHERE locked_by IS NOT NULL AND locked_by NOT IN (SELECT id FROM users);
  `);

  pgm.addConstraint('seats', 'seats_locked_by_fkey', {
    foreignKeys: { columns: 'locked_by', references: 'users(id)' },
  });
  pgm.addConstraint('bookings', 'bookings_user_id_fkey', {
    foreignKeys: { columns: 'user_id', references: 'users(id)' },
  });
};

// Rolling back drops the constraints only; the cleaned-up rows are not restored.
exports.down = (pgm) => {
  pgm.dropConstraint('bookings', 'bookings_user_id_fkey');
  pgm.dropConstraint('seats', 'seats_locked_by_fkey');
};
