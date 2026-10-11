exports.up = (pgm) => {
  pgm.createTable('refresh_tokens', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    family_id: { type: 'uuid', notNull: true },
    token_hash: { type: 'char(64)', notNull: true, unique: true },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('refresh_tokens', 'family_id');
  pgm.createIndex('refresh_tokens', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropTable('refresh_tokens');
};