exports.up = (pgm) => {
    pgm.createTable("seats", {
        id: {
            type: "uuid",
            primaryKey: true,
            default: pgm.func("gen_random_uuid()"),
        },
        event_id: {
            type: "uuid",
            notNull: true,
            references: "events",
            onDelete: "CASCADE",
        },
        seat_number: {
            type: "varchar(10)",
            notNull: true,
        },
        status: {
            type: "varchar(20)",
            notNull: true,
            default: "AVAILABLE",
            check: "status IN ('AVAILABLE', 'LOCKED', 'BOOKED')",
        },
        locked_by: {
            type: "uuid",
        },
        locked_until: {
            type: "timestamp",
        },
        created_at: {
            type: "timestamp",
            notNull: true,
            default: pgm.func("now()"),
        },
    });

    pgm.addConstraint("seats", "unique_seat_per_event", {
        unique: ["event_id", "seat_number"],
    });

    pgm.createIndex("seats", ["event_id", "status"]);
};

exports.down = (pgm) => {
    pgm.dropTable("seats");
};
