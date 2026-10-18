exports.up = (pgm) => {
  // The price lives on the event. The amount is copied onto each booking when it is created, so a
  // later price change can never alter what an existing booking is charged.
  pgm.addColumn('events', {
    price_paise: { type: 'integer', notNull: true, default: 10000, check: 'price_paise >= 100' },
  });

  pgm.addColumns('bookings', {
    amount_paise: { type: 'integer' },
    currency: { type: 'varchar(3)', notNull: true, default: 'INR' },
    gateway_order_id: { type: 'varchar(64)' },
    expires_at: { type: 'timestamptz' },
  });

  // One gateway order belongs to exactly one booking.
  pgm.addConstraint('bookings', 'bookings_gateway_order_id_key', { unique: ['gateway_order_id'] });
};

exports.down = (pgm) => {
  pgm.dropConstraint('bookings', 'bookings_gateway_order_id_key');
  pgm.dropColumns('bookings', ['amount_paise', 'currency', 'gateway_order_id', 'expires_at']);
  pgm.dropColumn('events', 'price_paise');
};
