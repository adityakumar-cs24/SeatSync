exports.up = (pgm) => {
  // One row per webhook delivery that was processed. The primary key is what makes redelivery harmless.
  pgm.createTable('webhook_events', {
    event_id: { type: 'varchar(128)', primaryKey: true },
    event_type: { type: 'varchar(64)', notNull: true },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // A gateway payment can be attached to at most one booking.
  pgm.createIndex('bookings', 'payment_id', {
    unique: true,
    where: 'payment_id IS NOT NULL',
    name: 'idx_bookings_payment_id_unique',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('bookings', 'payment_id', { name: 'idx_bookings_payment_id_unique' });
  pgm.dropTable('webhook_events');
};
