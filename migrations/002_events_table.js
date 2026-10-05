exports.up = (pgm) => {
    pgm.createTable("events", {
        id: {
            type: "uuid",
            primaryKey: true,
            default: pgm.func("gen_random_uuid()"),
        },
        name: {
            type: "varchar(255)",
            notNull: true,
        },
        venue: {
            type: "varchar(255)",
        },
        event_time: {
            type: "timestamp",
            notNull: true,
        },
        created_at: {
            type: "timestamp",
            notNull: true,
            default: pgm.func("now()"),
        },
    });
};

exports.down = (pgm) => {
    pgm.dropTable("events");
};
