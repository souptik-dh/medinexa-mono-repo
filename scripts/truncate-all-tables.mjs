import { createConnection } from 'mysql2/promise';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run with: node --env-file=.env scripts/truncate-all-tables.mjs -- --confirm');
  process.exit(1);
}

// Safety rail: this empties EVERY table in the target database. Requires an
// explicit --confirm flag so it can never fire by accident (e.g. a copy-pasted
// command, or muscle-memory from db:migrate).
if (!process.argv.includes('--confirm')) {
  console.error(
    'Refusing to run without --confirm.\n' +
      'This TRUNCATEs every table in the database this DATABASE_URL points to. This cannot be undone.\n' +
      'Re-run as: npm run db:truncate-all -- --confirm',
  );
  process.exit(1);
}

const conn = await createConnection({ uri: url, multipleStatements: true });
try {
  const [tables] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`,
  );

  if (tables.length === 0) {
    console.log('No tables found in this database.');
    process.exit(0);
  }

  console.log(`Truncating ${tables.length} table(s):\n`);

  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const { TABLE_NAME: name } of tables) {
    await conn.query(`TRUNCATE TABLE \`${name}\``);
    console.log(`  truncated ${name}`);
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  console.log('\nDone. Every table is now empty; schema/structure is untouched.');
} finally {
  await conn.end();
}
