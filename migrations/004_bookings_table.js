exports.up = (pgm) => {
    pgm.createTable("bookings", {
        id: {
            type: "uuid",
            primaryKey: true,
            default: pgm.func("gen_random_uuid()"),
        },
        seat_id: {
            type: "uuid",
            notNull: true,
            references: "seats",
            onDelete: "CASCADE",
        },
        user_id: {
            type: "uuid",
            notNull: true,
        },
        status: {
            type: "varchar(20)",
            notNull: true,
            default: "PENDING",
            check: "status IN ('PENDING', 'CONFIRMED', 'FAILED')",
        },
        idempotency_key: {
            type: "varchar(255)",
            unique: true,
            notNull: true,
        },
        created_at: {
            type: "timestamp",
            notNull: true,
            default: pgm.func("now()"),
        },
    });

    pgm.createIndex("bookings", "seat_id", {
        unique: true,
        where: "status = 'CONFIRMED'",
        name: "idx_one_confirmed_booking_per_seat",
    });
};

exports.down = (pgm) => {
    pgm.dropTable("bookings");
};
