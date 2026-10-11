exports.up = (pgm) => {
  pgm.addColumns('bookings', {
    payment_id: { type: 'varchar(100)' },
    failure_reason: { type: 'varchar(255)' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // At most one in-flight (PENDING) booking per seat: blocks double-click with different keys
  pgm.createIndex('bookings', 'seat_id', {
    unique: true,
    where: "status = 'PENDING'",
    name: 'idx_one_pending_booking_per_seat',
  });

  // "My bookings" lookups
  pgm.createIndex('bookings', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropIndex('bookings', 'user_id');
  pgm.dropIndex('bookings', 'seat_id', { name: 'idx_one_pending_booking_per_seat' });
  pgm.dropColumns('bookings', ['payment_id', 'failure_reason', 'updated_at']);
};